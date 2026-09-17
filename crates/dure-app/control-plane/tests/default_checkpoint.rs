#[path = "default_checkpoint/recovery_output.rs"]
mod recovery_output;
use recovery_output::{is_recovering_output, output_with_recovery};

#[path = "default_checkpoint/build_upgrade.rs"]
mod build_upgrade;
#[path = "default_checkpoint/replacement_failure.rs"]
mod replacement_failure;
#[path = "default_checkpoint/schedule_tests.rs"]
mod schedule_tests;

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt, symlink};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};

use dure_app::{
    AgentIdV1, AgentRecordV1, DomainStore, PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1,
    PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1, ProjectIdV1, ProjectRecordV1, ProviderIdV1,
    ProviderRuntimeIntegrationV1, ProviderRuntimeIntegrationsV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_control_plane::{
    ServeOptions, agent_conversation_api::AgentConversationRuntimeRegistry, control_plane_identity,
    prepare_with_agent_conversation_runtimes,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    schema_version: u16,
    backend_id: String,
    build_id: Option<String>,
    generation: String,
    socket_path: PathBuf,
    database_path: PathBuf,
    hmux_executable_path: Option<PathBuf>,
    hmux_runtime_executable_path: Option<PathBuf>,
    hmux_discovery_root: Option<PathBuf>,
    process_id: i32,
}

// These tests each exercise their own internal concurrency, but their process
// fixtures must not compete with one another for the production 2.5s Hmux deadline.
static PROCESS_FIXTURE_LOCK: Mutex<()> = Mutex::new(());

fn process_fixture_lock() -> MutexGuard<'static, ()> {
    PROCESS_FIXTURE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn start_backend_fixture(
    root: &Path,
    generation: &str,
    build_id: Option<&str>,
    capabilities: Vec<&str>,
    legacy_hmux: Option<&Path>,
) -> thread::JoinHandle<()> {
    start_backend_fixture_with_shutdown_fault(
        root,
        generation,
        build_id,
        capabilities,
        legacy_hmux,
        false,
    )
}

fn start_backend_fixture_with_shutdown_fault(
    root: &Path,
    generation: &str,
    build_id: Option<&str>,
    capabilities: Vec<&str>,
    legacy_hmux: Option<&Path>,
    drop_first_shutdown_response: bool,
) -> thread::JoinHandle<()> {
    let backend_root = root.join("backend");
    fs::create_dir(&backend_root).unwrap();
    fs::set_permissions(&backend_root, fs::Permissions::from_mode(0o700)).unwrap();
    let socket_path = backend_root.join("control-plane.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)).unwrap();
    let mut descriptor = json!({
        "schemaVersion": 1,
        "backendId": "dure-local",
        "generation": generation,
        "socketPath": socket_path,
        "databasePath": backend_root.join("application-state.sqlite3"),
        "processId": std::process::id(),
        "observedAtMs": 1
    });
    if let Some(build_id) = build_id {
        descriptor["buildId"] = Value::String(build_id.into());
    }
    if let Some(hmux) = legacy_hmux {
        descriptor["hmuxExecutablePath"] = Value::String(hmux.to_string_lossy().into_owned());
        descriptor["hmuxExecutableDevice"] = Value::String("1".into());
        descriptor["hmuxExecutableInode"] = Value::String("2".into());
        descriptor["hmuxExecutableSize"] = Value::String("3".into());
        descriptor["hmuxExecutableModified"] = Value::String("4:5".into());
        descriptor["hmuxExecutableSha256"] = Value::String("a".repeat(64));
        descriptor["hmuxDiscoveryRoot"] =
            Value::String(root.join("hmux-discovery").to_string_lossy().into_owned());
        descriptor["hmuxDiscoveryDevice"] = Value::String("6".into());
        descriptor["hmuxDiscoveryInode"] = Value::String("7".into());
    }
    write_owner_file(
        &backend_root.join("control-plane.json"),
        format!("{descriptor}\n").as_bytes(),
        false,
    );
    let generation = generation.to_string();
    let capabilities = capabilities
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    thread::spawn(move || {
        let mut dropped_shutdown = false;
        for accepted in listener.incoming() {
            let mut stream = accepted.unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let operation = request["operation"].as_str().unwrap();
            if operation == "backend.shutdown" && drop_first_shutdown_response && !dropped_shutdown
            {
                dropped_shutdown = true;
                continue;
            }
            let result = if operation == "backend.shutdown" {
                json!({ "schemaVersion": 1, "status": "stopping" })
            } else {
                assert_eq!(operation, "backend.ping");
                json!({ "schemaVersion": 1, "status": "ready" })
            };
            let response = json!({
                "schemaVersion": 1,
                "apiVersion": "dure.backend-transport/v1",
                "kind": "dure.backend.response",
                "requestId": request["requestId"],
                "backend": {
                    "id": "dure-local",
                    "generation": generation,
                    "protocol": { "major": 1, "minor": 0 },
                    "capabilities": capabilities,
                    "observedAtMs": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as i64
                },
                "result": result
            });
            stream
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .unwrap();
            if operation == "backend.shutdown" {
                break;
            }
        }
        drop(listener);
        fs::remove_file(socket_path).unwrap();
    })
}

fn start_old_backend(root: &Path, generation: &str, hmux: &Path) -> thread::JoinHandle<()> {
    start_backend_fixture(
        root,
        generation,
        None,
        vec![
            "agent_checkpoint.binding.ensure",
            "agent_checkpoint.read",
            "agent_checkpoint.write",
        ],
        Some(hmux),
    )
}

fn legacy_generation_socket_path(root: &Path, generation: &str) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(generation.as_bytes()));
    root.join("backend")
        .join(format!("cp.{}.sock", &digest[..32]))
}

fn start_schema_four_backend(
    root: &Path,
    generation: &str,
    build_id: &str,
    capabilities: Vec<&str>,
) -> thread::JoinHandle<()> {
    let backend_root = root.join("backend");
    fs::create_dir(&backend_root).unwrap();
    fs::set_permissions(&backend_root, fs::Permissions::from_mode(0o700)).unwrap();
    let socket_path = legacy_generation_socket_path(root, generation);
    let listener = UnixListener::bind(&socket_path).unwrap();
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)).unwrap();
    let executable_identity = |path: PathBuf, digest: char| {
        json!({
            "executablePath": path,
            "executableDevice": "1",
            "executableInode": "2",
            "executableSize": "3",
            "executableModified": "4:5",
            "executableSha256": digest.to_string().repeat(64)
        })
    };
    let control_plane_identity = executable_identity(root.join("previous-control-plane"), 'a');
    let hmux_identity = executable_identity(root.join("hmux"), 'b');
    let runtime_identity = executable_identity(root.join("hmux-runtime"), 'c');
    let descriptor = json!({
        "schemaVersion": 4,
        "backendId": "dure-local",
        "buildId": build_id,
        "generation": generation,
        "socketPath": socket_path,
        "databasePath": backend_root.join("application-state.sqlite3"),
        "controlPlaneIdentity": control_plane_identity,
        "hmuxExecutablePath": hmux_identity["executablePath"],
        "hmuxExecutableDevice": hmux_identity["executableDevice"],
        "hmuxExecutableInode": hmux_identity["executableInode"],
        "hmuxExecutableSize": hmux_identity["executableSize"],
        "hmuxExecutableModified": hmux_identity["executableModified"],
        "hmuxExecutableSha256": hmux_identity["executableSha256"],
        "hmuxRuntimeExecutablePath": runtime_identity["executablePath"],
        "hmuxRuntimeExecutableDevice": runtime_identity["executableDevice"],
        "hmuxRuntimeExecutableInode": runtime_identity["executableInode"],
        "hmuxRuntimeExecutableSize": runtime_identity["executableSize"],
        "hmuxRuntimeExecutableModified": runtime_identity["executableModified"],
        "hmuxRuntimeExecutableSha256": runtime_identity["executableSha256"],
        "hmuxDiscoveryRoot": root.join("hmux-discovery"),
        "hmuxDiscoveryDevice": "6",
        "hmuxDiscoveryInode": "7",
        "processId": std::process::id(),
        "observedAtMs": 1
    });
    write_owner_file(
        &backend_root.join("control-plane.json"),
        format!("{descriptor}\n").as_bytes(),
        false,
    );
    let generation = generation.to_string();
    let capabilities = capabilities
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    thread::spawn(move || {
        for accepted in listener.incoming() {
            let mut stream = accepted.unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let operation = request["operation"].as_str().unwrap();
            let result = match operation {
                "backend.ping" => json!({ "schemaVersion": 1, "status": "ready" }),
                "backend.shutdown" => json!({ "schemaVersion": 1, "status": "stopping" }),
                _ => panic!("unexpected fixture operation: {operation}"),
            };
            let response = json!({
                "schemaVersion": 1,
                "apiVersion": "dure.backend-transport/v1",
                "kind": "dure.backend.response",
                "requestId": request["requestId"],
                "backend": {
                    "id": "dure-local",
                    "generation": generation,
                    "protocol": { "major": 1, "minor": 0 },
                    "capabilities": capabilities,
                    "observedAtMs": 1
                },
                "result": result
            });
            stream
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .unwrap();
            if operation == "backend.shutdown" {
                break;
            }
        }
        drop(listener);
        fs::remove_file(socket_path).unwrap();
    })
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn repository_build_identity_manifest() -> Value {
    serde_json::from_slice(
        &fs::read(repository_root().join("cli/lib/control-plane-build-identity.json")).unwrap(),
    )
    .unwrap()
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

fn write_provider_runtime_integration_fixture(root: &Path) {
    let codex_notify = root.join("managed-codex-notify.sh");
    let claude_settings = root.join("managed-claude-settings.json");
    write_owner_file(&codex_notify, b"#!/bin/sh\nexit 0\n", true);
    write_owner_file(&claude_settings, b"{}\n", false);
    let document = ProviderRuntimeIntegrationsV1 {
        schema_version: PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1,
        channel: "stable".into(),
        integrations: BTreeMap::from([
            (
                ProviderIdV1::new("codex").unwrap(),
                ProviderRuntimeIntegrationV1::NotificationCommand {
                    command: vec![codex_notify.to_string_lossy().into_owned()],
                },
            ),
            (
                ProviderIdV1::new("claude").unwrap(),
                ProviderRuntimeIntegrationV1::SettingsFile {
                    path: claude_settings.to_string_lossy().into_owned(),
                },
            ),
        ]),
    };
    document.validate().unwrap();
    write_owner_file(
        &root.join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1),
        &serde_json::to_vec(&document).unwrap(),
        false,
    );
}

fn write_local_backend_profile(root: &Path, generation: &str, capabilities: &[&str]) {
    write_local_backend_profile_at(
        root,
        generation,
        capabilities,
        &root.join("backend/control-plane.sock"),
    );
}

fn write_local_backend_profile_at(
    root: &Path,
    generation: &str,
    capabilities: &[&str],
    socket_path: &Path,
) {
    write_owner_file(
        &root.join("backend-profiles.json"),
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "kind": "dure.backend_profiles",
                "profiles": [{
                    "id": "local",
                    "default": true,
                    "transport": {
                        "kind": "local",
                        "endpoint": {
                            "kind": "unix_socket",
                            "path": socket_path
                        }
                    },
                    "auth": { "kind": "peer" },
                    "trust": { "kind": "local_peer" },
                    "expected": {
                        "backendId": "dure-local",
                        "generation": generation,
                        "protocol": {
                            "minimum": { "major": 1, "minor": 0 },
                            "maximum": { "major": 1, "minor": 0 }
                        },
                        "capabilities": capabilities
                    },
                    "deadlineMs": 10_000
                }]
            })
        )
        .as_bytes(),
        false,
    );
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            copy_tree(&entry.path(), &target);
        } else if kind.is_file() {
            fs::copy(entry.path(), target).unwrap();
        } else {
            panic!("unsupported CLI fixture entry: {}", entry.path().display());
        }
    }
}

fn installed_cli(root: &Path) -> PathBuf {
    let install_root = root.join("installed-cli");
    let cli = install_root.join("dure");
    if cli.exists() {
        return cli;
    }
    fs::create_dir(&install_root).unwrap();
    fs::copy(repository_root().join("cli/dure.mjs"), &cli).unwrap();
    copy_tree(
        &repository_root().join("cli/lib"),
        &install_root.join("lib"),
    );
    let control_plane = install_root.join("dure-control-plane");
    fs::copy(env!("CARGO_BIN_EXE_dure-control-plane"), &control_plane).unwrap();
    fs::set_permissions(&control_plane, fs::Permissions::from_mode(0o700)).unwrap();
    cli
}

fn rewrite_cli_build_identity(
    cli: &Path,
    current_build_id: &str,
    previous_build_id: &str,
) -> Value {
    let path = cli
        .parent()
        .unwrap()
        .join("lib/control-plane-build-identity.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["currentBuildId"] = Value::String(current_build_id.into());
    manifest["previousBuildId"] = Value::String(previous_build_id.into());
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
    .unwrap();
    let mut identity = serde_json::to_value(control_plane_identity()).unwrap();
    identity["buildId"] = Value::String(current_build_id.into());
    identity
}

fn freeze_legacy_replacement_client(root: &Path, legacy_build_id: &str) -> PathBuf {
    let cli = installed_cli(root);
    let lib = cli.parent().unwrap().join("lib");
    let identity = rewrite_cli_build_identity(
        &cli,
        legacy_build_id,
        "dure-control-plane/v26-legacy-fixture",
    );

    let local_backend_path = lib.join("local-backend.mjs");
    let local_backend = fs::read_to_string(&local_backend_path).unwrap();
    let current_schema_guard = "![\n      1,\n      2,\n      GENERATION_SOCKET_DESCRIPTOR_SCHEMA_VERSION,\n      EXECUTABLE_IDENTITY_DESCRIPTOR_SCHEMA_VERSION,\n      CURRENT_DESCRIPTOR_SCHEMA_VERSION,\n    ].includes(value.schemaVersion)";
    assert!(local_backend.contains(current_schema_guard));
    let frozen = local_backend.replace(current_schema_guard, "value.schemaVersion !== 1");
    assert!(frozen.contains("value.schemaVersion !== 1"));
    fs::write(local_backend_path, frozen).unwrap();

    let wrapper = root.join("legacy-control-plane");
    write_owner_file(
        &wrapper,
        format!(
            "#!/bin/sh\nif [ \"$1\" = identity ]; then printf '%s\\n' '{}'; exit 0; fi\nexec '{}' \"$@\"\n",
            identity,
            env!("CARGO_BIN_EXE_dure-control-plane")
        )
        .as_bytes(),
        true,
    );
    wrapper
}

#[test]
fn cli_projection_loads_its_adjacent_build_identity_manifest() {
    let temporary = tempfile::Builder::new()
        .prefix("dure-cli-build-identity-projection-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let cli = installed_cli(root);
    let legacy_build_id = "dure-control-plane/v27-schedule-authority";
    rewrite_cli_build_identity(
        &cli,
        legacy_build_id,
        "dure-control-plane/v26-legacy-fixture",
    );

    let contract = cli.parent().unwrap().join("lib/control-plane-contract.mjs");
    let observed = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            "const contract = await import(process.argv[1]); process.stdout.write(contract.CONTROL_PLANE_BUILD_ID);",
        ])
        .arg(format!("file://{}", contract.display()))
        .output()
        .unwrap();

    assert!(
        observed.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&observed.stdout),
        String::from_utf8_lossy(&observed.stderr)
    );
    assert_eq!(String::from_utf8(observed.stdout).unwrap(), legacy_build_id);

    let manifest_path = cli
        .parent()
        .unwrap()
        .join("lib/control-plane-build-identity.json");
    let mut malformed: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    malformed["identity"]["apiVersion"] = Value::Number(1.into());
    fs::write(
        manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&malformed).unwrap()),
    )
    .unwrap();
    let rejected = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            "await import(process.argv[1]);",
        ])
        .arg(format!("file://{}", contract.display()))
        .output()
        .unwrap();
    assert!(!rejected.status.success());
}

#[test]
fn backend_reconcile_bootstraps_from_a_long_dure_home() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix(&"d".repeat(160))
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);

    let reconciled = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["backend", "reconcile", "--json"],
    ));
    assert!(
        reconciled.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&reconciled.stdout),
        String::from_utf8_lossy(&reconciled.stderr)
    );
    let receipt: Value = serde_json::from_slice(&reconciled.stdout).unwrap();
    let descriptor = read_descriptor(root);
    assert_eq!(receipt["kind"], "dure.backend.reconcile");
    assert_eq!(receipt["status"], "ready");
    assert_eq!(receipt["authority"]["generation"], descriptor.generation);
    assert_eq!(descriptor.schema_version, 5);
    assert_eq!(
        descriptor.database_path,
        root.join("backend/application-state.sqlite3")
    );
    assert!(descriptor.socket_path.as_os_str().as_bytes().len() < 100);
    assert_ne!(
        descriptor.socket_path.parent(),
        Some(root.join("backend").as_path())
    );
    assert!(backend_ping_available(&descriptor));
    stop_owned_service(root, &descriptor);
}

fn cli_command(root: &Path, hmux: &Path, arguments: &[&str]) -> Command {
    cli_command_with_discovery(root, hmux, &root.join("hmux-discovery"), arguments)
}

fn cli_command_with_discovery(
    root: &Path,
    hmux: &Path,
    discovery_root: &Path,
    arguments: &[&str],
) -> Command {
    fs::create_dir_all(discovery_root).unwrap();
    fs::set_permissions(discovery_root, fs::Permissions::from_mode(0o700)).unwrap();
    let mut command = Command::new("node");
    command
        .arg(installed_cli(root))
        .args(arguments)
        .current_dir(repository_root())
        .env("HOME", root)
        .env("DURE_HOME", root)
        .env("DURE_APP_CHANNEL", "stable")
        .env_remove("DURE_BACKEND_PROFILE")
        .env_remove("DURE_CONTROL_PLANE_BIN")
        .env("DURE_HMUX_BIN", hmux)
        .env("DURE_HMUX_RUNTIME_BIN", hmux)
        .env("HMUX_DISCOVERY_ROOT", discovery_root)
        .env_remove("HMUX_SESSION_ID")
        .env_remove("DURE_CHECKPOINT_BINDING_GENERATION");
    command
}

fn command(root: &Path, hmux: &Path, arguments: &[&str]) -> Output {
    cli_command(root, hmux, arguments).output().unwrap()
}

fn register_project_cli(
    root: &Path,
    hmux: &Path,
    project_id: &str,
    display_name: &str,
    project_root: Option<&str>,
) -> Output {
    let mut command = cli_command(
        root,
        hmux,
        &["projects", "register", project_id, "--name", display_name],
    );
    if let Some(project_root) = project_root {
        command.args(["--path", project_root]);
    }
    command.args(["--backend", "local", "--json"]);
    command.output().unwrap()
}

fn command_with_control_plane(
    root: &Path,
    hmux: &Path,
    control_plane: &Path,
    arguments: &[&str],
) -> Output {
    cli_command(root, hmux, arguments)
        .env("DURE_CONTROL_PLANE_BIN", control_plane)
        .output()
        .unwrap()
}

fn read_descriptor(root: &Path) -> Descriptor {
    serde_json::from_slice(&fs::read(root.join("backend/control-plane.json")).unwrap()).unwrap()
}

fn backend_request(
    root: &Path,
    descriptor: &Descriptor,
    operation: &str,
    required_capabilities: &[&str],
    body: Value,
) -> Value {
    assert!(root.join("backend/control-plane.json").starts_with(root));
    let mut stream = UnixStream::connect(&descriptor.socket_path).unwrap();
    stream
        .write_all(
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "apiVersion": "dure.backend-transport/v1",
                    "kind": "dure.backend.request",
                    "requestId": "fixture-shutdown",
                    "operation": operation,
                    "expected": {
                        "backendId": descriptor.backend_id.clone(),
                        "generation": descriptor.generation.clone(),
                        "protocol": {
                            "minimum": { "major": 1, "minor": 0 },
                            "maximum": { "major": 1, "minor": 0 }
                        },
                        "requiredCapabilities": required_capabilities
                    },
                    "body": body
                })
            )
            .as_bytes(),
        )
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    serde_json::from_str(&response).unwrap()
}

fn backend_ping_available(descriptor: &Descriptor) -> bool {
    let Ok(mut stream) = UnixStream::connect(&descriptor.socket_path) else {
        return false;
    };
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": "dure.backend-transport/v1",
        "kind": "dure.backend.request",
        "requestId": "upgrade-source-liveness",
        "operation": "backend.ping",
        "expected": {
            "backendId": descriptor.backend_id,
            "generation": descriptor.generation,
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "requiredCapabilities": []
        },
        "body": { "schemaVersion": 1 }
    });
    if stream.write_all(format!("{request}\n").as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if BufReader::new(stream).read_line(&mut response).is_err() {
        return false;
    }
    serde_json::from_str::<Value>(&response).is_ok_and(|response| {
        response["kind"] == "dure.backend.response"
            && response["backend"]["generation"] == descriptor.generation
            && response["result"]["status"] == "ready"
    })
}

fn backend_request_without_response(
    descriptor: &Descriptor,
    operation: &str,
    required_capabilities: &[&str],
    body: Value,
) {
    let mut stream = UnixStream::connect(&descriptor.socket_path).unwrap();
    stream
        .write_all(
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "apiVersion": "dure.backend-transport/v1",
                    "kind": "dure.backend.request",
                    "requestId": "fixture-response-loss",
                    "operation": operation,
                    "expected": {
                        "backendId": descriptor.backend_id.clone(),
                        "generation": descriptor.generation.clone(),
                        "protocol": {
                            "minimum": { "major": 1, "minor": 0 },
                            "maximum": { "major": 1, "minor": 0 }
                        },
                        "requiredCapabilities": required_capabilities
                    },
                    "body": body
                })
            )
            .as_bytes(),
        )
        .unwrap();
}

fn shutdown_body(descriptor: &Descriptor) -> Value {
    if descriptor.schema_version == 1 {
        return json!({ "schemaVersion": 1 });
    }
    json!({
        "schemaVersion": 2,
        "mode": "stop"
    })
}

fn replacement_target(root: &Path, build_id: &str, generation: &str) -> Value {
    json!({
        "generation": generation,
        "buildId": build_id,
        "controlPlaneIdentity": {
            "executablePath": root.join("dure-control-plane"),
            "executableDevice": "1",
            "executableInode": "2",
            "executableSize": "3",
            "executableModified": "4:5",
            "executableSha256": "a".repeat(64)
        },
        "hmuxIdentity": {
            "executablePath": root.join("hmux"),
            "executableDevice": "6",
            "executableInode": "7",
            "executableSize": "8",
            "executableModified": "9:10",
            "executableSha256": "b".repeat(64),
            "runtimeExecutablePath": root.join("hmux-runtime"),
            "runtimeExecutableDevice": "11",
            "runtimeExecutableInode": "12",
            "runtimeExecutableSize": "13",
            "runtimeExecutableModified": "14:15",
            "runtimeExecutableSha256": "c".repeat(64),
            "discoveryRoot": root.join("hmux-discovery"),
            "discoveryDevice": "16",
            "discoveryInode": "17"
        }
    })
}

fn descriptor_hmux_identity(descriptor: &Value) -> Value {
    json!({
        "executablePath": descriptor["hmuxExecutablePath"],
        "executableDevice": descriptor["hmuxExecutableDevice"],
        "executableInode": descriptor["hmuxExecutableInode"],
        "executableSize": descriptor["hmuxExecutableSize"],
        "executableModified": descriptor["hmuxExecutableModified"],
        "executableSha256": descriptor["hmuxExecutableSha256"],
        "runtimeExecutablePath": descriptor["hmuxRuntimeExecutablePath"],
        "runtimeExecutableDevice": descriptor["hmuxRuntimeExecutableDevice"],
        "runtimeExecutableInode": descriptor["hmuxRuntimeExecutableInode"],
        "runtimeExecutableSize": descriptor["hmuxRuntimeExecutableSize"],
        "runtimeExecutableModified": descriptor["hmuxRuntimeExecutableModified"],
        "runtimeExecutableSha256": descriptor["hmuxRuntimeExecutableSha256"],
        "discoveryRoot": descriptor["hmuxDiscoveryRoot"],
        "discoveryDevice": descriptor["hmuxDiscoveryDevice"],
        "discoveryInode": descriptor["hmuxDiscoveryInode"]
    })
}

fn wait_owned_service_exit(descriptor: &Descriptor) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let alive = unsafe { libc::kill(descriptor.process_id, 0) } == 0;
        if !alive {
            break;
        }
        assert!(Instant::now() < deadline, "fixture service did not exit");
        thread::sleep(Duration::from_millis(20));
    }
}

fn socket_hex(path: &Path) -> String {
    path.to_str()
        .unwrap()
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn locked_service_generations(root: &Path) -> Vec<String> {
    let mut locked = Vec::new();
    for entry in fs::read_dir(root.join("backend")).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(generation) = name
            .strip_prefix("service.")
            .and_then(|name| name.strip_suffix(".lock"))
        else {
            continue;
        };
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(entry.path())
            .unwrap();
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            unsafe {
                libc::flock(lock.as_raw_fd(), libc::LOCK_UN);
            }
            continue;
        }
        let error = std::io::Error::last_os_error();
        assert_eq!(error.kind(), ErrorKind::WouldBlock, "{name}: {error}");
        locked.push(generation.to_string());
    }
    locked.sort();
    locked
}

fn assert_service_locks_stably_released(root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut clear_since = None;
    loop {
        let locked = locked_service_generations(root);
        if locked.is_empty() {
            let since = *clear_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(250) {
                return;
            }
        } else {
            clear_since = None;
        }
        assert!(
            Instant::now() < deadline,
            "service locks remained held: {locked:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn stop_owned_service(root: &Path, descriptor: &Descriptor) {
    let response = backend_request(
        root,
        descriptor,
        "backend.shutdown",
        &[],
        shutdown_body(descriptor),
    );
    assert_eq!(response["result"]["status"], "stopping");
    wait_owned_service_exit(descriptor);
}

fn stop_owned_child(root: &Path, descriptor: &Descriptor, child: &mut Child) {
    let response = backend_request(
        root,
        descriptor,
        "backend.shutdown",
        &[],
        shutdown_body(descriptor),
    );
    assert_eq!(response["result"]["status"], "stopping");
    assert!(child.wait().unwrap().success());
}

fn owned_service_command(
    executable: &Path,
    root: &Path,
    hmux: &Path,
    generation: &str,
    activation_source_generation: Option<&str>,
    staged: bool,
) -> Command {
    let mut command = Command::new(executable);
    command
        .args(["serve", "--home"])
        .arg(root)
        .args(["--launch-executable", executable.to_str().unwrap()])
        .arg("--hmux-bin")
        .arg(hmux)
        .arg("--hmux-runtime-bin")
        .arg(hmux)
        .arg("--hmux-discovery-root")
        .arg(root.join("hmux-discovery"))
        .args(["--expected-generation", generation]);
    if let Some(source) = activation_source_generation {
        command.args(["--activation-source-generation", source]);
    }
    if staged {
        command.arg("--staged");
    }
    command
}

fn start_prepared_source_fixture(
    root: &Path,
    hmux: &Path,
    executable: &Path,
    generation: &str,
    ready: &Path,
    release: &Path,
    publishing: &Path,
) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "prepared_descriptor_source_fixture_process",
            "--nocapture",
        ])
        .env("DURE_PREPARED_SOURCE_HOME", root)
        .env("DURE_PREPARED_SOURCE_HMUX", hmux)
        .env("DURE_PREPARED_SOURCE_EXECUTABLE", executable)
        .env("DURE_PREPARED_SOURCE_GENERATION", generation)
        .env("DURE_PREPARED_SOURCE_READY", ready)
        .env("DURE_PREPARED_SOURCE_RELEASE", release)
        .env("DURE_PREPARED_SOURCE_PUBLISHING", publishing)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap()
}

fn wait_for_fixture_marker(path: &Path, child: &mut Child, marker: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if path.exists() {
            return;
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("prepared source exited before {marker}: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "prepared source did not reach {marker}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn prepared_descriptor_source_fixture_process() {
    let Some(home) = std::env::var_os("DURE_PREPARED_SOURCE_HOME") else {
        return;
    };
    let home = PathBuf::from(home);
    let hmux = PathBuf::from(std::env::var_os("DURE_PREPARED_SOURCE_HMUX").unwrap());
    let executable = PathBuf::from(std::env::var_os("DURE_PREPARED_SOURCE_EXECUTABLE").unwrap());
    let generation = std::env::var("DURE_PREPARED_SOURCE_GENERATION").unwrap();
    let ready = PathBuf::from(std::env::var_os("DURE_PREPARED_SOURCE_READY").unwrap());
    let release = PathBuf::from(std::env::var_os("DURE_PREPARED_SOURCE_RELEASE").unwrap());
    let publishing = PathBuf::from(std::env::var_os("DURE_PREPARED_SOURCE_PUBLISHING").unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let prepared = prepare_with_agent_conversation_runtimes(
            ServeOptions {
                home: home.clone(),
                hmux_bin: hmux.clone(),
                hmux_runtime_bin: hmux,
                hmux_discovery_root: home.join("hmux-discovery"),
                claude_structured_runtime: None,
                launch_executable: Some(executable),
                expected_generation: Some(generation),
                activation_source_generation: None,
                staged: false,
            },
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .await
        .unwrap();
        write_owner_file(&ready, b"ready\n", false);
        while !release.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        write_owner_file(&publishing, b"publishing\n", false);
        prepared.serve().await.unwrap();
    });
}

fn start_owned_service(root: &Path, hmux: &Path, generation: &str) -> Child {
    let preflight = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["preflight", "--home"])
        .arg(root)
        .arg("--hmux-bin")
        .arg(hmux)
        .arg("--hmux-runtime-bin")
        .arg(hmux)
        .arg("--hmux-discovery-root")
        .arg(root.join("hmux-discovery"))
        .output()
        .unwrap();
    assert!(
        preflight.status.success(),
        "fixture preflight failed: {}",
        String::from_utf8_lossy(&preflight.stderr)
    );
    let descriptor: Value =
        serde_json::from_slice(&fs::read(root.join("backend/control-plane.json")).unwrap())
            .unwrap();
    let preflight: Value = serde_json::from_slice(&preflight.stdout).unwrap();
    assert_eq!(
        descriptor["schemaVersion"],
        preflight["descriptorSchemaVersion"]
    );
    assert_eq!(descriptor["buildId"], preflight["buildId"]);
    assert_eq!(descriptor["generation"], generation);
    for (descriptor_field, identity_field) in [
        ("hmuxExecutablePath", "executablePath"),
        ("hmuxExecutableDevice", "executableDevice"),
        ("hmuxExecutableInode", "executableInode"),
        ("hmuxExecutableSize", "executableSize"),
        ("hmuxExecutableModified", "executableModified"),
        ("hmuxExecutableSha256", "executableSha256"),
        ("hmuxRuntimeExecutablePath", "runtimeExecutablePath"),
        ("hmuxRuntimeExecutableDevice", "runtimeExecutableDevice"),
        ("hmuxRuntimeExecutableInode", "runtimeExecutableInode"),
        ("hmuxRuntimeExecutableSize", "runtimeExecutableSize"),
        ("hmuxRuntimeExecutableModified", "runtimeExecutableModified"),
        ("hmuxRuntimeExecutableSha256", "runtimeExecutableSha256"),
        ("hmuxDiscoveryRoot", "discoveryRoot"),
        ("hmuxDiscoveryDevice", "discoveryDevice"),
        ("hmuxDiscoveryInode", "discoveryInode"),
    ] {
        assert_eq!(
            descriptor[descriptor_field], preflight["hmuxIdentity"][identity_field],
            "fixture restart changed {descriptor_field}"
        );
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(
            root.join("backend")
                .join(format!("service.{generation}.lock")),
        )
        .unwrap();
    let lock_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            unsafe {
                libc::flock(lock.as_raw_fd(), libc::LOCK_UN);
            }
            break;
        }
        assert!(
            Instant::now() < lock_deadline,
            "fixture service lock was not released"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let launch_executable = descriptor["controlPlaneIdentity"]["executablePath"]
        .as_str()
        .unwrap_or(env!("CARGO_BIN_EXE_dure-control-plane"));
    let mut command = owned_service_command(
        Path::new(launch_executable),
        root,
        hmux,
        generation,
        descriptor["activationSourceGeneration"].as_str(),
        false,
    );
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(source) = fs::read(root.join("backend/control-plane.json")) {
            if let Ok(descriptor) = serde_json::from_slice::<Descriptor>(&source) {
                if descriptor.process_id as u32 == child.id() {
                    break;
                }
            }
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("fixture service exited before ready: {status}");
        }
        assert!(Instant::now() < deadline, "fixture service did not start");
        thread::sleep(Duration::from_millis(20));
    }
    child
}

fn write_runtime_fixture(root: &Path, terminal_epoch: &str, health: &str) -> PathBuf {
    let hmux = root.join("hmux-fixture");
    let hmux_session = json!({
        "schema_version": 1,
        "session_id": "session-default-1",
        "workspace_id": "workspace-default-1",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "codex",
        "runner_principal": "local-user",
        "runner_instance": "runner-fixture",
        "channel_epoch": "1",
        "host_instance_id": "host-fixture",
        "terminal_epoch": terminal_epoch,
        "health": health,
    });
    write_owner_file(
        &hmux,
        format!("#!/bin/sh\nprintf '%s' '{}'\n", hmux_session).as_bytes(),
        true,
    );
    write_owner_file(
        &root.join("agents.json"),
        &serde_json::to_vec(&json!({
            "agents": [{
                "id": "agent-default-1",
                "name": "default-agent",
                "displayName": "Default Agent",
                "project": "Fixture",
                "sessionId": "session-default-1",
                "kind": "pty",
                "provider": "codex",
                "worktree": repository_root(),
                "branch": "fixture",
                "runtimeBinding": {
                    "schemaVersion": 1,
                    "runtime": "hmux_managed_v1",
                    "source": "local",
                    "hostId": "local",
                    "sessionId": "session-default-1",
                    "workspaceId": "workspace-default-1",
                    "createIdempotencyKey": "fixture-create-1",
                    "stopFence": {
                        "runnerPrincipal": "local-user",
                        "runnerInstance": "runner-fixture",
                        "channelEpoch": "1",
                        "hostInstanceId": "host-fixture",
                        "terminalEpoch": terminal_epoch
                    }
                }
            }]
        }))
        .unwrap(),
        false,
    );
    hmux
}

fn write_session_query_fixture(root: &Path) -> PathBuf {
    let hmux = root.join("hmux-sessions-fixture");
    let session = json!({
        "schema_version": 1,
        "session_id": "session-remote-1",
        "session_name": null,
        "workspace_id": "workspace-remote-1",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "codex",
        "runtime_host": null,
        "worktree_alias": null,
        "branch": "agent/remote",
        "launch_program": "codex",
        "runner_principal": "remote-runner",
        "runner_instance": "remote-runner-1",
        "channel_epoch": "4",
        "host_instance_id": "remote-host-1",
        "terminal_epoch": "remote-terminal-1",
        "output_seq": "8",
        "host_build_version": "0.1.0",
        "supported_protocol": {
            "minimum": { "major": 1, "minor": 0 },
            "maximum": { "major": 1, "minor": 0 }
        },
        "capabilities": [],
        "retirement_policy": null,
        "host_process": { "process_id": 301, "start_marker": "host-start-remote" },
        "provider_process": { "process_id": 302, "start_marker": "provider-start-remote" },
        "endpoint": { "kind": "unix_socket", "address": "/private/remote.sock" },
        "created_unix_ms": "1000",
        "lifecycle_changed_unix_ms": "2000",
        "exit": null,
        "manifestLifecycle": "ready",
        "effectiveLifecycle": "ready",
        "health": "healthy",
        "recoverability": "live_attach",
        "workingDirectory": {
            "terminal_epoch": "remote-terminal-1",
            "observed_through_output_seq": "7",
            "path": "/repo/remote",
            "source": "process_inspection"
        },
        "providerConversationIdentity": null,
        "recoveredPresentation": null
    });
    write_owner_file(
        &hmux,
        format!(
            "#!/bin/sh\ncase \" $* \" in\n  *\" session list \"*) printf '%s' '{}' ;;\n  *\" session show \"*) printf '%s' '{}' ;;\n  *\" read \"*) printf '%s' '{}' ;;\n  *) exit 64 ;;\nesac\n",
            json!({
                "schemaVersion": 1,
                "complete": true,
                "prioritizedItems": 0,
                "sessions": [session.clone()],
                "truncation": { "items": false, "omittedCount": 0 },
            }),
            session,
            json!({
                "ok": true,
                "sessionName": null,
                "sequenceThrough": "8",
                "lines": ["remote managed screen"],
            }),
        )
        .as_bytes(),
        true,
    );
    hmux
}

fn write_oversized_session_query_fixture(root: &Path) -> PathBuf {
    let bounded = write_session_query_fixture(root);
    let wrapper = root.join("hmux-oversized-sessions-fixture");
    write_owner_file(
        &wrapper,
        format!(
            "#!/bin/sh\nis_list=0\nhas_catalog_query=0\nfor argument in \"$@\"; do\n  [ \"$argument\" = list ] && is_list=1\n  [ \"$argument\" = --catalog-query-json ] && has_catalog_query=1\ndone\nif [ \"$is_list\" -eq 1 ] && [ \"$has_catalog_query\" -eq 0 ]; then\n  exec dd if=/dev/zero bs=1048577 count=1 2>/dev/null\nfi\nexec '{}' \"$@\"\n",
            bounded.display(),
        )
        .as_bytes(),
        true,
    );
    wrapper
}

fn project_catalog_fixture_repository(root: &Path) -> PathBuf {
    let fixture_project = root.join("fixture-project");
    fs::create_dir(&fixture_project).unwrap();
    for arguments in [
        vec!["init"],
        vec!["config", "user.email", "fixture@example.test"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["config", "core.hooksPath", "/dev/null"],
    ] {
        run_fixture_git(&fixture_project, &arguments);
    }
    fs::write(fixture_project.join("README.md"), "fixture\n").unwrap();
    run_fixture_git(&fixture_project, &["add", "README.md"]);
    run_fixture_git(&fixture_project, &["commit", "-m", "fixture"]);
    fixture_project.canonicalize().unwrap()
}

fn run_fixture_git(repository: &Path, arguments: &[&str]) {
    let mut command = Command::new("git");
    command.arg("-C").arg(repository).args(arguments);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        arguments,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn standalone_control_plane_serves_sessions_projects_and_spawn_plans_without_app_daemon() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-standalone-sessions-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    write_provider_runtime_integration_fixture(root);
    let hmux = write_session_query_fixture(root);
    let fixture_project = project_catalog_fixture_repository(root);
    assert!(!root.join("backend-projects.json").exists());

    let bootstrap = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        bootstrap.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&bootstrap.stdout),
        String::from_utf8_lossy(&bootstrap.stderr)
    );
    assert!(!root.join("server.json").exists());

    let register = register_project_cli(root, &hmux, "dure", "Dure", None);
    assert!(
        register.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&register.stdout),
        String::from_utf8_lossy(&register.stderr)
    );
    let registered: Value = serde_json::from_slice(&register.stdout).unwrap();
    assert_eq!(registered["kind"], "dure.projects.register");
    assert_eq!(registered["project"]["id"], "dure");
    assert!(
        !String::from_utf8_lossy(&register.stdout).contains(repository_root().to_str().unwrap())
    );
    let catalog_path = root.join("backend-projects.json");
    let catalog_source = fs::read(&catalog_path).unwrap();
    let catalog_metadata = fs::metadata(&catalog_path).unwrap();
    assert_eq!(catalog_metadata.mode() & 0o077, 0);
    assert_eq!(
        serde_json::from_slice::<Value>(&catalog_source).unwrap()["schemaVersion"],
        2
    );

    let replay = register_project_cli(root, &hmux, "dure", "Dure", None);
    assert!(replay.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&replay.stdout).unwrap()["project"],
        registered["project"]
    );
    assert_eq!(fs::read(&catalog_path).unwrap(), catalog_source);

    let fixture_register = register_project_cli(
        root,
        &hmux,
        "fixture",
        "Fixture",
        Some(fixture_project.to_str().unwrap()),
    );
    assert!(
        fixture_register.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&fixture_register.stdout),
        String::from_utf8_lossy(&fixture_register.stderr)
    );

    let response_loss_project = root.join("response-loss-project");
    fs::create_dir(&response_loss_project).unwrap();
    fs::create_dir(response_loss_project.join(".git")).unwrap();
    let response_loss_project = response_loss_project.canonicalize().unwrap();
    let response_loss_root = response_loss_project.to_string_lossy().into_owned();
    let descriptor = read_descriptor(root);
    let defaults_put = backend_request(
        root,
        &descriptor,
        "provider_launch_defaults.put",
        &["provider_launch_defaults.put"],
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "fixture-provider-defaults-1",
            "expectedRevision": 0,
            "defaults": {
                "claude": { "permissionMode": "bypass_approvals" },
                "codex": { "permissionMode": "bypass_approvals" }
            }
        }),
    );
    assert_eq!(defaults_put["kind"], "dure.backend.response");
    let defaults_document = defaults_put["result"]["receipt"]["document"].clone();
    assert_eq!(defaults_document["revision"], 1);
    assert!(
        defaults_document["fingerprint"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    let defaults_get = backend_request(
        root,
        &descriptor,
        "provider_launch_defaults.get",
        &["provider_launch_defaults.get"],
        json!({ "schemaVersion": 1 }),
    );
    assert_eq!(defaults_get["result"]["document"], defaults_document);

    let mut inherited_receipts = Vec::new();
    for provider_id in ["codex", "claude"] {
        let inherited = backend_request(
            root,
            &descriptor,
            "agent_spawn.preview",
            &["agent_spawn.preview.v2"],
            json!({
                "schemaVersion": 1,
                "idempotencyKey": format!("inherit-{provider_id}-1"),
                "projectId": "dure",
                "providerId": provider_id,
                "agentName": format!("{provider_id}-inherit"),
                "worktree": { "kind": "project_root" },
                "promptDigest": null
            }),
        );
        assert_eq!(
            inherited["kind"], "dure.backend.response",
            "provider={provider_id} response={inherited}"
        );
        let receipt = inherited["result"]["receipt"].clone();
        assert_eq!(
            receipt["plan"]["request"]["permissionMode"],
            "skip_permissions"
        );
        assert_eq!(
            receipt["plan"]["providerLaunchDefaults"]["revision"],
            defaults_document["revision"]
        );
        assert_eq!(
            receipt["plan"]["providerLaunchDefaults"]["fingerprint"],
            defaults_document["fingerprint"]
        );
        assert!(receipt["plan"]["providerLaunchDefaults"]["permissionOverride"].is_null());
        inherited_receipts.push(receipt);
    }
    assert_eq!(inherited_receipts.len(), 2);
    let explicit_require = backend_request(
        root,
        &descriptor,
        "agent_spawn.preview",
        &["agent_spawn.preview.v2"],
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "inherit-explicit-require-1",
            "projectId": "dure",
            "providerId": "codex",
            "agentName": "codex-explicit-require",
            "worktree": { "kind": "project_root" },
            "permissionOverride": "require_approvals",
            "promptDigest": null
        }),
    );
    assert_eq!(
        explicit_require["result"]["receipt"]["plan"]["request"]["permissionMode"],
        "default"
    );
    backend_request_without_response(
        &descriptor,
        "projects.register",
        &["projects.register"],
        json!({
            "schemaVersion": 1,
            "projectId": "response-loss",
            "displayName": "Response Loss",
            "root": response_loss_root,
        }),
    );
    let response_loss_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let observed = backend_request(
            root,
            &descriptor,
            "projects.show",
            &["projects.show"],
            json!({ "schemaVersion": 1, "projectId": "response-loss" }),
        );
        if observed["kind"] == "dure.backend.response" {
            break;
        }
        assert!(
            Instant::now() < response_loss_deadline,
            "response-loss registration was not published"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let response_loss_replay = register_project_cli(
        root,
        &hmux,
        "response-loss",
        "Response Loss",
        Some(&response_loss_root),
    );
    assert!(response_loss_replay.status.success());

    let race_a = root.join("race-a");
    let race_b = root.join("race-b");
    for repository in [&race_a, &race_b] {
        fs::create_dir(repository).unwrap();
        fs::create_dir(repository.join(".git")).unwrap();
    }
    let race_a = race_a.canonicalize().unwrap();
    let race_b = race_b.canonicalize().unwrap();
    let race_results = thread::scope(|scope| {
        let first = scope.spawn(|| {
            backend_request(
                root,
                &descriptor,
                "projects.register",
                &["projects.register"],
                json!({
                    "schemaVersion": 1,
                    "projectId": "raced",
                    "displayName": "Raced",
                    "root": race_a,
                }),
            )
        });
        let second = scope.spawn(|| {
            backend_request(
                root,
                &descriptor,
                "projects.register",
                &["projects.register"],
                json!({
                    "schemaVersion": 1,
                    "projectId": "raced",
                    "displayName": "Raced",
                    "root": race_b,
                }),
            )
        });
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert_eq!(
        race_results
            .iter()
            .filter(|response| response["kind"] == "dure.backend.response")
            .count(),
        1
    );
    assert_eq!(
        race_results
            .iter()
            .filter(|response| {
                response["error"]["code"] == "backend_project_registration_conflict"
            })
            .count(),
        1
    );

    let list = command(
        root,
        &hmux,
        &[
            "sessions",
            "list",
            "--backend",
            "local",
            "--deadline-ms",
            "10000",
            "--json",
        ],
    );
    assert!(
        list.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&list.stdout),
        String::from_utf8_lossy(&list.stderr)
    );
    let list_report: Value = serde_json::from_slice(&list.stdout).unwrap();
    assert_eq!(list_report["source"]["kind"], "backend_profile");
    assert_eq!(list_report["source"]["backend"]["id"], "dure-local");
    assert_eq!(list_report["sessions"][0]["sessionId"], "session-remote-1");
    assert_eq!(list_report["sessions"][0]["cwd"], "/repo/remote");

    let show = command(
        root,
        &hmux,
        &[
            "sessions",
            "show",
            "session-remote-1",
            "--backend",
            "local",
            "--workspace",
            "workspace-remote-1",
            "--deadline-ms",
            "10000",
            "--json",
        ],
    );
    assert!(
        show.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&show.stdout),
        String::from_utf8_lossy(&show.stderr)
    );
    let show_report: Value = serde_json::from_slice(&show.stdout).unwrap();
    assert_eq!(show_report["session"]["sessionId"], "session-remote-1");
    assert!(!root.join("server.json").exists());

    let read = command(
        root,
        &hmux,
        &[
            "read",
            "session-remote-1",
            "--workspace",
            "workspace-remote-1",
            "--backend",
            "local",
        ],
    );
    assert!(
        read.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&read.stdout),
        String::from_utf8_lossy(&read.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&read.stdout),
        "remote managed screen\n"
    );
    assert!(!root.join("server.json").exists());
    assert!(!root.join("agents.json").exists());

    let projects = command(
        root,
        &hmux,
        &["projects", "list", "--backend", "local", "--json"],
    );
    assert!(
        projects.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&projects.stdout),
        String::from_utf8_lossy(&projects.stderr)
    );
    let projects_report: Value = serde_json::from_slice(&projects.stdout).unwrap();
    assert_eq!(projects_report["source"]["appDaemonRequired"], false);
    assert_eq!(projects_report["projects"][0]["id"], "dure");
    assert!(
        projects_report["projects"][0]["rootId"]
            .as_str()
            .unwrap()
            .starts_with("root_")
    );
    assert!(
        !String::from_utf8_lossy(&projects.stdout).contains(repository_root().to_str().unwrap())
    );
    assert!(projects_report.get("panes").is_none());

    let second_client = cli_command(
        root,
        &hmux,
        &["projects", "show", "dure", "--backend", "local", "--json"],
    )
    .env("DURE_CLIENT_ID", "second-client")
    .output()
    .unwrap();
    assert!(second_client.status.success());
    let second_report: Value = serde_json::from_slice(&second_client.stdout).unwrap();
    assert_eq!(second_report["project"], projects_report["projects"][0]);
    assert!(second_report.get("client").is_none());

    let spawn = command(
        root,
        &hmux,
        &[
            "spawn",
            "preview",
            "--project",
            "dure",
            "--provider",
            "codex",
            "--name",
            "codex-1",
            "--idempotency-key",
            "spawn-request-1",
            "--no-worktree",
            "--prompt",
            "private prompt plaintext",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(
        spawn.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&spawn.stdout),
        String::from_utf8_lossy(&spawn.stderr)
    );
    let spawn_report: Value = serde_json::from_slice(&spawn.stdout).unwrap();
    let operation_id = spawn_report["receipt"]["operationId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(spawn_report["source"]["appDaemonRequired"], false);
    assert_eq!(spawn_report["receipt"]["state"], "applying");
    assert_eq!(
        spawn_report["receipt"]["plan"]["request"]["worktree"]["kind"],
        "project_root"
    );
    assert!(!String::from_utf8_lossy(&spawn.stdout).contains("private prompt plaintext"));

    let repository = repository_root();
    let path_selector = repository.to_str().unwrap();
    let spawn_by_path = command(
        root,
        &hmux,
        &[
            "spawn",
            "preview",
            "--path",
            path_selector,
            "--provider",
            "codex",
            "--name",
            "codex-path",
            "--idempotency-key",
            "spawn-path-request-1",
            "--no-worktree",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(
        spawn_by_path.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&spawn_by_path.stdout),
        String::from_utf8_lossy(&spawn_by_path.stderr)
    );
    let path_report: Value = serde_json::from_slice(&spawn_by_path.stdout).unwrap();
    assert_eq!(
        path_report["receipt"]["plan"]["authority"]["projectId"],
        "dure"
    );
    assert_eq!(
        path_report["receipt"]["plan"]["request"]["projectId"],
        "dure"
    );
    assert!(!String::from_utf8_lossy(&spawn_by_path.stdout).contains(path_selector));

    let path_replay_by_id = command(
        root,
        &hmux,
        &[
            "spawn",
            "preview",
            "--project",
            "dure",
            "--provider",
            "codex",
            "--name",
            "codex-path",
            "--idempotency-key",
            "spawn-path-request-1",
            "--no-worktree",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(path_replay_by_id.status.success());
    let path_replay_report: Value = serde_json::from_slice(&path_replay_by_id.stdout).unwrap();
    assert_eq!(path_replay_report["receipt"], path_report["receipt"]);

    let dedicated_request = json!({
        "schemaVersion": 1,
        "idempotencyKey": "spawn-dedicated-preview-1",
        "projectId": "fixture",
        "providerId": "codex",
        "agentName": "codex-dedicated",
        "worktree": {
            "kind": "dedicated",
            "branch": "agent/dedicated-preview"
        },
        "promptDigest": null
    });
    let dedicated_preview = backend_request(
        root,
        &descriptor,
        "agent_spawn.preview",
        &["agent_spawn.preview.v2"],
        dedicated_request.clone(),
    );
    assert_eq!(dedicated_preview["kind"], "dure.backend.response");
    let dedicated_receipt = dedicated_preview["result"]["receipt"].clone();
    let base_commit = dedicated_receipt["plan"]["request"]["worktree"]["base_commit_sha"]
        .as_str()
        .unwrap();
    assert_eq!(base_commit.len(), 40);
    assert!(base_commit.bytes().all(|byte| byte.is_ascii_hexdigit()));

    fs::write(fixture_project.join("after-preview.txt"), "new head\n").unwrap();
    run_fixture_git(&fixture_project, &["add", "after-preview.txt"]);
    run_fixture_git(&fixture_project, &["commit", "-m", "after preview"]);
    let dedicated_replay = backend_request(
        root,
        &descriptor,
        "agent_spawn.preview",
        &["agent_spawn.preview.v2"],
        dedicated_request,
    );
    assert_eq!(dedicated_replay["result"]["receipt"], dedicated_receipt);

    let replay = command(
        root,
        &hmux,
        &[
            "spawn",
            "preview",
            "--project",
            "dure",
            "--provider",
            "codex",
            "--name",
            "codex-1",
            "--idempotency-key",
            "spawn-request-1",
            "--no-worktree",
            "--prompt",
            "private prompt plaintext",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(replay.status.success());
    let replay_report: Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(replay_report["receipt"], spawn_report["receipt"]);

    let status = command(
        root,
        &hmux,
        &[
            "spawn",
            "status",
            "--operation-id",
            &operation_id,
            "--backend",
            "local",
            "--json",
        ],
    );
    assert!(status.status.success());
    let status_report: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status_report["receipt"], spawn_report["receipt"]);

    let conflict = command(
        root,
        &hmux,
        &[
            "spawn",
            "preview",
            "--project",
            "dure",
            "--provider",
            "codex",
            "--name",
            "codex-2",
            "--idempotency-key",
            "spawn-request-1",
            "--no-worktree",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert_eq!(conflict.status.code(), Some(2));
    let conflict_report: Value = serde_json::from_slice(&conflict.stdout).unwrap();
    assert_eq!(
        conflict_report["error"]["remoteCode"],
        "agent_spawn_idempotency_conflict"
    );

    let unavailable_provider = command(
        root,
        &hmux,
        &[
            "spawn",
            "preview",
            "--project",
            "dure",
            "--provider",
            "unknown-provider",
            "--name",
            "unknown-1",
            "--idempotency-key",
            "unavailable-provider-1",
            "--no-worktree",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert_eq!(unavailable_provider.status.code(), Some(2));
    let unavailable_report: Value = serde_json::from_slice(&unavailable_provider.stdout).unwrap();
    assert_eq!(
        unavailable_report["error"]["remoteCode"],
        "agent_spawn_provider_unavailable"
    );
    let uncatalogued_path = root.to_str().unwrap();
    let unavailable_project = command(
        root,
        &hmux,
        &[
            "spawn",
            "preview",
            "--path",
            uncatalogued_path,
            "--provider",
            "codex",
            "--name",
            "uncatalogued-1",
            "--idempotency-key",
            "uncatalogued-project-1",
            "--no-worktree",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert_eq!(unavailable_project.status.code(), Some(2));
    let unavailable_project_report: Value =
        serde_json::from_slice(&unavailable_project.stdout).unwrap();
    assert_eq!(
        unavailable_project_report["error"]["remoteCode"],
        "agent_spawn_project_not_found"
    );
    let absent = command(
        root,
        &hmux,
        &[
            "spawn",
            "status",
            "--idempotency-key",
            "unavailable-provider-1",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert_eq!(absent.status.code(), Some(1));
    let absent_report: Value = serde_json::from_slice(&absent.stdout).unwrap();
    assert_eq!(absent_report["found"], false);
    assert!(absent_report["receipt"].is_null());
    let absent_project = command(
        root,
        &hmux,
        &[
            "spawn",
            "status",
            "--idempotency-key",
            "uncatalogued-project-1",
            "--backend",
            "local",
            "--json",
        ],
    );
    assert_eq!(absent_project.status.code(), Some(1));
    let absent_project_report: Value = serde_json::from_slice(&absent_project.stdout).unwrap();
    assert_eq!(absent_project_report["found"], false);
    assert!(absent_project_report["receipt"].is_null());
    assert!(!root.join("server.json").exists());
    assert!(!root.join("agents.json").exists());

    let bounded_projects = backend_request(
        root,
        &descriptor,
        "projects.list",
        &["projects.list"],
        json!({ "schemaVersion": 1, "maxItems": 1 }),
    );
    assert_eq!(bounded_projects["result"]["complete"], false);
    assert_eq!(
        bounded_projects["result"]["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let invalid_projects = backend_request(
        root,
        &descriptor,
        "projects.list",
        &["projects.list"],
        json!({ "schemaVersion": 1, "maxItems": 0 }),
    );
    assert_eq!(
        invalid_projects["error"]["code"],
        "backend_projects_request_invalid"
    );
    let invalid_read = backend_request(
        root,
        &descriptor,
        "sessions.read",
        &["sessions.read"],
        json!({
            "schemaVersion": 1,
            "sessionId": "session-remote-1",
            "workspaceId": "workspace-remote-1",
            "lines": 0,
        }),
    );
    assert_eq!(invalid_read["error"]["code"], "dure_session_read_invalid");
    let catalog_before_invalid_registration = fs::read(&catalog_path).unwrap();
    let invalid_registration = backend_request(
        root,
        &descriptor,
        "projects.register",
        &["projects.register"],
        json!({
            "schemaVersion": 1,
            "projectId": "invalid",
            "displayName": "Invalid",
            "root": "relative/path",
        }),
    );
    assert_eq!(
        invalid_registration["error"]["code"],
        "backend_project_registration_invalid"
    );
    assert_eq!(
        fs::read(&catalog_path).unwrap(),
        catalog_before_invalid_registration
    );
    let invalid_spawn_path = backend_request(
        root,
        &descriptor,
        "agent_spawn.preview",
        &["agent_spawn.preview.v2"],
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "invalid-path-request-1",
            "projectPath": "relative/path",
            "providerId": "codex",
            "agentName": "invalid-path",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
        }),
    );
    assert_eq!(
        invalid_spawn_path["error"]["code"],
        "agent_spawn_request_invalid"
    );
    let ambiguous_spawn_selector = backend_request(
        root,
        &descriptor,
        "agent_spawn.preview",
        &["agent_spawn.preview.v2"],
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "ambiguous-selector-request-1",
            "projectId": "dure",
            "projectPath": repository,
            "providerId": "codex",
            "agentName": "ambiguous-selector",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
        }),
    );
    assert_eq!(
        ambiguous_spawn_selector["error"]["code"],
        "agent_spawn_request_invalid"
    );
    assert_client_view_transport(root, &descriptor);
    stop_owned_service(root, &descriptor);
}

#[test]
fn backend_session_list_uses_the_bounded_hmux_catalog_before_capture() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-bounded-session-catalog-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = write_oversized_session_query_fixture(root);

    let bootstrap = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        bootstrap.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&bootstrap.stdout),
        String::from_utf8_lossy(&bootstrap.stderr)
    );

    let descriptor = read_descriptor(root);
    let legacy_request = backend_request(
        root,
        &descriptor,
        "sessions.list",
        &["sessions.list"],
        json!({ "schemaVersion": 1, "probeBudgetMs": 1_000, "maxItems": 128 }),
    );
    assert_eq!(legacy_request["kind"], "dure.backend.response");
    assert_eq!(legacy_request["result"]["complete"], true);

    let listed = command(
        root,
        &hmux,
        &["sessions", "list", "--backend", "local", "--json"],
    );
    assert!(
        listed.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&listed.stdout),
        String::from_utf8_lossy(&listed.stderr)
    );
    let report: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(report["kind"], "dure.sessions.list");
    assert_eq!(report["complete"], true);
    assert_eq!(report["sessions"][0]["sessionId"], "session-remote-1");

    stop_owned_service(root, &descriptor);
}

fn assert_client_view_transport(root: &Path, descriptor: &Descriptor) {
    for (client_id, instance_id) in [
        ("desktop", "desktop-instance-1"),
        ("laptop", "laptop-instance-1"),
    ] {
        let response = backend_request(
            root,
            descriptor,
            "client_view.generation.advance",
            &["client_view.generation.advance"],
            json!({
                "schemaVersion": 1,
                "namespace": {
                    "tenantId": "tenant-1",
                    "userId": "user-1",
                    "clientId": client_id
                },
                "idempotencyKey": format!("initialize-{client_id}"),
                "expectedGeneration": 0,
                "expectedInstanceId": null,
                "nextInstanceId": instance_id
            }),
        );
        assert_eq!(response["kind"], "dure.backend.response");
        assert_eq!(
            response["result"]["receipt"]["authority"]["clientGeneration"],
            1
        );
    }

    let authority = backend_request(
        root,
        descriptor,
        "client_view.authority.read",
        &["client_view.authority.read"],
        json!({
            "schemaVersion": 1,
            "namespace": {
                "tenantId": "tenant-1",
                "userId": "user-1",
                "clientId": "desktop"
            }
        }),
    );
    assert_eq!(
        authority["result"]["authority"]["clientInstanceId"],
        "desktop-instance-1"
    );

    for (client_id, instance_id, session_id) in [
        ("desktop", "desktop-instance-1", "session-desktop"),
        ("laptop", "laptop-instance-1", "session-laptop"),
    ] {
        let response = backend_request(
            root,
            descriptor,
            "client_view.write",
            &["client_view.write"],
            json!({
                "schemaVersion": 1,
                "identity": {
                    "namespace": {
                        "tenantId": "tenant-1",
                        "userId": "user-1",
                        "clientId": client_id
                    },
                    "clientGeneration": 1,
                    "clientInstanceId": instance_id,
                    "viewId": "primary"
                },
                "idempotencyKey": format!("write-{client_id}-1"),
                "expectedRevision": 0,
                "presentation": {
                    "selectedSessionId": session_id,
                    "selectedSpaceId": format!("space-{client_id}"),
                    "selectedPaneId": format!("pane-{client_id}"),
                    "layout": [],
                    "viewports": [],
                    "filters": [],
                    "subscriptions": []
                }
            }),
        );
        assert_eq!(response["kind"], "dure.backend.response");
        assert_eq!(
            response["result"]["receipt"]["record"]["presentation"]["selectedSessionId"],
            session_id
        );
    }

    for (client_id, instance_id, session_id) in [
        ("desktop", "desktop-instance-1", "session-desktop"),
        ("laptop", "laptop-instance-1", "session-laptop"),
    ] {
        let response = backend_request(
            root,
            descriptor,
            "client_view.read",
            &["client_view.read"],
            json!({
                "schemaVersion": 1,
                "identity": {
                    "namespace": {
                        "tenantId": "tenant-1",
                        "userId": "user-1",
                        "clientId": client_id
                    },
                    "clientGeneration": 1,
                    "clientInstanceId": instance_id,
                    "viewId": "primary"
                }
            }),
        );
        assert_eq!(
            response["result"]["record"]["presentation"]["selectedSessionId"],
            session_id
        );
    }

    let conflict = backend_request(
        root,
        descriptor,
        "client_view.write",
        &["client_view.write"],
        json!({
            "schemaVersion": 1,
            "identity": {
                "namespace": {
                    "tenantId": "tenant-1",
                    "userId": "user-1",
                    "clientId": "desktop"
                },
                "clientGeneration": 1,
                "clientInstanceId": "desktop-instance-1",
                "viewId": "primary"
            },
            "idempotencyKey": "stale-desktop-write",
            "expectedRevision": 0,
            "presentation": {
                "selectedSessionId": "session-stale",
                "selectedSpaceId": null,
                "selectedPaneId": null,
                "layout": [],
                "viewports": [],
                "filters": [],
                "subscriptions": []
            }
        }),
    );
    assert_eq!(conflict["kind"], "dure.backend.error");
    assert_eq!(conflict["error"]["code"], "client_view_revision_conflict");
    assert_eq!(conflict["error"]["details"]["clientId"], "desktop");
    assert_eq!(conflict["error"]["details"]["viewId"], "primary");
    assert_eq!(conflict["error"]["details"]["expectedRevision"], 0);
    assert_eq!(conflict["error"]["details"]["actualRevision"], 1);
}

#[test]
fn binding_ensure_preserves_an_existing_agent_workspace_identity() {
    let _fixture = process_fixture_lock();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let temporary = tempfile::Builder::new()
        .prefix("dure-existing-agent-binding-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = write_runtime_fixture(root, "terminal-fixture", "healthy");
    let bootstrapped = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        bootstrapped.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&bootstrapped.stdout),
        String::from_utf8_lossy(&bootstrapped.stderr),
    );
    let descriptor = read_descriptor(root);
    let database = root.join("backend/application-state.sqlite3");
    let project_id = ProjectIdV1::new("project-existing").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-existing").unwrap();
    let agent_id = AgentIdV1::new("agent-default-1").unwrap();
    runtime.block_on(async {
        let store = SqliteDomainStore::open(&database).await.unwrap();
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: project_id.clone(),
                root_path: repository_root().to_string_lossy().into_owned(),
                display_name: "Existing project".into(),
                created_at_ms: 10,
                updated_at_ms: 10,
            })
            .await
            .unwrap();
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id: project_id.clone(),
                root_path: repository_root().to_string_lossy().into_owned(),
                base_commit_sha: None,
                created_at_ms: 20,
                updated_at_ms: 20,
            })
            .await
            .unwrap();
        store
            .upsert_agent(&AgentRecordV1 {
                agent_id: agent_id.clone(),
                workspace_id: workspace_id.clone(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                display_name: "Existing agent".into(),
                created_at_ms: 30,
                updated_at_ms: 30,
            })
            .await
            .unwrap();
        store.close().await;
    });

    let ensured = backend_request(
        root,
        &descriptor,
        "agent_checkpoint.binding.ensure",
        &["agent_checkpoint.binding.ensure"],
        json!({
            "schemaVersion": 1,
            "agentId": "agent-default-1",
            "sessionId": "session-default-1",
            "workspaceId": "workspace-default-1",
            "displayName": "Default Agent",
            "worktreePath": repository_root(),
            "stopFence": {
                "runnerPrincipal": "local-user",
                "runnerInstance": "runner-fixture",
                "channelEpoch": "1",
                "hostInstanceId": "host-fixture",
                "terminalEpoch": "terminal-fixture"
            }
        }),
    );
    assert_eq!(ensured["kind"], "dure.backend.response");
    stop_owned_service(root, &descriptor);
    runtime.block_on(async {
        let store = SqliteDomainStore::open(&database).await.unwrap();
        let agent = store.agent(&agent_id).await.unwrap().unwrap();
        let workspace = store.workspace(&agent.workspace_id).await.unwrap().unwrap();
        assert_eq!(agent.workspace_id, workspace_id);
        assert_eq!(workspace.project_id, project_id);
        store.close().await;
    });
}

#[test]
fn duplicate_bootstrap_converges_on_one_owner_only_service() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-duplicate-bootstrap-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("unused-hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    let first = cli_command(root, &hmux, &["profiles", "list", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let second = cli_command(root, &hmux, &["profiles", "list", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let first = first.wait_with_output().unwrap();
    let second = second.wait_with_output().unwrap();
    assert!(
        first.status.success() || is_recovering_output(&first),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(
        second.status.success() || is_recovering_output(&second),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&second.stdout),
        String::from_utf8_lossy(&second.stderr)
    );
    let settled = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        settled.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&settled.stdout),
        String::from_utf8_lossy(&settled.stderr)
    );
    let descriptor = read_descriptor(root);
    assert_eq!(descriptor.backend_id, "dure-local");
    assert!(root.join("backend-profiles.json").exists());
    assert_eq!(
        locked_service_generations(root),
        vec![descriptor.generation.clone()]
    );
    stop_owned_service(root, &descriptor);
    let pointer = fs::read(root.join("backend/control-plane.json")).unwrap();
    let mut stale_bootstrap = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["serve", "--home"])
        .arg(root)
        .arg("--hmux-bin")
        .arg(&hmux)
        .arg("--hmux-runtime-bin")
        .arg(&hmux)
        .arg("--hmux-discovery-root")
        .arg(root.join("hmux-discovery"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while stale_bootstrap.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            stale_bootstrap.kill().unwrap();
            stale_bootstrap.wait().unwrap();
            panic!("stale bootstrap did not reject the existing descriptor");
        }
        thread::sleep(Duration::from_millis(20));
    }
    let stale_bootstrap = stale_bootstrap.wait_with_output().unwrap();
    assert!(!stale_bootstrap.status.success());
    assert!(stale_bootstrap.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&stale_bootstrap.stderr)
            .contains("an existing control plane requires an expected generation")
    );
    assert_eq!(
        fs::read(root.join("backend/control-plane.json")).unwrap(),
        pointer
    );
    assert!(!backend_ping_available(&descriptor));
    assert_service_locks_stably_released(root);
}

struct InterruptedActivationReceiptFixture {
    temporary: tempfile::TempDir,
    hmux: PathBuf,
    wrapper: PathBuf,
    attempts: PathBuf,
    source: Descriptor,
    target: Descriptor,
    intent_path: PathBuf,
}

impl InterruptedActivationReceiptFixture {
    fn root(&self) -> &Path {
        self.temporary.path()
    }

    fn invoke(&self, arguments: &[&str]) -> Output {
        command_with_control_plane(self.root(), &self.hmux, &self.wrapper, arguments)
    }

    fn activation_attempts(&self) -> u32 {
        fs::read_to_string(&self.attempts)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
}

fn interrupted_activation_receipt_fixture(prefix: &str) -> InterruptedActivationReceiptFixture {
    let temporary = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    let boot = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(boot.status.success());
    let source = read_descriptor(root);

    let attempts = root.join("activation-attempts");
    let wrapper = root.join("activation-receipt-wrapper");
    write_owner_file(
        &wrapper,
        format!(
            "#!/bin/sh\nif [ \"$1\" = activate-staged ]; then\n  count=0\n  [ ! -e '{}' ] || count=$(cat '{}')\n  count=$((count + 1))\n  printf '%s\\n' \"$count\" > '{}'\n  '{}' \"$@\"\n  status=$?\n  [ \"$status\" -eq 0 ] || exit \"$status\"\n  [ \"$count\" -gt 1 ] || exit 72\n  exit 0\nfi\nexec '{}' \"$@\"\n",
            attempts.display(),
            attempts.display(),
            attempts.display(),
            env!("CARGO_BIN_EXE_dure-control-plane"),
            env!("CARGO_BIN_EXE_dure-control-plane")
        )
        .as_bytes(),
        true,
    );
    let interrupted =
        command_with_control_plane(root, &hmux, &wrapper, &["profiles", "list", "--json"]);
    assert!(is_recovering_output(&interrupted));
    let target = read_descriptor(root);
    let intent_path = root
        .join("backend/replacement-intents")
        .join(format!("{}.json", source.generation));

    InterruptedActivationReceiptFixture {
        temporary,
        hmux,
        wrapper,
        attempts,
        source,
        target,
        intent_path,
    }
}

#[test]
fn failed_activation_receipt_preserves_source_until_exact_confirmation() {
    let _fixture = process_fixture_lock();
    let fixture = interrupted_activation_receipt_fixture("dure-exact-activation-receipt-loss-");
    let root = fixture.root();
    assert_eq!(fixture.activation_attempts(), 1);
    assert_ne!(fixture.target.generation, fixture.source.generation);
    assert!(backend_ping_available(&fixture.source));
    assert!(backend_ping_available(&fixture.target));
    assert!(fixture.intent_path.exists());
    let catalog: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    assert_eq!(
        catalog["profiles"][0]["expected"]["generation"],
        fixture.source.generation
    );

    let resumed = fixture.invoke(&["profiles", "list", "--json"]);
    assert!(
        resumed.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&resumed.stdout),
        String::from_utf8_lossy(&resumed.stderr)
    );
    assert_eq!(fixture.activation_attempts(), 2);
    let catalog: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    assert_eq!(
        catalog["profiles"][0]["expected"]["generation"],
        fixture.target.generation
    );
    assert!(!fixture.intent_path.exists());
    assert!(!backend_ping_available(&fixture.source));
    assert!(backend_ping_available(&fixture.target));
    stop_owned_service(root, &fixture.target);
    assert_service_locks_stably_released(root);
}

#[test]
fn interrupted_activation_restarts_the_exact_stopped_target_before_confirmation() {
    let _fixture = process_fixture_lock();
    let fixture = interrupted_activation_receipt_fixture("dure-stopped-activation-target-");
    let root = fixture.root();
    let stopped_target_pid = fixture.target.process_id;
    assert_eq!(unsafe { libc::kill(stopped_target_pid, libc::SIGTERM) }, 0);
    wait_owned_service_exit(&fixture.target);
    assert!(backend_ping_available(&fixture.source));
    assert!(!backend_ping_available(&fixture.target));
    assert!(fixture.intent_path.exists());

    let resumed = fixture.invoke(&["profiles", "list", "--json"]);
    assert!(
        resumed.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&resumed.stdout),
        String::from_utf8_lossy(&resumed.stderr)
    );
    let restarted_target = read_descriptor(root);
    assert_eq!(restarted_target.generation, fixture.target.generation);
    assert_ne!(restarted_target.process_id, stopped_target_pid);
    assert_eq!(fixture.activation_attempts(), 2);
    assert!(!fixture.intent_path.exists());
    assert!(!backend_ping_available(&fixture.source));
    assert!(backend_ping_available(&restarted_target));
    let catalog: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    assert_eq!(
        catalog["profiles"][0]["expected"]["generation"],
        restarted_target.generation
    );
    stop_owned_service(root, &restarted_target);
    assert_service_locks_stably_released(root);
}

#[test]
fn verified_mislabeled_receipt_converges_without_descriptor_repair() {
    let _fixture = process_fixture_lock();
    let fixture = interrupted_activation_receipt_fixture("dure-mislabeled-activation-receipt-");
    let root = fixture.root();
    let descriptor_path = root.join("backend/control-plane.json");
    let target_bytes = fs::read(&descriptor_path).unwrap();
    let mut intent: Value =
        serde_json::from_slice(&fs::read(&fixture.intent_path).unwrap()).unwrap();
    intent["target"]["buildId"] =
        Value::String("dure-control-plane/v999-verified-observation-fixture".into());
    fs::write(&fixture.intent_path, format!("{intent}\n")).unwrap();

    let resumed = fixture.invoke(&["profiles", "list", "--json"]);
    assert!(
        resumed.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&resumed.stdout),
        String::from_utf8_lossy(&resumed.stderr)
    );
    assert_eq!(fixture.activation_attempts(), 2);
    assert_eq!(fs::read(&descriptor_path).unwrap(), target_bytes);
    assert!(!fixture.intent_path.exists());
    assert!(!backend_ping_available(&fixture.source));
    assert!(backend_ping_available(&fixture.target));

    let stable = fixture.invoke(&["projects", "list", "--backend", "local", "--json"]);
    let stable_report: Value = serde_json::from_slice(&stable.stdout).unwrap();
    assert!(
        stable.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&stable.stdout),
        String::from_utf8_lossy(&stable.stderr)
    );
    assert_eq!(stable_report["projects"], json!([]));
    assert_eq!(fixture.activation_attempts(), 2);
    assert_eq!(fs::read(&descriptor_path).unwrap(), target_bytes);
    stop_owned_service(root, &fixture.target);
    assert_service_locks_stably_released(root);
}

#[test]
fn descriptor_transition_lock_serializes_restart_and_activation_processes() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-descriptor-transition-race-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = write_runtime_fixture(root, "transition-race", "healthy");
    let executable = Path::new(env!("CARGO_BIN_EXE_dure-control-plane"));

    let boot = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        boot.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&boot.stdout),
        String::from_utf8_lossy(&boot.stderr)
    );
    let source = read_descriptor(root);
    let source_path = root.join("backend/control-plane.json");
    let source_bytes = fs::read(&source_path).unwrap();
    let source_value: Value = serde_json::from_slice(&source_bytes).unwrap();
    let source_executable = PathBuf::from(
        source_value["controlPlaneIdentity"]["executablePath"]
            .as_str()
            .unwrap(),
    );
    let intent_directory = root.join("backend/replacement-intents");
    fs::create_dir(&intent_directory).unwrap();
    fs::set_permissions(&intent_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let intent_path = intent_directory.join(format!("{}.json", source.generation));
    write_owner_file(&intent_path, b"{}\n", false);
    let target_generation = "local-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let candidate_path = root
        .join("backend")
        .join(format!("control-plane.{target_generation}.candidate.json"));
    let mut target_child = owned_service_command(
        executable,
        root,
        &hmux,
        target_generation,
        Some(&source.generation),
        true,
    )
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let (target, target_value, target_bytes) = loop {
        if let Ok(bytes) = fs::read(&candidate_path)
            && let Ok(descriptor) = serde_json::from_slice::<Descriptor>(&bytes)
            && descriptor.process_id as u32 == target_child.id()
            && backend_ping_available(&descriptor)
        {
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            break (descriptor, value, bytes);
        }
        if let Some(status) = target_child.try_wait().unwrap() {
            let mut stderr = String::new();
            target_child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut stderr)
                .unwrap();
            panic!("staged target exited before ready: {status}: {stderr}");
        }
        assert!(Instant::now() < deadline, "staged target did not start");
        thread::sleep(Duration::from_millis(20));
    };

    let intent_target = json!({
        "generation": target_value["generation"],
        "buildId": target_value["buildId"],
        "controlPlaneIdentity": target_value["controlPlaneIdentity"],
        "hmuxIdentity": descriptor_hmux_identity(&target_value)
    });
    fs::write(
        &intent_path,
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "kind": "dure.local_backend_replacement_intent",
                "source": {
                    "generation": source_value["generation"],
                    "buildId": source_value["buildId"],
                    "hmuxIdentity": descriptor_hmux_identity(&source_value)
                },
                "target": intent_target.clone(),
                "createdAtMs": 1
            })
        )
        .as_bytes(),
    )
    .unwrap();
    stop_owned_service(root, &source);

    let first_ready = root.join("source-publish.ready");
    let first_release = root.join("source-publish.release");
    let first_publishing = root.join("source-publish.entered");
    let mut publishing_source = start_prepared_source_fixture(
        root,
        &hmux,
        &source_executable,
        &source.generation,
        &first_ready,
        &first_release,
        &first_publishing,
    );
    wait_for_fixture_marker(&first_ready, &mut publishing_source, "preparation");
    let transition_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("backend/descriptor.transition.lock"))
        .unwrap();
    assert_eq!(
        unsafe { libc::flock(transition_lock.as_raw_fd(), libc::LOCK_EX) },
        0
    );
    write_owner_file(&first_release, b"release\n", false);
    wait_for_fixture_marker(
        &first_publishing,
        &mut publishing_source,
        "descriptor publication",
    );
    let blocked_until = Instant::now() + Duration::from_millis(250);
    while Instant::now() < blocked_until {
        assert!(publishing_source.try_wait().unwrap().is_none());
        assert_eq!(fs::read(&source_path).unwrap(), source_bytes);
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        unsafe { libc::flock(transition_lock.as_raw_fd(), libc::LOCK_UN) },
        0
    );
    drop(transition_lock);
    let published_deadline = Instant::now() + Duration::from_secs(10);
    let published_source = loop {
        let descriptor = read_descriptor(root);
        if descriptor.process_id as u32 == publishing_source.id()
            && backend_ping_available(&descriptor)
        {
            break descriptor;
        }
        if let Some(status) = publishing_source.try_wait().unwrap() {
            panic!("source publisher exited before serving: {status}");
        }
        assert!(
            Instant::now() < published_deadline,
            "source publisher did not become ready"
        );
        thread::sleep(Duration::from_millis(20));
    };
    stop_owned_child(root, &published_source, &mut publishing_source);
    let published_source_bytes = fs::read(&source_path).unwrap();

    let stale_ready = root.join("stale-source.ready");
    let stale_release = root.join("stale-source.release");
    let stale_publishing = root.join("stale-source.entered");
    let mut stale_source = start_prepared_source_fixture(
        root,
        &hmux,
        &source_executable,
        &source.generation,
        &stale_ready,
        &stale_release,
        &stale_publishing,
    );
    wait_for_fixture_marker(&stale_ready, &mut stale_source, "preparation");
    assert_eq!(fs::read(&source_path).unwrap(), published_source_bytes);
    let mut expected_locks = vec![source.generation.clone(), target.generation.clone()];
    expected_locks.sort();
    assert_eq!(locked_service_generations(root), expected_locks);

    let transition_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("backend/descriptor.transition.lock"))
        .unwrap();
    assert_eq!(
        unsafe { libc::flock(transition_lock.as_raw_fd(), libc::LOCK_EX) },
        0
    );
    let mut activation = Command::new(executable)
        .args(["activate-staged", "--home"])
        .arg(root)
        .args(["--source-generation", source.generation.as_str()])
        .args(["--target-generation", target_generation])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let blocked_until = Instant::now() + Duration::from_millis(250);
    while Instant::now() < blocked_until {
        assert!(activation.try_wait().unwrap().is_none());
        assert_eq!(fs::read(&source_path).unwrap(), published_source_bytes);
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        unsafe { libc::flock(transition_lock.as_raw_fd(), libc::LOCK_UN) },
        0
    );
    drop(transition_lock);
    let activation = activation.wait_with_output().unwrap();
    assert!(
        activation.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&activation.stdout),
        String::from_utf8_lossy(&activation.stderr)
    );
    assert_eq!(fs::read(&source_path).unwrap(), target_bytes);
    assert!(!candidate_path.exists());

    write_owner_file(&stale_release, b"release\n", false);
    wait_for_fixture_marker(
        &stale_publishing,
        &mut stale_source,
        "stale descriptor publication",
    );
    let stale_deadline = Instant::now() + Duration::from_secs(3);
    let stale_status = loop {
        if let Some(status) = stale_source.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= stale_deadline {
            stale_source.kill().unwrap();
            let _ = stale_source.wait();
            panic!("stale source did not exit after losing descriptor publication");
        }
        thread::sleep(Duration::from_millis(20));
    };
    assert!(!stale_status.success());
    let cleanup_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let locked = locked_service_generations(root);
        if locked == vec![target.generation.clone()] && !source.socket_path.exists() {
            break;
        }
        assert!(
            Instant::now() < cleanup_deadline,
            "stale source runtime was not released: {locked:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }

    let confirmation = Command::new(executable)
        .args(["activate-staged", "--home"])
        .arg(root)
        .args(["--source-generation", source.generation.as_str()])
        .args(["--target-generation", target_generation])
        .output()
        .unwrap();
    assert!(
        confirmation.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&confirmation.stdout),
        String::from_utf8_lossy(&confirmation.stderr)
    );
    assert!(backend_ping_available(&target));
    fs::remove_file(&intent_path).unwrap();
    stop_owned_child(root, &target, &mut target_child);
    assert_service_locks_stably_released(root);
}

#[test]
fn a_second_client_replaces_an_ambient_discovery_root_once() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-discovery-root-takeover-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = write_runtime_fixture(root, "terminal-fixture", "healthy");
    let qa_root = root.join("qa-discovery");
    let user_root = root.join("user-discovery");

    let first = output_with_recovery(&mut cli_command_with_discovery(
        root,
        &hmux,
        &qa_root,
        &["profiles", "list", "--json"],
    ));
    assert!(
        first.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    let qa_descriptor = read_descriptor(root);
    assert_eq!(
        qa_descriptor.hmux_discovery_root.as_deref(),
        Some(qa_root.canonicalize().unwrap().as_path())
    );
    assert_eq!(
        qa_descriptor.hmux_executable_path.as_deref(),
        Some(hmux.canonicalize().unwrap().as_path())
    );
    assert_eq!(
        qa_descriptor.hmux_runtime_executable_path.as_deref(),
        Some(hmux.canonicalize().unwrap().as_path())
    );

    let second = output_with_recovery(&mut cli_command_with_discovery(
        root,
        &hmux,
        &user_root,
        &["profiles", "list", "--json"],
    ));
    assert!(
        second.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&second.stdout),
        String::from_utf8_lossy(&second.stderr)
    );
    let user_descriptor = read_descriptor(root);
    assert_ne!(user_descriptor.generation, qa_descriptor.generation);
    assert_ne!(user_descriptor.process_id, qa_descriptor.process_id);
    assert_eq!(
        user_descriptor.hmux_discovery_root.as_deref(),
        Some(user_root.canonicalize().unwrap().as_path())
    );

    let user_hmux = root.join("hmux-user-fixture");
    fs::copy(&hmux, &user_hmux).unwrap();
    fs::set_permissions(&user_hmux, fs::Permissions::from_mode(0o700)).unwrap();
    let byte_identical_reuse = output_with_recovery(&mut cli_command_with_discovery(
        root,
        &user_hmux,
        &user_root,
        &["profiles", "list", "--json"],
    ));
    assert!(
        byte_identical_reuse.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&byte_identical_reuse.stdout),
        String::from_utf8_lossy(&byte_identical_reuse.stderr)
    );
    let reused_descriptor = read_descriptor(root);
    assert_eq!(reused_descriptor.process_id, user_descriptor.process_id);
    assert_eq!(reused_descriptor.generation, user_descriptor.generation);
    assert_eq!(
        reused_descriptor.hmux_executable_path.as_deref(),
        Some(hmux.canonicalize().unwrap().as_path())
    );

    let repeated = cli_command_with_discovery(
        root,
        &user_hmux,
        &user_root,
        &["profiles", "list", "--json"],
    )
    .output()
    .unwrap();
    assert!(repeated.status.success());
    let repeated_descriptor = read_descriptor(root);
    assert_eq!(repeated_descriptor.process_id, reused_descriptor.process_id);
    assert_eq!(repeated_descriptor.generation, reused_descriptor.generation);
    stop_owned_service(root, &repeated_descriptor);
}

#[test]
fn slow_clients_are_bounded_without_shedding_accepted_connections() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-slow-client-bound-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("unused-hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    let started = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(started.status.success());
    let descriptor = read_descriptor(root);

    let clients = (0..80)
        .map(|_| UnixStream::connect(&descriptor.socket_path).unwrap())
        .collect::<Vec<_>>();
    thread::sleep(Duration::from_millis(200));

    // The next valid request must remain queued until a slow client's bounded
    // read expires. Accepting it and closing it without a frame turns ordinary
    // startup fanout into a client-visible transport failure.
    let ping = backend_request(
        root,
        &descriptor,
        "backend.ping",
        &[],
        json!({ "schemaVersion": 1 }),
    );
    assert_eq!(ping["result"]["status"], "ready");
    drop(clients);
    stop_owned_service(root, &descriptor);
}

#[test]
fn persistent_observers_leave_capacity_for_framed_requests() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-persistent-observer-capacity-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("unused-hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    let started = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(started.status.success());
    let descriptor = read_descriptor(root);

    let mut observers = (0..64)
        .map(|index| {
            let mut connection =
                BufReader::new(UnixStream::connect(&descriptor.socket_path).unwrap());
            let request = json!({
                "schemaVersion": 1,
                "apiVersion": "dure.backend-transport/v1",
                "kind": "dure.backend.request",
                "requestId": format!("persistent-observer-{index}"),
                "operation": "backend.ping",
                "expected": {
                    "backendId": descriptor.backend_id,
                    "generation": descriptor.generation,
                    "protocol": {
                        "minimum": { "major": 1, "minor": 0 },
                        "maximum": { "major": 1, "minor": 0 }
                    },
                    "requiredCapabilities": ["backend.connection.persistent"]
                },
                "body": { "schemaVersion": 1 },
                "connection": { "mode": "persistent_v1" }
            });
            connection
                .get_mut()
                .write_all(format!("{request}\n").as_bytes())
                .unwrap();
            let mut response = String::new();
            connection.read_line(&mut response).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["result"]["status"],
                "ready"
            );
            connection
        })
        .collect::<Vec<_>>();

    let request_root = root.to_path_buf();
    let request_descriptor = descriptor.clone();
    let (response_tx, response_rx) = std::sync::mpsc::channel();
    let request = thread::spawn(move || {
        let response = backend_request(
            &request_root,
            &request_descriptor,
            "backend.ping",
            &[],
            json!({ "schemaVersion": 1 }),
        );
        response_tx.send(response).unwrap();
    });
    let timely_response = response_rx.recv_timeout(Duration::from_secs(2));
    let (was_timely, response) = match timely_response {
        Ok(response) => (true, response),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            drop(observers.pop());
            (
                false,
                response_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            )
        }
        Err(error) => panic!("framed request worker failed: {error}"),
    };
    request.join().unwrap();
    assert_eq!(response["result"]["status"], "ready");
    stop_owned_service(root, &descriptor);
    assert!(
        was_timely,
        "persistent observers starved an ordinary framed request"
    );
}

#[test]
fn persistent_framing_and_stdio_gateway_reuse_one_fenced_backend() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-persistent-framing-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("unused-hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    let started = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(started.status.success());
    let descriptor = read_descriptor(root);

    let mut connection = BufReader::new(UnixStream::connect(&descriptor.socket_path).unwrap());
    for request_id in ["persistent-ping-1", "persistent-ping-2"] {
        let request = json!({
            "schemaVersion": 1,
            "apiVersion": "dure.backend-transport/v1",
            "kind": "dure.backend.request",
            "requestId": request_id,
            "operation": "backend.ping",
            "expected": {
                "backendId": descriptor.backend_id,
                "generation": descriptor.generation,
                "protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "requiredCapabilities": ["backend.connection.persistent"]
            },
            "body": { "schemaVersion": 1 },
            "connection": { "mode": "persistent_v1" }
        });
        connection
            .get_mut()
            .write_all(format!("{request}\n").as_bytes())
            .unwrap();
        let mut response = String::new();
        connection.read_line(&mut response).unwrap();
        assert!(response.ends_with('\n'));
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["requestId"], request_id);
        assert_eq!(response["result"]["status"], "ready");
    }
    drop(connection);

    let one_shot = backend_request(
        root,
        &descriptor,
        "backend.ping",
        &[],
        json!({ "schemaVersion": 1 }),
    );
    assert_eq!(one_shot["result"]["status"], "ready");

    let encoded_socket = socket_hex(&descriptor.socket_path);

    let mut gateway = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["gateway", "--socket-hex", &encoded_socket])
        .args(["--expected-generation", &descriptor.generation])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut gateway_input = gateway.stdin.take().unwrap();
    let mut gateway_output = BufReader::new(gateway.stdout.take().unwrap());
    for request_id in ["gateway-ping-1", "gateway-ping-2"] {
        let request = json!({
            "schemaVersion": 1,
            "apiVersion": "dure.backend-transport/v1",
            "kind": "dure.backend.request",
            "requestId": request_id,
            "operation": "backend.ping",
            "expected": {
                "backendId": descriptor.backend_id,
                "generation": descriptor.generation,
                "protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "requiredCapabilities": ["backend.connection.persistent"]
            },
            "body": { "schemaVersion": 1 },
            "connection": { "mode": "persistent_v1" }
        });
        gateway_input
            .write_all(format!("{request}\n").as_bytes())
            .unwrap();
        gateway_input.flush().unwrap();
        let mut response = String::new();
        gateway_output.read_line(&mut response).unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["requestId"], request_id);
        assert_eq!(response["result"]["status"], "ready");
    }
    drop(gateway_input);
    assert!(gateway.wait().unwrap().success());
    let mut gateway_error = String::new();
    gateway
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut gateway_error)
        .unwrap();
    assert!(gateway_error.is_empty());

    let wrong_generation = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["gateway", "--socket-hex", &encoded_socket])
        .args(["--expected-generation", "local-v1-other-generation"])
        .output()
        .unwrap();
    assert!(!wrong_generation.status.success());
    assert!(wrong_generation.stdout.is_empty());
    let wrong_generation_error = String::from_utf8_lossy(&wrong_generation.stderr);
    assert!(
        wrong_generation_error.contains("gateway backend generation does not match"),
        "unexpected gateway error: {wrong_generation_error}"
    );

    let rejected = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["gateway", "--socket-hex", &encoded_socket])
        .args(["--expected-generation", "invalid/generation"])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
    let rejected_error = String::from_utf8_lossy(&rejected.stderr);
    assert!(
        rejected_error.contains("gateway endpoint identity is invalid"),
        "unexpected gateway error: {rejected_error}"
    );

    fs::set_permissions(&descriptor.socket_path, fs::Permissions::from_mode(0o666)).unwrap();
    let unsafe_socket = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["gateway", "--socket-hex", &encoded_socket])
        .args(["--expected-generation", &descriptor.generation])
        .output()
        .unwrap();
    assert!(!unsafe_socket.status.success());
    assert!(unsafe_socket.stdout.is_empty());
    assert!(String::from_utf8_lossy(&unsafe_socket.stderr).contains("owner-only"));
    fs::set_permissions(&descriptor.socket_path, fs::Permissions::from_mode(0o600)).unwrap();

    let backend_directory = descriptor.socket_path.parent().unwrap();
    fs::set_permissions(backend_directory, fs::Permissions::from_mode(0o777)).unwrap();
    let unsafe_directory = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["gateway", "--socket-hex", &encoded_socket])
        .args(["--expected-generation", &descriptor.generation])
        .output()
        .unwrap();
    assert!(!unsafe_directory.status.success());
    assert!(unsafe_directory.stdout.is_empty());
    assert!(String::from_utf8_lossy(&unsafe_directory.stderr).contains("owner-only"));
    fs::set_permissions(backend_directory, fs::Permissions::from_mode(0o700)).unwrap();
    stop_owned_service(root, &descriptor);
}

#[test]
fn bootstrap_rejects_symlinked_descriptor_and_lock() {
    let _fixture = process_fixture_lock();
    let descriptor_fixture = tempfile::Builder::new()
        .prefix("dure-descriptor-symlink-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(descriptor_fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let descriptor_root = descriptor_fixture.path();
    fs::create_dir(descriptor_root.join("backend")).unwrap();
    fs::set_permissions(
        descriptor_root.join("backend"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let descriptor_target = descriptor_root.join("descriptor-target");
    write_owner_file(&descriptor_target, b"{}\n", false);
    symlink(
        &descriptor_target,
        descriptor_root.join("backend/control-plane.json"),
    )
    .unwrap();
    let descriptor_rejected = command(
        descriptor_root,
        &descriptor_root.join("unused-hmux"),
        &["profiles", "list", "--json"],
    );
    assert_eq!(descriptor_rejected.status.code(), Some(2));
    let descriptor_report: Value = serde_json::from_slice(&descriptor_rejected.stdout).unwrap();
    assert_eq!(
        descriptor_report["error"]["code"],
        "local_backend_descriptor_unavailable"
    );

    let lock_fixture = tempfile::Builder::new()
        .prefix("dure-lock-symlink-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(lock_fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let lock_root = lock_fixture.path();
    fs::create_dir(lock_root.join("backend")).unwrap();
    fs::set_permissions(lock_root.join("backend"), fs::Permissions::from_mode(0o700)).unwrap();
    let lock_target = lock_root.join("lock-target");
    write_owner_file(&lock_target, b"unchanged", false);
    let locked_generation = "local-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    symlink(
        &lock_target,
        lock_root
            .join("backend")
            .join(format!("service.{locked_generation}.lock")),
    )
    .unwrap();
    let lock_hmux = lock_root.join("hmux-fixture");
    write_owner_file(&lock_hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(lock_root.join("hmux-discovery")).unwrap();
    let service = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["serve", "--home"])
        .arg(lock_root)
        .arg("--hmux-bin")
        .arg(&lock_hmux)
        .arg("--hmux-runtime-bin")
        .arg(&lock_hmux)
        .arg("--hmux-discovery-root")
        .arg(lock_root.join("hmux-discovery"))
        .args(["--expected-generation", locked_generation])
        .output()
        .unwrap();
    assert!(!service.status.success());
    assert_eq!(fs::read(&lock_target).unwrap(), b"unchanged");
    assert!(!lock_root.join("backend/control-plane.json").exists());
}

#[test]
fn restart_generation_rejects_a_different_hmux_before_pointer_mutation() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-restart-hmux-fence-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    let boot = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        boot.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&boot.stdout),
        String::from_utf8_lossy(&boot.stderr)
    );
    let descriptor = read_descriptor(root);
    stop_owned_service(root, &descriptor);
    let pointer = root.join("backend/control-plane.json");
    let pointer_before = fs::read(&pointer).unwrap();
    let replacement_hmux = root.join("replacement-hmux");
    write_owner_file(&replacement_hmux, b"#!/bin/sh\nexit 2\n", true);

    let rejected = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .args(["serve", "--home"])
        .arg(root)
        .arg("--hmux-bin")
        .arg(&replacement_hmux)
        .arg("--hmux-runtime-bin")
        .arg(&replacement_hmux)
        .arg("--hmux-discovery-root")
        .arg(root.join("hmux-discovery"))
        .args(["--expected-generation", descriptor.generation.as_str()])
        .output()
        .unwrap();

    assert!(!rejected.status.success());
    assert_eq!(fs::read(pointer).unwrap(), pointer_before);
    assert!(!backend_ping_available(&descriptor));
}

#[test]
fn byte_identical_cli_reuses_a_live_service_and_replaces_a_stopped_service() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-control-plane-executable-upgrade-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();

    let boot = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        boot.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&boot.stdout),
        String::from_utf8_lossy(&boot.stderr)
    );
    let descriptor_path = root.join("backend/control-plane.json");
    let source = read_descriptor(root);

    let replacement_install = root.join("replacement-cli");
    copy_tree(installed_cli(root).parent().unwrap(), &replacement_install);
    let replacement_cli = replacement_install.join("dure");
    let mut replacement_command = Command::new("node");
    replacement_command
        .arg(&replacement_cli)
        .args(["profiles", "list", "--json"])
        .current_dir(repository_root())
        .env("HOME", root)
        .env("DURE_HOME", root)
        .env("DURE_APP_CHANNEL", "stable")
        .env_remove("DURE_BACKEND_PROFILE")
        .env_remove("DURE_CONTROL_PLANE_BIN")
        .env("DURE_HMUX_BIN", &hmux)
        .env("DURE_HMUX_RUNTIME_BIN", &hmux)
        .env("HMUX_DISCOVERY_ROOT", root.join("hmux-discovery"))
        .env_remove("HMUX_SESSION_ID")
        .env_remove("DURE_CHECKPOINT_BINDING_GENERATION");
    let reused = output_with_recovery(&mut replacement_command);
    assert!(
        reused.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&reused.stdout),
        String::from_utf8_lossy(&reused.stderr)
    );

    let reused = read_descriptor(root);
    assert_eq!(reused.generation, source.generation);
    assert_eq!(reused.process_id, source.process_id);
    let reused_descriptor: Value =
        serde_json::from_slice(&fs::read(&descriptor_path).unwrap()).unwrap();
    assert_ne!(
        reused_descriptor["controlPlaneIdentity"]["executablePath"],
        Value::String(
            replacement_install
                .join("dure-control-plane")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );

    stop_owned_service(root, &reused);
    let replaced = output_with_recovery(&mut replacement_command);
    assert!(
        replaced.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&replaced.stdout),
        String::from_utf8_lossy(&replaced.stderr)
    );
    let replacement = read_descriptor(root);
    assert_ne!(replacement.generation, source.generation);
    assert_ne!(replacement.process_id, source.process_id);
    let profiles: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    assert_eq!(
        profiles["profiles"][0]["expected"]["generation"],
        replacement.generation
    );
    assert!(
        !root
            .join("backend/replacement-intents")
            .join(format!("{}.json", source.generation))
            .exists()
    );
    let descriptor: Value = serde_json::from_slice(&fs::read(&descriptor_path).unwrap()).unwrap();
    assert_eq!(
        descriptor["controlPlaneIdentity"]["executablePath"],
        Value::String(
            replacement_install
                .join("dure-control-plane")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
    stop_owned_service(root, &replacement);
}

#[test]
fn bootstrap_requires_current_capabilities_and_build_protocol_identity() {
    let _fixture = process_fixture_lock();
    let cases = [
        (
            "old-capabilities",
            Some("dure-control-plane/v2-observe"),
            vec![
                "agent_checkpoint.binding.ensure",
                "agent_checkpoint.read",
                "agent_checkpoint.write",
            ],
        ),
        (
            "old-build",
            None,
            vec![
                "agent_checkpoint.binding.ensure",
                "agent_checkpoint.observe",
                "agent_checkpoint.read",
                "agent_checkpoint.write",
            ],
        ),
    ];
    for (case, build_id, capabilities) in cases {
        let temporary = tempfile::Builder::new()
            .prefix(&format!("dure-{case}-"))
            .tempdir_in("/tmp")
            .unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = temporary.path();
        let generation = "local-v1-11111111111111111111111111111111";
        let old = start_backend_fixture(root, generation, build_id, capabilities.clone(), None);
        let hmux = root.join("unused-hmux");
        write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
        write_owner_file(
            &root.join("backend-profiles.json"),
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "kind": "dure.backend_profiles",
                    "profiles": [{
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
                            "generation": generation,
                            "protocol": {
                                "minimum": { "major": 1, "minor": 0 },
                                "maximum": { "major": 1, "minor": 0 }
                            },
                            "capabilities": capabilities
                        },
                        "deadlineMs": 10_000
                    }]
                })
            )
            .as_bytes(),
            false,
        );

        let upgraded = output_with_recovery(&mut cli_command(
            root,
            &hmux,
            &["profiles", "list", "--json"],
        ));
        assert!(
            upgraded.status.success(),
            "{case}: stdout={} stderr={}",
            String::from_utf8_lossy(&upgraded.stdout),
            String::from_utf8_lossy(&upgraded.stderr),
        );
        old.join().unwrap();
        let descriptor = read_descriptor(root);
        assert_ne!(descriptor.generation, generation, "{case}");
        assert_eq!(
            descriptor.build_id.as_deref(),
            Some(control_plane_identity().build_id),
            "{case}"
        );
        let catalog: Value =
            serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
        assert_eq!(
            catalog["profiles"][0]["expected"]["capabilities"]
                .as_array()
                .unwrap()
                .len(),
            control_plane_identity().capabilities.len(),
            "{case}"
        );
        stop_owned_service(root, &descriptor);
    }
}

#[test]
fn old_daemon_and_profile_upgrade_once_without_touching_remote_profiles() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-old-backend-upgrade-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let generation = "local-v1-11111111111111111111111111111111";
    let hmux = root.join("unused-hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    let old = start_old_backend(root, generation, &hmux);
    let remote = json!({
        "id": "remote-build",
        "default": false,
        "transport": {
            "kind": "ssh",
            "host": "build.example.test",
            "port": 22,
            "user": "dure_runner",
            "endpoint": { "kind": "tcp", "host": "127.0.0.1", "port": 4681 },
            "batchMode": true,
            "strictHostKeyChecking": "yes",
            "connectTimeoutMs": 5_000
        },
        "auth": { "kind": "ssh_agent" },
        "trust": { "kind": "known_hosts", "reference": "known-hosts-profile:remote-build" },
        "expected": {
            "backendId": "remote-build-backend",
            "generation": "remote-v1",
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "capabilities": ["agent_checkpoint.read", "agent_checkpoint.write"]
        },
        "deadlineMs": 10_000
    });
    write_owner_file(
        &root.join("backend-profiles.json"),
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "kind": "dure.backend_profiles",
                "profiles": [{
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
                        "generation": generation,
                        "protocol": {
                            "minimum": { "major": 1, "minor": 0 },
                            "maximum": { "major": 1, "minor": 0 }
                        },
                        "capabilities": [
                            "agent_checkpoint.binding.ensure",
                            "agent_checkpoint.read",
                            "agent_checkpoint.write"
                        ]
                    },
                    "deadlineMs": 10_000
                }, remote.clone()]
            })
        )
        .as_bytes(),
        false,
    );
    let upgraded = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        upgraded.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&upgraded.stdout),
        String::from_utf8_lossy(&upgraded.stderr),
    );
    old.join().unwrap();
    let descriptor = read_descriptor(root);
    assert_ne!(descriptor.generation, generation);
    assert_eq!(
        descriptor.build_id.as_deref(),
        Some(control_plane_identity().build_id)
    );
    let catalog: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    let local = catalog["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|profile| profile["id"] == "local")
        .unwrap();
    assert_eq!(local["expected"]["generation"], descriptor.generation);
    assert_eq!(
        local["expected"]["capabilities"].as_array().unwrap().len(),
        control_plane_identity().capabilities.len()
    );
    assert_eq!(
        catalog["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["id"] == "remote-build")
            .unwrap(),
        &remote
    );
    let first_pid = descriptor.process_id;
    let repeated = command(root, &hmux, &["profiles", "list", "--json"]);
    assert!(repeated.status.success());
    let repeated_descriptor = read_descriptor(root);
    assert_eq!(repeated_descriptor.process_id, first_pid);
    stop_owned_service(root, &repeated_descriptor);
}

#[test]
fn mismatched_control_plane_build_fails_before_replacement_is_journaled() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-mismatched-control-plane-build-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let source_generation = "local-v1-11111111111111111111111111111111";
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    let capabilities = [
        "agent_checkpoint.binding.ensure",
        "agent_checkpoint.read",
        "agent_checkpoint.write",
    ];
    let source = start_backend_fixture(
        root,
        source_generation,
        Some("dure-control-plane/v24-idle-prompt-presentation"),
        capabilities.to_vec(),
        Some(&hmux),
    );
    write_local_backend_profile(root, source_generation, &capabilities);

    let cli = installed_cli(root);
    rewrite_cli_build_identity(
        &cli,
        "dure-control-plane/v25-durable-workspace-lease",
        "dure-control-plane/v24-mismatch-fixture",
    );

    let output = command_with_control_plane(
        root,
        &hmux,
        Path::new(env!("CARGO_BIN_EXE_dure-control-plane")),
        &["profiles", "list", "--json"],
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let cleanup_deadline = Instant::now() + Duration::from_secs(2);
    let descriptor = loop {
        let descriptor = read_descriptor(root);
        if descriptor.socket_path.exists()
            || descriptor.generation != source_generation
            || Instant::now() >= cleanup_deadline
        {
            break descriptor;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let intent = root
        .join("backend/replacement-intents")
        .join(format!("{source_generation}.json"));

    if descriptor.generation == source_generation && descriptor.socket_path.exists() {
        let response = backend_request(
            root,
            &descriptor,
            "backend.shutdown",
            &[],
            json!({ "schemaVersion": 1 }),
        );
        assert_eq!(response["result"]["status"], "stopping");
        source.join().unwrap();
    } else if descriptor.generation != source_generation {
        source.join().unwrap();
        stop_owned_service(root, &descriptor);
    } else {
        source.join().unwrap();
    }

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        report["error"]["code"],
        "local_backend_control_plane_build_mismatch"
    );
    assert_eq!(descriptor.generation, source_generation);
    assert!(!intent.exists());
}

#[test]
fn interrupted_upgrade_resumes_exact_generation_for_checkpoint_and_sessions() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-interrupted-backend-upgrade-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let source_generation = "local-v1-11111111111111111111111111111111";
    let capabilities = vec![
        "agent_checkpoint.binding.ensure",
        "agent_checkpoint.observe",
        "agent_checkpoint.read",
        "agent_checkpoint.write",
        "sessions.list",
        "sessions.show",
    ];
    let old = start_backend_fixture(
        root,
        source_generation,
        Some("dure-control-plane/v3-exact-observe"),
        capabilities.clone(),
        None,
    );
    let hmux = write_session_query_fixture(root);
    write_owner_file(
        &root.join("agents.json"),
        &serde_json::to_vec(&json!({
            "version": 3,
            "updatedAt": 1,
            "agents": [{
                "id": "agent-remote-1",
                "name": "remote-agent",
                "displayName": "Remote Agent",
                "project": "Fixture",
                "sessionId": "session-remote-1",
                "kind": "pty",
                "provider": "codex",
                "worktree": repository_root(),
                "branch": "fixture",
                "runtimeBinding": {
                    "schemaVersion": 1,
                    "runtime": "hmux_managed_v1",
                    "source": "local",
                    "hostId": "local",
                    "sessionId": "session-remote-1",
                    "workspaceId": "workspace-remote-1",
                    "createIdempotencyKey": "fixture-create-remote-1",
                    "stopFence": {
                        "runnerPrincipal": "remote-runner",
                        "runnerInstance": "remote-runner-1",
                        "channelEpoch": "4",
                        "hostInstanceId": "remote-host-1",
                        "terminalEpoch": "remote-terminal-1"
                    }
                }
            }]
        }))
        .unwrap(),
        false,
    );
    write_owner_file(
        &root.join("backend-profiles.json"),
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "kind": "dure.backend_profiles",
                "profiles": [{
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
                        "generation": source_generation,
                        "protocol": {
                            "minimum": { "major": 1, "minor": 0 },
                            "maximum": { "major": 1, "minor": 0 }
                        },
                        "capabilities": capabilities
                    },
                    "deadlineMs": 10_000
                }]
            })
        )
        .as_bytes(),
        false,
    );
    let delayed_control_plane = root.join("delayed-control-plane");
    write_owner_file(
        &delayed_control_plane,
        format!(
            "#!/bin/sh\nif [ \"$1\" = serve ]; then sleep 5; fi\nexec '{}' \"$@\"\n",
            env!("CARGO_BIN_EXE_dure-control-plane")
        )
        .as_bytes(),
        true,
    );

    let interrupted = command_with_control_plane(
        root,
        &hmux,
        &delayed_control_plane,
        &["profiles", "list", "--json"],
    );
    assert_eq!(interrupted.status.code(), Some(2));
    let interrupted: Value = serde_json::from_slice(&interrupted.stdout).unwrap();
    assert_eq!(interrupted["error"]["code"], "recovering");
    let before_resume: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    assert_eq!(
        before_resume["profiles"][0]["expected"]["generation"],
        source_generation
    );
    let intent_path = root
        .join("backend/replacement-intents")
        .join(format!("{source_generation}.json"));
    assert!(intent_path.exists());

    let sessions = command_with_control_plane(
        root,
        &hmux,
        &delayed_control_plane,
        &["sessions", "list", "--backend", "local", "--json"],
    );
    assert!(
        sessions.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&sessions.stdout),
        String::from_utf8_lossy(&sessions.stderr)
    );
    let sessions: Value = serde_json::from_slice(&sessions.stdout).unwrap();
    assert_eq!(sessions["sessions"][0]["sessionId"], "session-remote-1");
    old.join().unwrap();
    let replacement: Descriptor =
        serde_json::from_slice(&fs::read(root.join("backend/control-plane.json")).unwrap())
            .unwrap();
    assert_ne!(replacement.generation, source_generation);
    let resumed = command_with_control_plane(
        root,
        &hmux,
        &delayed_control_plane,
        &["sessions", "list", "--backend", "local", "--json"],
    );
    assert!(
        resumed.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&resumed.stdout),
        String::from_utf8_lossy(&resumed.stderr)
    );
    let resumed: Value = serde_json::from_slice(&resumed.stdout).unwrap();
    assert_eq!(resumed["sessions"][0]["sessionId"], "session-remote-1");
    let after_resume: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    assert_eq!(
        after_resume["profiles"][0]["expected"]["generation"],
        replacement.generation
    );
    assert!(!intent_path.exists());
    assert!(!root.join("server.json").exists());
    stop_owned_service(root, &replacement);
}

#[test]
fn normal_upgrade_never_exposes_an_absent_backend_interval() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-live-backend-upgrade-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let source_generation = "local-v1-11111111111111111111111111111111";
    let capabilities = [
        "agent_checkpoint.binding.ensure",
        "agent_checkpoint.read",
        "agent_checkpoint.write",
    ];
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    let source = start_backend_fixture(
        root,
        source_generation,
        Some("dure-control-plane/v28-schedule-retention"),
        capabilities.to_vec(),
        Some(&hmux),
    );
    write_local_backend_profile(root, source_generation, &capabilities);
    let source_descriptor = read_descriptor(root);
    let source_pointer = fs::read(root.join("backend/control-plane.json")).unwrap();
    let delayed_control_plane = root.join("delayed-control-plane");
    write_owner_file(
        &delayed_control_plane,
        format!(
            "#!/bin/sh\nif [ \"$1\" = identity ] || [ \"$1\" = preflight ]; then exec '{}' \"$@\"; fi\nsleep 1\nexec '{}' \"$@\"\n",
            env!("CARGO_BIN_EXE_dure-control-plane"),
            env!("CARGO_BIN_EXE_dure-control-plane")
        )
        .as_bytes(),
        true,
    );

    let mut upgrade = cli_command(root, &hmux, &["profiles", "list", "--json"])
        .env("DURE_CONTROL_PLANE_BIN", &delayed_control_plane)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let intent_path = root
        .join("backend/replacement-intents")
        .join(format!("{source_generation}.json"));
    let intent_deadline = Instant::now() + Duration::from_secs(2);
    while !intent_path.exists() && Instant::now() < intent_deadline {
        assert!(
            upgrade.try_wait().unwrap().is_none(),
            "the upgrade exited before recording its verified replacement intent"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        intent_path.exists(),
        "the upgrade never reached its replacement boundary"
    );
    let observation_deadline = Instant::now() + Duration::from_millis(700);
    let mut source_was_unavailable = false;
    let mut pointer_changed_before_successor_readiness = false;
    while Instant::now() < observation_deadline {
        if fs::read(root.join("backend/control-plane.json")).unwrap() != source_pointer {
            pointer_changed_before_successor_readiness = true;
            break;
        }
        if !backend_ping_available(&source_descriptor) {
            source_was_unavailable = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let upgraded = upgrade.wait_with_output().unwrap();
    source.join().unwrap();
    let target = read_descriptor(root);
    if target.generation != source_generation {
        stop_owned_service(root, &target);
    }

    assert!(
        upgraded.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&upgraded.stdout),
        String::from_utf8_lossy(&upgraded.stderr)
    );
    assert!(
        !pointer_changed_before_successor_readiness,
        "the canonical backend descriptor moved before the delayed successor was ready"
    );
    assert!(
        !source_was_unavailable,
        "the source backend stopped responding before the delayed successor was ready"
    );
}

#[test]
fn incompatible_database_is_rejected_before_replacement_state_or_process_mutation() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-incompatible-backend-upgrade-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let generation = "local-v1-11111111111111111111111111111111";
    let capabilities = [
        "agent_checkpoint.binding.ensure",
        "agent_checkpoint.read",
        "agent_checkpoint.write",
    ];
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    let source = start_backend_fixture(
        root,
        generation,
        Some("dure-control-plane/v28-schedule-retention"),
        capabilities.to_vec(),
        Some(&hmux),
    );
    write_local_backend_profile(root, generation, &capabilities);
    let database = root.join("backend/application-state.sqlite3");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let store = SqliteDomainStore::open(&database).await.unwrap();
        store.close().await;
        let mut connection = SqliteConnection::connect(&format!("sqlite://{}", database.display()))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE store_metadata SET min_reader_version = 999, min_writer_version = 999 WHERE singleton = 1",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection.close().await.unwrap();
    });
    let pointer = root.join("backend/control-plane.json");
    let pointer_before = fs::read(&pointer).unwrap();

    let rejected = command(root, &hmux, &["profiles", "list", "--json"]);
    let report: Value = serde_json::from_slice(&rejected.stdout).unwrap();
    let observed = read_descriptor(root);
    let intent = root
        .join("backend/replacement-intents")
        .join(format!("{generation}.json"));
    let response = backend_request(
        root,
        &observed,
        "backend.shutdown",
        &[],
        json!({ "schemaVersion": 1 }),
    );
    source.join().unwrap();

    assert_eq!(rejected.status.code(), Some(2));
    assert_eq!(report["error"]["code"], "cli_update_required");
    assert_eq!(fs::read(pointer).unwrap(), pointer_before);
    assert_eq!(observed.generation, generation);
    assert_eq!(response["result"]["status"], "stopping");
    assert!(!intent.exists());
}

#[test]
fn uncertain_shutdown_delivery_retries_the_exact_source_after_reconnect() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-uncertain-backend-shutdown-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let source_generation = "local-v1-11111111111111111111111111111111";
    let capabilities = [
        "agent_checkpoint.binding.ensure",
        "agent_checkpoint.read",
        "agent_checkpoint.write",
    ];
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();
    let source = start_backend_fixture_with_shutdown_fault(
        root,
        source_generation,
        Some("dure-control-plane/v28-schedule-retention"),
        capabilities.to_vec(),
        Some(&hmux),
        true,
    );
    write_local_backend_profile(root, source_generation, &capabilities);

    let mut uncertain = command(root, &hmux, &["profiles", "list", "--json"]);
    if is_recovering_output(&uncertain) && read_descriptor(root).generation == source_generation {
        uncertain = command(root, &hmux, &["profiles", "list", "--json"]);
    }
    let uncertain_report: Value = serde_json::from_slice(&uncertain.stdout).unwrap();
    let target = read_descriptor(root);
    let catalog_before_retry: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    let intent_path = root
        .join("backend/replacement-intents")
        .join(format!("{source_generation}.json"));
    assert_eq!(uncertain.status.code(), Some(2));
    assert_eq!(uncertain_report["error"]["code"], "recovering");
    assert_ne!(
        target.generation,
        source_generation,
        "stdout={} stderr={}",
        String::from_utf8_lossy(&uncertain.stdout),
        String::from_utf8_lossy(&uncertain.stderr)
    );
    assert!(backend_ping_available(&target));
    let fenced_target_mutation = backend_request(
        root,
        &target,
        "projects.list",
        &["projects.list"],
        json!({ "schemaVersion": 1, "maxItems": 1 }),
    );
    assert_eq!(fenced_target_mutation["error"]["code"], "recovering");
    assert_eq!(
        catalog_before_retry["profiles"][0]["expected"]["generation"],
        source_generation
    );
    assert!(intent_path.exists());

    let mut crash_catalog = catalog_before_retry;
    crash_catalog["profiles"][0]["transport"]["endpoint"]["path"] =
        Value::String(target.socket_path.to_string_lossy().into_owned());
    crash_catalog["profiles"][0]["expected"]["generation"] =
        Value::String(target.generation.clone());
    crash_catalog["profiles"][0]["expected"]["capabilities"] =
        serde_json::to_value(control_plane_identity().capabilities).unwrap();
    fs::write(
        root.join("backend-profiles.json"),
        format!("{crash_catalog}\n"),
    )
    .unwrap();

    let retried = command(root, &hmux, &["profiles", "list", "--json"]);
    let catalog_after_retry: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    let unfenced_target_mutation = backend_request(
        root,
        &target,
        "projects.list",
        &["projects.list"],
        json!({ "schemaVersion": 1, "maxItems": 1 }),
    );
    source.join().unwrap();
    stop_owned_service(root, &target);

    assert!(
        retried.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&retried.stdout),
        String::from_utf8_lossy(&retried.stderr)
    );
    assert_eq!(
        catalog_after_retry["profiles"][0]["expected"]["generation"],
        target.generation
    );
    assert_eq!(unfenced_target_mutation["result"]["projects"], json!([]));
    assert!(!intent_path.exists());
}

#[test]
fn older_cli_cannot_journal_or_shutdown_a_newer_descriptor_generation() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-older-cli-downgrade-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);

    let started = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(
        started.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&started.stdout),
        String::from_utf8_lossy(&started.stderr)
    );
    let source = read_descriptor(root);
    let source_descriptor = fs::read(root.join("backend/control-plane.json")).unwrap();
    let legacy_control_plane =
        freeze_legacy_replacement_client(root, "dure-control-plane/v27-schedule-authority");

    let attempted = command_with_control_plane(
        root,
        &hmux,
        &legacy_control_plane,
        &["profiles", "list", "--json"],
    );
    let report: Value = serde_json::from_slice(&attempted.stdout).unwrap();
    let observed = read_descriptor(root);
    let observed_descriptor = fs::read(root.join("backend/control-plane.json")).unwrap();
    let ping = backend_request(
        root,
        &observed,
        "backend.ping",
        &[],
        json!({ "schemaVersion": 1 }),
    );
    let intent_path = root
        .join("backend/replacement-intents")
        .join(format!("{}.json", source.generation));
    stop_owned_service(root, &observed);

    assert_eq!(attempted.status.code(), Some(2));
    assert_eq!(report["error"]["code"], "local_backend_descriptor_invalid");
    assert_eq!(observed_descriptor, source_descriptor);
    assert_eq!(observed.generation, source.generation);
    assert_eq!(ping["result"]["status"], "ready");
    assert!(!intent_path.exists());
}

#[test]
fn shutdown_boundary_rejects_legacy_and_downgrade_targets() {
    let _fixture = process_fixture_lock();
    let temporary = tempfile::Builder::new()
        .prefix("dure-shutdown-direction-fence-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    let hmux = root.join("hmux");
    write_owner_file(&hmux, b"#!/bin/sh\nexit 1\n", true);
    let started = output_with_recovery(&mut cli_command(
        root,
        &hmux,
        &["profiles", "list", "--json"],
    ));
    assert!(started.status.success());
    let descriptor = read_descriptor(root);
    let descriptor_value: Value =
        serde_json::from_slice(&fs::read(root.join("backend/control-plane.json")).unwrap())
            .unwrap();

    let legacy = backend_request(
        root,
        &descriptor,
        "backend.shutdown",
        &[],
        json!({ "schemaVersion": 1 }),
    );
    let target_generation = "local-v1-22222222222222222222222222222222";
    let target = replacement_target(root, control_plane_identity().build_id, target_generation);
    let missing = backend_request(
        root,
        &descriptor,
        "backend.shutdown",
        &[],
        json!({
            "schemaVersion": 2,
            "mode": "replace",
            "target": target.clone()
        }),
    );
    let intent_directory = root.join("backend/replacement-intents");
    fs::create_dir(&intent_directory).unwrap();
    fs::set_permissions(&intent_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let intent_path = intent_directory.join(format!("{}.json", descriptor.generation));
    let write_intent = |intent_target: &Value| {
        write_owner_file(
            &intent_path,
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "kind": "dure.local_backend_replacement_intent",
                    "source": {
                        "generation": descriptor.generation.clone(),
                        "buildId": descriptor.build_id.clone(),
                        "hmuxIdentity": descriptor_hmux_identity(&descriptor_value)
                    },
                    "target": intent_target,
                    "createdAtMs": 1
                })
            )
            .as_bytes(),
            false,
        );
    };
    let downgrade_target = replacement_target(
        root,
        "dure-control-plane/v28-schedule-retention",
        "local-v1-11111111111111111111111111111111",
    );
    write_intent(&downgrade_target);
    let downgrade = backend_request(
        root,
        &descriptor,
        "backend.shutdown",
        &[],
        json!({
            "schemaVersion": 2,
            "mode": "replace",
            "target": downgrade_target
        }),
    );
    fs::remove_file(&intent_path).unwrap();
    let ambiguous_target = replacement_target(
        root,
        "dure-control-plane/v31-divergent-build",
        "local-v1-44444444444444444444444444444444",
    );
    write_intent(&ambiguous_target);
    let ambiguous = backend_request(
        root,
        &descriptor,
        "backend.shutdown",
        &[],
        json!({
            "schemaVersion": 2,
            "mode": "replace",
            "target": ambiguous_target
        }),
    );
    fs::remove_file(&intent_path).unwrap();
    write_intent(&target);
    let mismatched = backend_request(
        root,
        &descriptor,
        "backend.shutdown",
        &[],
        json!({
            "schemaVersion": 2,
            "mode": "replace",
            "target": replacement_target(
                root,
                control_plane_identity().build_id,
                "local-v1-33333333333333333333333333333333"
            )
        }),
    );
    let ping = backend_request(
        root,
        &descriptor,
        "backend.ping",
        &[],
        json!({ "schemaVersion": 1 }),
    );
    let exact = backend_request(
        root,
        &descriptor,
        "backend.shutdown",
        &[],
        json!({
            "schemaVersion": 2,
            "mode": "replace",
            "target": target
        }),
    );
    wait_owned_service_exit(&descriptor);

    assert_eq!(legacy["error"]["code"], "backend_shutdown_invalid");
    assert_eq!(
        downgrade["error"]["code"],
        "backend_shutdown_downgrade_rejected"
    );
    assert_eq!(
        missing["error"]["code"],
        "backend_shutdown_intent_unavailable"
    );
    assert_eq!(
        mismatched["error"]["code"],
        "backend_shutdown_intent_mismatch"
    );
    assert_eq!(
        ambiguous["error"]["code"],
        "backend_shutdown_downgrade_rejected"
    );
    assert_eq!(ping["result"]["status"], "ready");
    assert_eq!(exact["result"]["status"], "stopping");
}
