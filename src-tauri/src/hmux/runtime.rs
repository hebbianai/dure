use super::bounded_process::{self, CommandFailure, CommandSpec};
use super::runtime_install_health::{
    assess_independent_install, with_missing_capability, with_probe_failure,
    with_unsafe_install, IndependentInstallHealth, IndependentInstallReadiness,
};
use hmux_client::{ProtocolVersion, SessionDescriptor, VersionRange};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

#[path = "runtime/command_failure.rs"]
mod command_failure;
use command_failure::external_cli_failure;
mod build_info;
#[cfg(all(test, unix))]
mod create_compatibility_tests;
use build_info::{inspect_runtime_at, installed_supports_app_sessions};

const BUILD_INFO_SUBCOMMAND: &str = "hmux-build-info";
// Interactive startup remains fail-fast. QA fixture setup has a separate
// budget because it can compile and stage the runtime on a loaded runner.
const BUILD_INFO_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(debug_assertions)]
const QA_BUILD_INFO_TIMEOUT: Duration = Duration::from_secs(30);
const BUILD_INFO_LIMIT: usize = 64 * 1024;
// Capability discovery runs off the UI thread and gates use of an otherwise
// valid independent install. Give loaded developer machines more room than
// the interactive startup probe without weakening fail-closed validation.
const CAPABILITY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const EXTERNAL_CLI_TIMEOUT: Duration = Duration::from_secs(3);
const EXTERNAL_CLI_OUTPUT_LIMIT: usize = 256 * 1024;
const INSTALL_METADATA_LIMIT: u64 = 64 * 1024;
// The app passes the current inventory during revoke. An older pairing CLI
// would reject that flag and hide the only recovery path for a moved key.
const PAIRING_CLI_CAPABILITY: &str = "pairing_revoke_inventory_v1";
const RUNTIME_OVERRIDE_ENVS: &[&str] = &["HMUX_RUNTIME", "HEBBIAN_HMUX_RUNTIME"];

#[derive(Clone, Debug, Eq, PartialEq)]
struct InstallHealthCacheKey {
    build_id: String,
    runtime: PathBuf,
}

#[derive(Clone, Debug)]
struct CachedInstallHealth {
    key: InstallHealthCacheKey,
    health: IndependentInstallHealth,
}

static INSTALL_HEALTH_CACHE: OnceLock<Mutex<Option<CachedInstallHealth>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClientSelectionKind {
    DirectRust,
    ExternalCliRequired,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct InstalledBuild {
    pub build_id: String,
    pub runtime: PathBuf,
}

impl InstalledBuild {
    pub(super) fn capabilities(&self) -> Result<Vec<String>, String> {
        inspect_runtime_at(&self.runtime, CAPABILITY_PROBE_TIMEOUT).map(|info| info.capabilities)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ExternalProbeStatus {
    Healthy,
    StaleTransport,
    IncompatibleProtocol,
    Exited,
    GenerationChanged,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExternalSnapshot {
    pub schema_version: u16,
    pub session_id: String,
    pub workspace_id: String,
    pub terminal_epoch: String,
    pub sequence_through: String,
    pub rows: u16,
    pub columns: u16,
    pub data: String,
    pub alternate_screen: bool,
    pub cursor_visible: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdatePolicyState {
    pub current_build_id: Option<String>,
    pub previous_build_id: Option<String>,
    pub activation: &'static str,
    pub signed_release_fetch: &'static str,
    pub signed_package_install: &'static str,
    pub independent_install: IndependentInstallHealth,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliCapabilityReceipt {
    schema_version: u16,
    build_info: CliBuildInfo,
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliBuildInfo {
    build_id: String,
    source: String,
    protocol: InstallProtocol,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalProbeReceipt {
    schema_version: u16,
    #[serde(default)]
    ok: Option<bool>,
    session_id: String,
    workspace_id: String,
    #[serde(default)]
    runner_principal: Option<String>,
    #[serde(default)]
    runner_instance: Option<String>,
    #[serde(default)]
    channel_epoch: Option<String>,
    #[serde(default)]
    host_instance_id: Option<String>,
    #[serde(default)]
    terminal_epoch: Option<String>,
    status: ExternalProbeStatus,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallMetadata {
    schema_version: u16,
    build_id: String,
    package_version: String,
    target_triple: String,
    protocol: InstallProtocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    activation_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cli_available: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct InstallProtocol {
    minimum: String,
    maximum: String,
}

pub(crate) fn resolve_runtime<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    ensure_current_build(app).map(|build| build.runtime)
}

pub(super) fn ensure_current_build<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<InstalledBuild, String> {
    ensure_current_build_at(app, BUILD_INFO_TIMEOUT)
}

#[cfg(debug_assertions)]
pub(super) fn prepare_current_build_for_qa<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<InstalledBuild, String> {
    ensure_current_build_at(app, QA_BUILD_INFO_TIMEOUT)
}

fn ensure_current_build_at<R: Runtime>(
    app: &AppHandle<R>,
    build_info_timeout: Duration,
) -> Result<InstalledBuild, String> {
    let install_root = install_root()?;
    let current_error = match fs::symlink_metadata(install_root.join("current")) {
        Ok(_) => match resolve_current_at(&install_root) {
            Ok(current) => {
                if installed_supports_app_sessions(&current, build_info_timeout)? {
                    return Ok(current);
                }
                "hmux_create_runtime_incompatible: installed runtime does not support this app's session contract".to_string()
            }
            Err(error) => {
                if !safe_version_link(&install_root, "current") {
                    return Err(error);
                }
                error
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            "hmux_current_unavailable: no installed current build or local bundled runtime".to_string()
        }
        Err(_) => return Err("hmux_current_invalid: current build metadata is unreadable".to_string()),
    };
    let source = bundled_runtime_candidates(app)
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
        .ok_or(current_error)?;
    activate_bundled_runtime_at(&install_root, &source, build_info_timeout)
}

pub(super) fn current_build_id() -> Option<String> {
    install_root()
        .ok()
        .and_then(|root| resolve_current_at(&root).ok())
        .map(|build| build.build_id)
}

pub(super) fn update_policy_state() -> UpdatePolicyState {
    let root = install_root();
    let current = root
        .as_ref()
        .ok()
        .and_then(|root| resolve_current_at(root).ok());
    UpdatePolicyState {
        current_build_id: current.as_ref().map(|build| build.build_id.clone()),
        previous_build_id: root
            .as_ref()
            .ok()
            .and_then(|root| previous_build_id_at(root)),
        activation: "local_bundled_or_installed_current",
        signed_release_fetch: "not_implemented",
        signed_package_install: "blocked_missing_trust_root",
        independent_install: match (root.as_ref().ok(), current.as_ref()) {
            (Some(_), Some(current)) => cached_independent_install_health(current),
            _ => IndependentInstallHealth::unavailable(),
        },
    }
}

pub(super) fn resolve_independent_cli() -> Result<Option<PathBuf>, String> {
    let root = install_root()?;
    resolve_independent_cli_at(&root)
}

fn resolve_independent_cli_at(root: &Path) -> Result<Option<PathBuf>, String> {
    resolve_independent_cli_at_with_timeout(root, CAPABILITY_PROBE_TIMEOUT)
}

fn resolve_independent_cli_at_with_timeout(
    root: &Path,
    probe_timeout: Duration,
) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(root.join("current")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("hmux_current_invalid: current build metadata is unreadable".to_string())
        }
        Ok(_) => {}
    }
    let current = resolve_current_at(root)?;
    let health = independent_install_health_at_with_timeout(&current, probe_timeout);
    match health.readiness {
        IndependentInstallReadiness::Ready => version_cli_at(root, &current.build_id),
        IndependentInstallReadiness::BundledFallback
        | IndependentInstallReadiness::ProvenanceUnknown
        | IndependentInstallReadiness::Unavailable => Ok(None),
        _ => Err(format!(
            "hmux_independent_install_invalid: {}",
            health.diagnostic_message()
        )),
    }
}

pub(super) fn rollback_current() -> Result<InstalledBuild, String> {
    let install_root = install_root()?;
    rollback_current_at(&install_root)
}

fn rollback_current_at(install_root: &Path) -> Result<InstalledBuild, String> {
    validate_directory(install_root, "hmux_install_root_invalid")?;
    let _lock = MutationLock::acquire(install_root)?;
    let current = resolve_current_at(install_root)?;
    let previous = resolve_version_link_at(
        install_root,
        "previous",
        "hmux_previous_invalid",
    )?;
    if previous.build_id == current.build_id {
        return Err("hmux_rollback_unavailable: previous equals current".to_string());
    }
    activate_current_symlink(install_root, &previous.build_id)?;
    resolve_current_at(install_root)
}

pub(super) fn activate_installed_build(build_id: &str) -> Result<InstalledBuild, String> {
    let install_root = install_root()?;
    validate_directory(&install_root, "hmux_install_root_invalid")?;
    let _lock = MutationLock::acquire(&install_root)?;
    validate_installed_build(&install_root, build_id)?;
    activate_current_symlink(&install_root, build_id)?;
    resolve_current_at(&install_root)
}

pub(super) fn resolve_installed_build(build_id: &str) -> Result<InstalledBuild, String> {
    let install_root = install_root()?;
    validate_installed_build(&install_root, build_id)
}

fn previous_build_id_at(install_root: &Path) -> Option<String> {
    resolve_version_link_at(install_root, "previous", "hmux_previous_invalid")
        .ok()
        .map(|build| build.build_id)
}

pub(super) fn select_client(
    host_build_version: &str,
    supported_protocol: &VersionRange,
) -> ClientSelectionKind {
    if protocol_contains(
        supported_protocol,
        &ProtocolVersion { major: 1, minor: 0 },
    ) {
        return ClientSelectionKind::DirectRust;
    }
    let Ok(root) = install_root() else {
        return ClientSelectionKind::Unavailable;
    };
    match version_cli_at(&root, host_build_version) {
        Ok(Some(_)) => ClientSelectionKind::ExternalCliRequired,
        Ok(None) | Err(_) => ClientSelectionKind::Unavailable,
    }
}

pub(super) fn probe_with_version_cli(
    host_build_version: &str,
    discovery_root: &Path,
    expected: &SessionDescriptor,
) -> Result<ExternalProbeStatus, String> {
    let root = install_root()?;
    probe_receipt_with_version_cli_at(
        &root,
        host_build_version,
        discovery_root,
        &expected.session_id,
        &expected.workspace_id,
        EXTERNAL_CLI_TIMEOUT,
    )
    .and_then(|(status, receipt)| {
        validate_external_generation(&receipt, expected)?;
        Ok(status)
    })
}

pub(super) fn probe_with_version_cli_until(
    host_build_version: &str,
    discovery_root: &Path,
    expected: &SessionDescriptor,
    deadline: std::time::Instant,
) -> Result<ExternalProbeStatus, String> {
    let root = install_root()?;
    let timeout = deadline.saturating_duration_since(std::time::Instant::now());
    if timeout.is_zero() {
        return Err("hmux_external_cli_timeout: session probe budget expired".to_string());
    }
    probe_receipt_with_version_cli_at(
        &root,
        host_build_version,
        discovery_root,
        &expected.session_id,
        &expected.workspace_id,
        timeout,
    )
    .and_then(|(status, receipt)| {
        validate_external_generation(&receipt, expected)?;
        Ok(status)
    })
}

pub(super) fn snapshot_with_version_cli(
    host_build_version: &str,
    discovery_root: &Path,
    session_id: &str,
    workspace_id: &str,
) -> Result<ExternalSnapshot, String> {
    let root = install_root()?;
    snapshot_with_version_cli_at(
        &root,
        host_build_version,
        discovery_root,
        session_id,
        workspace_id,
        EXTERNAL_CLI_TIMEOUT,
    )
}

#[cfg(test)]
fn probe_with_version_cli_at(
    install_root: &Path,
    host_build_version: &str,
    discovery_root: &Path,
    session_id: &str,
    workspace_id: &str,
    timeout: Duration,
) -> Result<ExternalProbeStatus, String> {
    probe_receipt_with_version_cli_at(
        install_root,
        host_build_version,
        discovery_root,
        session_id,
        workspace_id,
        timeout,
    )
    .map(|(status, _)| status)
}

fn probe_receipt_with_version_cli_at(
    install_root: &Path,
    host_build_version: &str,
    discovery_root: &Path,
    session_id: &str,
    workspace_id: &str,
    timeout: Duration,
) -> Result<(ExternalProbeStatus, ExternalProbeReceipt), String> {
    let (output, exit_status) = run_version_cli_at(
        install_root,
        host_build_version,
        discovery_root,
        &[
            "session",
            "probe",
            session_id,
            "--workspace",
            workspace_id,
        ],
        timeout,
        true,
    )?;
    let receipt: ExternalProbeReceipt = serde_json::from_slice(&output)
        .map_err(|_| "hmux_external_cli_invalid: probe receipt is malformed".to_string())?;
    validate_external_identity(
        receipt.schema_version,
        &receipt.session_id,
        &receipt.workspace_id,
        session_id,
        workspace_id,
    )?;
    let healthy = receipt.status == ExternalProbeStatus::Healthy;
    match receipt.ok {
        Some(ok)
            if ok != healthy
                || ok != exit_status.success()
                || !ok && exit_status.code() != Some(1) =>
        {
            return Err(
                "hmux_external_cli_invalid: probe receipt success marker is inconsistent"
                    .to_string(),
            );
        }
        None if !exit_status.success() => {
            return Err(
                "hmux_external_cli_invalid: legacy probe receipt used an unsuccessful exit"
                    .to_string(),
            );
        }
        _ => {}
    }
    Ok((receipt.status, receipt))
}

fn snapshot_with_version_cli_at(
    install_root: &Path,
    host_build_version: &str,
    discovery_root: &Path,
    session_id: &str,
    workspace_id: &str,
    timeout: Duration,
) -> Result<ExternalSnapshot, String> {
    let (output, _) = run_version_cli_at(
        install_root,
        host_build_version,
        discovery_root,
        &[
            "session",
            "snapshot",
            session_id,
            "--workspace",
            workspace_id,
        ],
        timeout,
        false,
    )?;
    let receipt: ExternalSnapshot = serde_json::from_slice(&output)
        .map_err(|_| "hmux_external_cli_invalid: snapshot receipt is malformed".to_string())?;
    validate_external_identity(
        receipt.schema_version,
        &receipt.session_id,
        &receipt.workspace_id,
        session_id,
        workspace_id,
    )?;
    Ok(receipt)
}

fn run_version_cli_at(
    install_root: &Path,
    host_build_version: &str,
    discovery_root: &Path,
    arguments: &[&str],
    timeout: Duration,
    allow_nonzero: bool,
) -> Result<(Vec<u8>, std::process::ExitStatus), String> {
    let cli = version_cli_at(install_root, host_build_version)?
        .ok_or_else(|| "hmux_external_cli_unavailable: version-matched CLI is missing".to_string())?;
    let mut command = CommandSpec::new(cli);
    command
        .arg("--discovery-root")
        .arg(discovery_root)
        .arg("--json")
        .args(arguments)
        .clear_env();
    let output = bounded_process::run(&command, timeout, EXTERNAL_CLI_OUTPUT_LIMIT)
        .map_err(external_cli_failure)?;
    let successful_exit = output.status.success();
    if !successful_exit && !allow_nonzero {
        return Err("hmux_external_cli_failed: version-matched CLI rejected the request".to_string());
    }
    if output.exceeded_limit {
        return Err("hmux_external_cli_invalid: CLI output is too large".to_string());
    }
    Ok((output.stdout, output.status))
}

fn validate_external_generation(
    receipt: &ExternalProbeReceipt,
    expected: &SessionDescriptor,
) -> Result<(), String> {
    let fields = [
        receipt.runner_principal.as_deref(),
        receipt.runner_instance.as_deref(),
        receipt.channel_epoch.as_deref(),
        receipt.host_instance_id.as_deref(),
        receipt.terminal_epoch.as_deref(),
    ];
    if fields.iter().all(|field| field.is_none()) {
        return Ok(());
    }
    if fields.iter().any(|field| field.is_none())
        || receipt.runner_principal.as_deref() != Some(expected.runner_principal.as_str())
        || receipt.runner_instance.as_deref() != Some(expected.runner_instance.as_str())
        || receipt.channel_epoch.as_deref() != Some(expected.channel_epoch.as_str())
        || receipt.host_instance_id.as_deref() != Some(expected.host_instance_id.as_str())
        || receipt.terminal_epoch.as_deref() != Some(expected.terminal_epoch.as_str())
    {
        return Err(
            "hmux_external_cli_invalid: probe receipt generation fence changed".to_string(),
        );
    }
    Ok(())
}

fn validate_external_identity(
    schema_version: u16,
    actual_session_id: &str,
    actual_workspace_id: &str,
    expected_session_id: &str,
    expected_workspace_id: &str,
) -> Result<(), String> {
    if schema_version != 1
        || actual_session_id != expected_session_id
        || actual_workspace_id != expected_workspace_id
    {
        return Err(
            "hmux_external_cli_invalid: receipt identity does not match the request".to_string(),
        );
    }
    Ok(())
}

fn install_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("HMUX_INSTALL_ROOT") {
        if value.is_empty() {
            return Err("hmux_install_root_invalid: HMUX_INSTALL_ROOT is empty".to_string());
        }
        return Ok(PathBuf::from(value));
    }
    dirs::home_dir()
        .map(|home| home.join(".local/share/hmux"))
        .ok_or_else(|| "hmux_install_root_unavailable: HOME is unavailable".to_string())
}

fn resolve_current_at(install_root: &Path) -> Result<InstalledBuild, String> {
    resolve_version_link_at(install_root, "current", "hmux_current_invalid")
}

fn resolve_version_link_at(
    install_root: &Path,
    link_name: &str,
    code: &str,
) -> Result<InstalledBuild, String> {
    validate_directory(install_root, "hmux_install_root_invalid")?;
    let versions = install_root.join("versions");
    validate_directory(&versions, "hmux_versions_invalid")?;
    let link = install_root.join(link_name);
    let metadata = fs::symlink_metadata(&link)
        .map_err(|_| format!("{code}: {link_name} symlink is unavailable"))?;
    if !metadata.file_type().is_symlink() {
        return Err(format!("{code}: {link_name} must be a symlink"));
    }
    let target = fs::read_link(&link)
        .map_err(|_| format!("{code}: {link_name} symlink is unreadable"))?;
    let mut components = target.components();
    if components.next() != Some(Component::Normal("versions".as_ref())) {
        return Err(format!("{code}: {link_name} target is outside versions"));
    }
    let Some(Component::Normal(build_component)) = components.next() else {
        return Err(format!("{code}: {link_name} target has no build id"));
    };
    if components.next().is_some() {
        return Err(format!("{code}: {link_name} target must name one build"));
    }
    let build_id = build_component
        .to_str()
        .filter(|value| safe_build_id(value))
        .ok_or_else(|| format!("{code}: {link_name} build id is unsafe"))?;
    validate_installed_build(install_root, build_id)
}

fn validate_installed_build(
    install_root: &Path,
    build_id: &str,
) -> Result<InstalledBuild, String> {
    if !safe_build_id(build_id) {
        return Err("hmux_build_id_invalid: build id is unsafe".to_string());
    }
    let version = install_root.join("versions").join(build_id);
    validate_directory(&version, "hmux_version_invalid")?;
    let metadata = read_install_metadata_at(&version, build_id)?;
    validate_protocol(&metadata.protocol)?;
    let bin = version.join("bin");
    validate_directory(&bin, "hmux_bin_invalid")?;
    let runtime = bin.join(runtime_file_name());
    if !is_executable_regular_file(&runtime) {
        return Err("hmux_runtime_invalid: immutable runtime is unavailable".to_string());
    }
    Ok(InstalledBuild {
        build_id: build_id.to_string(),
        runtime,
    })
}

fn read_install_metadata_at(
    version: &Path,
    build_id: &str,
) -> Result<InstallMetadata, String> {
    let metadata_path = version.join("install.json");
    validate_regular_file(&metadata_path, "hmux_install_metadata_invalid")?;
    let metadata_size = fs::metadata(&metadata_path)
        .map_err(|_| "hmux_install_metadata_invalid: metadata is unreadable".to_string())?
        .len();
    if metadata_size > INSTALL_METADATA_LIMIT {
        return Err("hmux_install_metadata_invalid: metadata is too large".to_string());
    }
    let metadata: InstallMetadata = serde_json::from_reader(
        File::open(&metadata_path)
            .map_err(|_| "hmux_install_metadata_invalid: metadata is unreadable".to_string())?,
    )
    .map_err(|_| "hmux_install_metadata_invalid: metadata is malformed".to_string())?;
    if metadata.schema_version != 1 || metadata.build_id != build_id {
        return Err("hmux_install_metadata_invalid: build identity does not match".to_string());
    }
    Ok(metadata)
}

fn version_cli_at(install_root: &Path, build_id: &str) -> Result<Option<PathBuf>, String> {
    let build = validate_installed_build(install_root, build_id)?;
    let version = build
        .runtime
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "hmux_version_invalid: runtime has no version directory".to_string())?;
    let cli = version.join("bin").join(cli_file_name());
    if is_executable_regular_file(&cli) {
        Ok(Some(cli))
    } else {
        Ok(None)
    }
}

fn independent_install_health_at_with_timeout(
    build: &InstalledBuild,
    probe_timeout: Duration,
) -> IndependentInstallHealth {
    let Some(version) = build.runtime.parent().and_then(Path::parent) else {
        return IndependentInstallHealth::unavailable();
    };
    let Ok(metadata) = read_install_metadata_at(version, &build.build_id) else {
        return IndependentInstallHealth::unavailable();
    };
    let cli = version.join("bin").join(cli_file_name());
    let cli_available = is_executable_regular_file(&cli);
    let protocol_compatible = install_protocol_contains(&metadata.protocol, (1, 0));
    let health = assess_independent_install(
        metadata.activation_source.as_deref(),
        metadata.cli_available,
        cli_available,
        protocol_compatible,
    );
    if health.readiness != IndependentInstallReadiness::Ready {
        return health;
    }
    if !independent_install_paths_are_trusted(version, &build.runtime, &cli) {
        return with_unsafe_install(health);
    }
    match probe_pairing_cli_at(&cli, &build.build_id, probe_timeout) {
        Ok(true) => health,
        Ok(false) => with_missing_capability(health),
        Err(failure) => with_probe_failure(health, failure.stage()),
    }
}

fn cached_independent_install_health(build: &InstalledBuild) -> IndependentInstallHealth {
    let cache = INSTALL_HEALTH_CACHE.get_or_init(|| Mutex::new(None));
    cached_independent_install_health_using(cache, build, CAPABILITY_PROBE_TIMEOUT)
}

fn cached_independent_install_health_using(
    cache: &Mutex<Option<CachedInstallHealth>>,
    build: &InstalledBuild,
    probe_timeout: Duration,
) -> IndependentInstallHealth {
    let key = InstallHealthCacheKey {
        build_id: build.build_id.clone(),
        runtime: build.runtime.clone(),
    };
    let mut cache = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.as_ref().filter(|cached| cached.key == key) {
        return cached.health;
    }
    let health = independent_install_health_at_with_timeout(build, probe_timeout);
    if health.readiness != IndependentInstallReadiness::ProbeFailed {
        *cache = Some(CachedInstallHealth { key, health });
    }
    health
}

#[cfg(unix)]
fn independent_install_paths_are_trusted(version: &Path, runtime: &Path, cli: &Path) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let Some(versions) = version.parent() else {
        return false;
    };
    let Some(install_root) = versions.parent() else {
        return false;
    };
    let bin = version.join("bin");
    let directories = [install_root, versions, version, bin.as_path()];
    let files = [version.join("install.json"), runtime.to_path_buf(), cli.to_path_buf()];
    // SAFETY: geteuid takes no arguments and only reads the current process identity.
    let owner = unsafe { libc::geteuid() };
    directories.iter().all(|path| {
        fs::symlink_metadata(path).is_ok_and(|metadata| {
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == owner
                && metadata.permissions().mode() & 0o022 == 0
        })
    }) && files.iter().all(|path| {
        fs::symlink_metadata(path).is_ok_and(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == owner
                && metadata.nlink() == 1
                && metadata.permissions().mode() & 0o022 == 0
        })
    })
}

#[cfg(not(unix))]
fn independent_install_paths_are_trusted(_version: &Path, runtime: &Path, cli: &Path) -> bool {
    is_executable_regular_file(runtime) && is_executable_regular_file(cli)
}

fn probe_pairing_cli_at(
    cli: &Path,
    expected_build_id: &str,
    timeout: Duration,
) -> Result<bool, IndependentCliProbeFailure> {
    let mut command = CommandSpec::new(cli);
    command.arg("capabilities").arg("--json").clear_env();
    let output = bounded_process::run(&command, timeout, BUILD_INFO_LIMIT)
        .map_err(IndependentCliProbeFailure::Command)?;
    if output.exceeded_limit {
        return Err(IndependentCliProbeFailure::StdoutLimit);
    }
    if !output.status.success() {
        return Err(IndependentCliProbeFailure::ExitStatus);
    }
    let receipt: CliCapabilityReceipt = serde_json::from_slice(&output.stdout)
        .map_err(|_| IndependentCliProbeFailure::ReceiptDecode)?;
    if receipt.schema_version != 2 {
        return Err(IndependentCliProbeFailure::ReceiptSchema);
    }
    if receipt.build_info.build_id != expected_build_id
        || receipt.build_info.source != "hmux_cli"
    {
        return Err(IndependentCliProbeFailure::ReceiptIdentity);
    }
    if !install_protocol_contains(&receipt.build_info.protocol, (1, 0)) {
        return Err(IndependentCliProbeFailure::ReceiptProtocol);
    }
    Ok(receipt
        .capabilities
        .iter()
        .any(|capability| capability == PAIRING_CLI_CAPABILITY))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IndependentCliProbeFailure {
    Command(CommandFailure),
    ExitStatus,
    StdoutLimit,
    ReceiptDecode,
    ReceiptSchema,
    ReceiptIdentity,
    ReceiptProtocol,
}

impl IndependentCliProbeFailure {
    fn stage(self) -> &'static str {
        match self {
            Self::Command(failure) => failure.stage(),
            Self::ExitStatus => "exit_status",
            Self::StdoutLimit => "stdout_limit",
            Self::ReceiptDecode => "receipt_decode",
            Self::ReceiptSchema => "receipt_schema",
            Self::ReceiptIdentity => "receipt_identity",
            Self::ReceiptProtocol => "receipt_protocol",
        }
    }
}

fn activate_bundled_runtime_at(
    install_root: &Path,
    source: &Path,
    build_info_timeout: Duration,
) -> Result<InstalledBuild, String> {
    let info = inspect_runtime_at(source, build_info_timeout)?;
    info.require_app_sessions()?;
    fs::create_dir_all(install_root)
        .map_err(|_| "hmux_activation_failed: install root could not be created".to_string())?;
    validate_directory(install_root, "hmux_install_root_invalid")?;
    let versions = install_root.join("versions");
    fs::create_dir_all(&versions)
        .map_err(|_| "hmux_activation_failed: versions directory could not be created".to_string())?;
    validate_directory(&versions, "hmux_versions_invalid")?;

    let lock = MutationLock::acquire(install_root)?;
    let repairing_current = match fs::symlink_metadata(install_root.join("current")) {
        Ok(_) => match resolve_current_at(install_root) {
            Ok(installed) => {
                // Reobserve under the install lock: another app may have
                // already promoted a compatible independent runtime.
                if installed_supports_app_sessions(&installed, build_info_timeout)? {
                    drop(lock);
                    return Ok(installed);
                }
                false
            }
            Err(_) if safe_version_link(install_root, "current") => true,
            Err(error) => return Err(error),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => {
            return Err("hmux_current_invalid: current metadata is unreadable".to_string());
        }
    };
    let version = versions.join(&info.build_id);
    if fs::symlink_metadata(&version).is_ok() {
        let installed = validate_installed_build(install_root, &info.build_id)?;
        if !installed_supports_app_sessions(&installed, build_info_timeout)? {
            return Err("hmux_create_runtime_incompatible: immutable bundled version is incompatible".into());
        }
        if repairing_current {
            replace_version_link(install_root, "current", &info.build_id)?;
        } else {
            activate_current_symlink(install_root, &info.build_id)?;
        }
        drop(lock);
        return Ok(installed);
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = install_root.join(format!(".activate-{}-{nonce}", std::process::id()));
    let mut staging_guard = StagingGuard::new(staging.clone());
    fs::create_dir(&staging)
        .map_err(|_| "hmux_activation_failed: staging directory could not be created".to_string())?;
    fs::create_dir(staging.join("bin"))
        .map_err(|_| "hmux_activation_failed: staging bin could not be created".to_string())?;
    let runtime = staging.join("bin").join(runtime_file_name());
    fs::copy(source, &runtime)
        .map_err(|_| "hmux_activation_failed: bundled runtime could not be copied".to_string())?;
    make_executable(&runtime)?;
    let metadata = InstallMetadata {
        schema_version: 1,
        build_id: info.build_id.clone(),
        package_version: env!("CARGO_PKG_VERSION").to_string(),
        target_triple: format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
        protocol: info.protocol,
        activation_source: Some("local_bundled".to_string()),
        cli_available: Some(false),
    };
    let metadata_file = File::create(staging.join("install.json"))
        .map_err(|_| "hmux_activation_failed: install metadata could not be created".to_string())?;
    serde_json::to_writer_pretty(metadata_file, &metadata)
        .map_err(|_| "hmux_activation_failed: install metadata could not be written".to_string())?;
    fs::rename(&staging, &version)
        .map_err(|_| "hmux_activation_failed: immutable version could not be published".to_string())?;
    staging_guard.published = true;
    if repairing_current {
        replace_version_link(install_root, "current", &info.build_id)?;
    } else {
        activate_current_symlink(install_root, &info.build_id)?;
    }
    drop(lock);
    validate_installed_build(install_root, &info.build_id)
}

fn safe_version_link(install_root: &Path, link_name: &str) -> bool {
    let link = install_root.join(link_name);
    let Ok(metadata) = fs::symlink_metadata(&link) else {
        return false;
    };
    if !metadata.file_type().is_symlink() {
        return false;
    }
    let Ok(target) = fs::read_link(&link) else {
        return false;
    };
    let mut components = target.components();
    if components.next() != Some(Component::Normal("versions".as_ref())) {
        return false;
    }
    let Some(Component::Normal(build_component)) = components.next() else {
        return false;
    };
    components.next().is_none()
        && build_component
            .to_str()
            .is_some_and(safe_build_id)
}

fn bundled_runtime_candidates<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for variable in RUNTIME_OVERRIDE_ENVS {
        if let Some(path) = std::env::var_os(variable).filter(|path| !path.is_empty()) {
            candidates.push(PathBuf::from(path));
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join(runtime_file_name()));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(runtime_file_name()));
        candidates.push(resources.join("resources").join(runtime_file_name()));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "hmux-runtime-{}{}",
                env!("TAURI_ENV_TARGET_TRIPLE"),
                std::env::consts::EXE_SUFFIX
            )),
    );
    candidates
}

fn activate_current_symlink(install_root: &Path, build_id: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        let target = validate_installed_build(install_root, build_id)?;
        let current = match fs::symlink_metadata(install_root.join("current")) {
            Ok(_) => Some(resolve_current_at(install_root)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => {
                return Err("hmux_current_invalid: current metadata is unreadable".to_string());
            }
        };
        if current
            .as_ref()
            .is_some_and(|current| current.build_id == target.build_id)
        {
            return Ok(());
        }
        if let Some(current) = current {
            replace_version_link(install_root, "previous", &current.build_id)?;
        }
        replace_version_link(install_root, "current", build_id)
    }
    #[cfg(not(unix))]
    {
        let _ = (install_root, build_id);
        Err("hmux_activation_unsupported: current activation requires symlinks".to_string())
    }
}

#[cfg(unix)]
fn replace_version_link(
    install_root: &Path,
    link_name: &str,
    build_id: &str,
) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    if !safe_build_id(build_id) {
        return Err("hmux_activation_failed: build id is unsafe".to_string());
    }
    let temporary = install_root.join(format!(".{link_name}-{}", std::process::id()));
    match fs::symlink_metadata(&temporary) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            fs::remove_file(&temporary).map_err(|_| {
                format!("hmux_activation_failed: temporary {link_name} link is busy")
            })?;
        }
        Ok(_) => {
            return Err(format!(
                "hmux_activation_failed: temporary {link_name} path is unsafe"
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(format!(
                "hmux_activation_failed: temporary {link_name} path is unreadable"
            ));
        }
    }
    symlink(Path::new("versions").join(build_id), &temporary).map_err(|_| {
        format!("hmux_activation_failed: {link_name} link could not be created")
    })?;
    fs::rename(&temporary, install_root.join(link_name))
        .map_err(|_| format!("hmux_activation_failed: {link_name} link could not be activated"))
}

#[cfg(not(unix))]
fn replace_version_link(
    _install_root: &Path,
    _link_name: &str,
    _build_id: &str,
) -> Result<(), String> {
    Err("hmux_activation_unsupported: current activation requires symlinks".to_string())
}

fn protocol_contains(range: &VersionRange, selected: &ProtocolVersion) -> bool {
    let minimum = (range.minimum.major, range.minimum.minor);
    let maximum = (range.maximum.major, range.maximum.minor);
    let selected = (selected.major, selected.minor);
    minimum <= selected && selected <= maximum
}

fn validate_protocol(protocol: &InstallProtocol) -> Result<(), String> {
    let minimum = parse_protocol_version(&protocol.minimum)?;
    let maximum = parse_protocol_version(&protocol.maximum)?;
    if minimum > maximum {
        return Err("hmux_protocol_metadata_invalid: version range is inverted".to_string());
    }
    Ok(())
}

fn install_protocol_contains(protocol: &InstallProtocol, selected: (u16, u16)) -> bool {
    let Ok(minimum) = parse_protocol_version(&protocol.minimum) else {
        return false;
    };
    let Ok(maximum) = parse_protocol_version(&protocol.maximum) else {
        return false;
    };
    minimum <= selected && selected <= maximum
}

fn parse_protocol_version(value: &str) -> Result<(u16, u16), String> {
    let (major, minor) = value
        .split_once('.')
        .ok_or_else(|| "hmux_protocol_metadata_invalid: version is malformed".to_string())?;
    let major = major
        .parse()
        .map_err(|_| "hmux_protocol_metadata_invalid: version is malformed".to_string())?;
    let minor = minor
        .parse()
        .map_err(|_| "hmux_protocol_metadata_invalid: version is malformed".to_string())?;
    Ok((major, minor))
}

fn safe_build_id(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn validate_directory(path: &Path, code: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| format!("{code}: directory is unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{code}: path is not a real directory"));
    }
    Ok(())
}

fn validate_regular_file(path: &Path, code: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| format!("{code}: file is unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{code}: path is not a regular file"));
    }
    Ok(())
}

fn runtime_file_name() -> String {
    format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX)
}

fn cli_file_name() -> String {
    format!("hmux{}", std::env::consts::EXE_SUFFIX)
}

fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && executable_metadata(&metadata))
        .unwrap_or(false)
}

fn is_executable_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && executable_metadata(&metadata)
        })
        .unwrap_or(false)
}

#[cfg(unix)]
fn executable_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable_metadata(_metadata: &fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|_| "hmux_activation_failed: runtime metadata is unavailable".to_string())?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|_| "hmux_activation_failed: runtime could not be made executable".to_string())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

struct MutationLock {
    path: PathBuf,
}

impl MutationLock {
    fn acquire(install_root: &Path) -> Result<Self, String> {
        let path = install_root.join(".mutation-lock");
        fs::create_dir(&path)
            .map_err(|_| "hmux_activation_busy: another install or prune is active".to_string())?;
        Ok(Self { path })
    }
}

impl Drop for MutationLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

struct StagingGuard {
    path: PathBuf,
    published: bool,
}

impl StagingGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::TempDir;

    const FIXTURE_OPERATION_TIMEOUT: Duration = Duration::from_secs(20);
    const FIXTURE_READY_TIMEOUT: Duration = Duration::from_secs(10);

    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[cfg(unix)]
    use std::process::Command as StdCommand;

    #[cfg(unix)]
    pub(super) fn installed_build(root: &Path, build_id: &str, with_cli: bool) {
        let bin = root.join("versions").join(build_id).join("bin");
        fs::create_dir_all(&bin).unwrap();
        let runtime = bin.join(runtime_file_name());
        fs::write(&runtime, b"runtime").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        if with_cli {
            let cli = bin.join(cli_file_name());
            fs::write(&cli, b"cli").unwrap();
            fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            root.join("versions").join(build_id).join("install.json"),
            serde_json::to_vec(&InstallMetadata {
                schema_version: 1,
                build_id: build_id.to_string(),
                package_version: "0.1.0".to_string(),
                target_triple: "test".to_string(),
                protocol: InstallProtocol {
                    minimum: "1.0".to_string(),
                    maximum: "1.0".to_string(),
                },
                activation_source: None,
                cli_available: Some(with_cli),
            })
            .unwrap(),
        )
        .unwrap();
    }

    #[cfg(unix)]
    fn write_cli_script(root: &Path, build_id: &str, script: &[u8]) {
        let cli = root
            .join("versions")
            .join(build_id)
            .join("bin")
            .join(cli_file_name());
        fs::write(&cli, script).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    fn mark_independent_install(root: &Path, build_id: &str, cli_available: bool) {
        let version = root.join("versions").join(build_id);
        let mut metadata: InstallMetadata = serde_json::from_slice(
            &fs::read(version.join("install.json")).unwrap(),
        )
        .unwrap();
        metadata.activation_source = Some(
            super::super::runtime_install_health::INDEPENDENT_INSTALLER_SOURCE.to_string(),
        );
        metadata.cli_available = Some(cli_available);
        fs::write(
            version.join("install.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
    }

    #[cfg(unix)]
    fn pairing_capability_script(build_id: &str, capabilities: &[&str]) -> Vec<u8> {
        capability_receipt_script(build_id, 2, "1.0", capabilities)
    }

    #[cfg(unix)]
    fn capability_receipt_script(
        build_id: &str,
        schema_version: u16,
        protocol: &str,
        capabilities: &[&str],
    ) -> Vec<u8> {
        let receipt = serde_json::json!({
            "schemaVersion": schema_version,
            "buildInfo": {
                "buildId": build_id,
                "source": "hmux_cli",
                "protocol": { "minimum": protocol, "maximum": protocol },
            },
            "capabilities": capabilities,
        });
        format!(
            "#!/bin/sh\nprintf '%s' '{}'\n",
            serde_json::to_string(&receipt).unwrap()
        )
        .into_bytes()
    }

    #[cfg(unix)]
    fn barrier_script(body: &str) -> Vec<u8> {
        format!(
            "#!/bin/sh\n\
             : > \"$0.ready\"\n\
             while [ ! -f \"$0.release\" ]; do /bin/sleep 0.01; done\n\
             {body}\n"
        )
        .into_bytes()
    }

    #[cfg(unix)]
    fn fixture_marker(executable: &Path, suffix: &str) -> PathBuf {
        let mut marker = executable.as_os_str().to_os_string();
        marker.push(suffix);
        PathBuf::from(marker)
    }

    #[cfg(unix)]
    fn remove_fixture_marker(marker: &Path) {
        match fs::remove_file(marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!(
                "fixture marker could not be removed ({}): {error}",
                marker.display()
            ),
        }
    }

    #[cfg(unix)]
    fn run_after_fixture_ready<T: Send>(
        executable: &Path,
        operation: impl FnOnce() -> T + Send,
    ) -> T {
        run_after_fixture_ready_with_hold(executable, Duration::ZERO, operation)
    }

    #[cfg(unix)]
    fn run_after_fixture_ready_with_hold<T: Send>(
        executable: &Path,
        hold: Duration,
        operation: impl FnOnce() -> T + Send,
    ) -> T {
        let ready = fixture_marker(executable, ".ready");
        let release = fixture_marker(executable, ".release");
        remove_fixture_marker(&ready);
        remove_fixture_marker(&release);

        std::thread::scope(|scope| {
            let worker = scope.spawn(operation);
            let deadline = Instant::now() + FIXTURE_READY_TIMEOUT;
            while !ready.is_file() {
                if worker.is_finished() {
                    let _ = worker.join().unwrap();
                    panic!(
                        "fixture operation finished before readiness: {}",
                        ready.display()
                    );
                }
                if Instant::now() >= deadline {
                    fs::write(&release, b"release").unwrap();
                    let _ = worker.join();
                    panic!("fixture did not report readiness: {}", ready.display());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::sleep(hold);
            fs::write(&release, b"release").unwrap();
            worker.join().unwrap()
        })
    }

    #[cfg(unix)]
    #[test]
    fn current_resolution_requires_one_safe_immutable_version() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "build-1", true);
        symlink("versions/build-1", temp.path().join("current")).unwrap();

        let resolved = resolve_current_at(temp.path()).unwrap();

        assert_eq!(resolved.build_id, "build-1");
        assert_eq!(
            resolved.runtime,
            temp.path()
                .join("versions/build-1/bin")
                .join(runtime_file_name())
        );
    }

    #[cfg(unix)]
    #[test]
    fn current_resolution_rejects_traversal_and_symlinked_binary() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "build-1", true);
        symlink("versions/../versions/build-1", temp.path().join("current")).unwrap();
        assert!(resolve_current_at(temp.path()).is_err());

        fs::remove_file(temp.path().join("current")).unwrap();
        symlink("versions/build-1", temp.path().join("current")).unwrap();
        let runtime = temp
            .path()
            .join("versions/build-1/bin")
            .join(runtime_file_name());
        fs::remove_file(&runtime).unwrap();
        symlink("/bin/sh", &runtime).unwrap();
        assert!(resolve_current_at(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn external_cli_selection_rejects_unsafe_build_and_symlink() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "old-build", true);
        assert!(version_cli_at(temp.path(), "../old-build").is_err());
        assert!(version_cli_at(temp.path(), "old-build").unwrap().is_some());

        let cli = temp
            .path()
            .join("versions/old-build/bin")
            .join(cli_file_name());
        fs::remove_file(&cli).unwrap();
        symlink("/bin/sh", &cli).unwrap();
        assert!(version_cli_at(temp.path(), "old-build").unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn version_matched_probe_validates_the_exact_session_identity() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "old-build", true);
        let cli = temp
            .path()
            .join("versions/old-build/bin")
            .join(cli_file_name());
        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script(
                r#"
[ -z "$CODEX_HOME$OPENAI_API_KEY$ANTHROPIC_API_KEY" ] || exit 9
printf '%s' '{"schemaVersion":1,"sessionId":"session-1","workspaceId":"workspace-1","status":"healthy"}'
"#,
            ),
        );

        assert_eq!(
            run_after_fixture_ready(&cli, || {
                probe_with_version_cli_at(
                    temp.path(),
                    "old-build",
                    Path::new("/tmp/discovery"),
                    "session-1",
                    "workspace-1",
                    FIXTURE_OPERATION_TIMEOUT,
                )
            })
            .unwrap(),
            ExternalProbeStatus::Healthy
        );
        assert!(
            run_after_fixture_ready(&cli, || {
                probe_with_version_cli_at(
                    temp.path(),
                    "old-build",
                    Path::new("/tmp/discovery"),
                    "different-session",
                    "workspace-1",
                    FIXTURE_OPERATION_TIMEOUT,
                )
            })
            .unwrap_err()
            .starts_with("hmux_external_cli_invalid")
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_matched_probe_accepts_old_and_documented_unhealthy_exit_semantics() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "old-build", true);
        let cli = temp
            .path()
            .join("versions/old-build/bin")
            .join(cli_file_name());
        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script(
                r#"
printf '%s' '{"schemaVersion":1,"sessionId":"session-1","workspaceId":"workspace-1","status":"stale_transport"}'
exit 0
"#,
            ),
        );
        assert_eq!(
            run_after_fixture_ready(&cli, || {
                probe_with_version_cli_at(
                    temp.path(),
                    "old-build",
                    Path::new("/tmp/discovery"),
                    "session-1",
                    "workspace-1",
                    FIXTURE_OPERATION_TIMEOUT,
                )
            })
            .unwrap(),
            ExternalProbeStatus::StaleTransport
        );

        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script(
                r#"
printf '%s' '{"schemaVersion":1,"ok":false,"sessionId":"session-1","workspaceId":"workspace-1","status":"incompatible_protocol"}'
exit 1
"#,
            ),
        );
        assert_eq!(
            run_after_fixture_ready(&cli, || {
                probe_with_version_cli_at(
                    temp.path(),
                    "old-build",
                    Path::new("/tmp/discovery"),
                    "session-1",
                    "workspace-1",
                    FIXTURE_OPERATION_TIMEOUT,
                )
            })
            .unwrap(),
            ExternalProbeStatus::IncompatibleProtocol
        );

        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script(
                r#"
printf '%s' '{"schemaVersion":1,"sessionId":"session-1","workspaceId":"workspace-1","status":"healthy"}'
exit 1
"#,
            ),
        );
        assert_eq!(
            run_after_fixture_ready(&cli, || {
                probe_with_version_cli_at(
                    temp.path(),
                    "old-build",
                    Path::new("/tmp/discovery"),
                    "session-1",
                    "workspace-1",
                    FIXTURE_OPERATION_TIMEOUT,
                )
            })
            .unwrap_err(),
            "hmux_external_cli_invalid: legacy probe receipt used an unsuccessful exit"
        );

        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script(
                r#"
printf '%s' '{"schemaVersion":1,"ok":false,"sessionId":"session-1","workspaceId":"workspace-1","status":"healthy"}'
"#,
            ),
        );
        assert_eq!(
            run_after_fixture_ready(&cli, || {
                probe_with_version_cli_at(
                    temp.path(),
                    "old-build",
                    Path::new("/tmp/discovery"),
                    "session-1",
                    "workspace-1",
                    FIXTURE_OPERATION_TIMEOUT,
                )
            })
            .unwrap_err(),
            "hmux_external_cli_invalid: probe receipt success marker is inconsistent"
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_matched_snapshot_is_bounded_and_identity_checked() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "old-build", true);
        let cli = temp
            .path()
            .join("versions/old-build/bin")
            .join(cli_file_name());
        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script(
                r#"
printf '%s' '{"schemaVersion":1,"sessionId":"session-1","workspaceId":"workspace-1","terminalEpoch":"epoch-1","sequenceThrough":"8","rows":24,"columns":80,"data":"b2s=","alternateScreen":false,"cursorVisible":true,"truncated":false}'
"#,
            ),
        );

        let snapshot = run_after_fixture_ready(&cli, || {
            snapshot_with_version_cli_at(
                temp.path(),
                "old-build",
                Path::new("/tmp/discovery"),
                "session-1",
                "workspace-1",
                FIXTURE_OPERATION_TIMEOUT,
            )
        })
        .unwrap();

        assert_eq!(snapshot.terminal_epoch, "epoch-1");
        assert_eq!(snapshot.data, "b2s=");
    }

    #[cfg(unix)]
    #[test]
    fn version_matched_cli_is_killed_after_the_bounded_timeout() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "old-build", true);
        write_cli_script(temp.path(), "old-build", b"#!/bin/sh\nwhile :; do :; done\n");
        let error = probe_with_version_cli_at(
            temp.path(),
            "old-build",
            Path::new("/tmp/discovery"),
            "session-1",
            "workspace-1",
            Duration::from_millis(30),
        )
        .unwrap_err();

        assert_eq!(
            error,
            "hmux_external_cli_timeout: version-matched CLI timed out; stage=process_exit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_matched_cli_preserves_status_precedence_for_oversized_output() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "old-build", true);
        let cli = temp
            .path()
            .join("versions/old-build/bin")
            .join(cli_file_name());
        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script("/usr/bin/yes x || exit 0"),
        );

        let oversized = run_after_fixture_ready(&cli, || {
            run_version_cli_at(
                temp.path(),
                "old-build",
                Path::new("/tmp/discovery"),
                &[],
                FIXTURE_OPERATION_TIMEOUT,
                false,
            )
        })
        .unwrap_err();
        assert_eq!(
            oversized,
            "hmux_external_cli_invalid: CLI output is too large"
        );

        write_cli_script(
            temp.path(),
            "old-build",
            &barrier_script("/usr/bin/yes x; exit 7"),
        );
        let rejected = run_after_fixture_ready(&cli, || {
            run_version_cli_at(
                temp.path(),
                "old-build",
                Path::new("/tmp/discovery"),
                &[],
                FIXTURE_OPERATION_TIMEOUT,
                false,
            )
        })
        .unwrap_err();
        assert_eq!(
            rejected,
            "hmux_external_cli_failed: version-matched CLI rejected the request"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolution_rejects_symlinked_install_root_and_bin_directory() {
        let temp = TempDir::new().unwrap();
        let install_root = temp.path().join("install");
        installed_build(&install_root, "old-build", true);
        symlink("versions/old-build", install_root.join("current")).unwrap();
        let linked_root = temp.path().join("linked-install");
        symlink(&install_root, &linked_root).unwrap();
        assert!(resolve_current_at(&linked_root).is_err());

        let bin = install_root.join("versions/old-build/bin");
        let escaped_bin = temp.path().join("escaped-bin");
        fs::rename(&bin, &escaped_bin).unwrap();
        symlink(&escaped_bin, &bin).unwrap();
        assert!(resolve_current_at(&install_root).is_err());
        assert!(version_cli_at(&install_root, "old-build").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn bundled_runtime_is_activated_as_an_immutable_current_build() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("bundled-hmux-runtime");
        fs::write(
            &source,
            barrier_script(
                "printf '%s' '{\"schemaVersion\":1,\"buildId\":\"bundled-1\",\"protocol\":{\"minimum\":\"1.0\",\"maximum\":\"1.0\"},\"capabilities\":[\"managed_create_v6\",\"standalone_request_bound_create_v1\",\"agent_state_report_causality_v1\"]}'",
            ),
        )
        .unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        let install_root = temp.path().join("install");

        let activated = run_after_fixture_ready(&source, || {
            activate_bundled_runtime_at(
                &install_root,
                &source,
                FIXTURE_OPERATION_TIMEOUT,
            )
        })
        .unwrap();

        assert_eq!(activated.build_id, "bundled-1");
        assert_eq!(
            fs::read_link(install_root.join("current")).unwrap(),
            PathBuf::from("versions/bundled-1")
        );
        assert!(activated.runtime.starts_with(install_root.join("versions/bundled-1")));
        assert!(!fs::symlink_metadata(&activated.runtime)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn bundled_runtime_repairs_a_safe_current_link_with_missing_metadata() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("bundled-hmux-runtime");
        fs::write(
            &source,
            barrier_script(
                "printf '%s' '{\"schemaVersion\":1,\"buildId\":\"bundled-1\",\"protocol\":{\"minimum\":\"1.0\",\"maximum\":\"1.0\"},\"capabilities\":[\"managed_create_v6\",\"standalone_request_bound_create_v1\",\"agent_state_report_causality_v1\"]}'",
            ),
        )
        .unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();

        let install_root = temp.path().join("install");
        installed_build(&install_root, "bundled-1", false);
        create_compatibility_tests::runtime_script(
            &install_root.join("versions/bundled-1/bin").join(runtime_file_name()),
            "bundled-1",
            create_compatibility_tests::APP_CAPABILITIES,
        );
        fs::create_dir_all(install_root.join("versions/broken-current/bin")).unwrap();
        symlink(
            "versions/broken-current",
            install_root.join("current"),
        )
        .unwrap();

        let activated = run_after_fixture_ready(&source, || {
            activate_bundled_runtime_at(
                &install_root,
                &source,
                FIXTURE_OPERATION_TIMEOUT,
            )
        })
        .unwrap();

        assert_eq!(activated.build_id, "bundled-1");
        assert_eq!(
            fs::read_link(install_root.join("current")).unwrap(),
            PathBuf::from("versions/bundled-1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn bundled_runtime_does_not_repair_an_unsafe_current_link() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("bundled-hmux-runtime");
        fs::write(
            &source,
            barrier_script(
                "printf '%s' '{\"schemaVersion\":1,\"buildId\":\"bundled-1\",\"protocol\":{\"minimum\":\"1.0\",\"maximum\":\"1.0\"},\"capabilities\":[\"managed_create_v6\",\"standalone_request_bound_create_v1\",\"agent_state_report_causality_v1\"]}'",
            ),
        )
        .unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();

        let install_root = temp.path().join("install");
        installed_build(&install_root, "bundled-1", false);
        symlink("../outside", install_root.join("current")).unwrap();

        let error = run_after_fixture_ready(&source, || {
            activate_bundled_runtime_at(
                &install_root,
                &source,
                FIXTURE_OPERATION_TIMEOUT,
            )
        })
        .unwrap_err();

        assert!(error.starts_with("hmux_current_invalid:"));
        assert_eq!(
            fs::read_link(install_root.join("current")).unwrap(),
            PathBuf::from("../outside")
        );
    }

    #[cfg(unix)]
    #[test]
    fn qa_bundled_runtime_allows_a_loaded_but_valid_build_info_probe() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("bundled-hmux-runtime");
        fs::write(
            &source,
            barrier_script(
                "printf '%s' '{\"schemaVersion\":1,\"buildId\":\"loaded-valid\",\"protocol\":{\"minimum\":\"1.0\",\"maximum\":\"1.0\"},\"capabilities\":[\"managed_create_v6\",\"standalone_request_bound_create_v1\",\"agent_state_report_causality_v1\"]}'",
            ),
        )
        .unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        let install_root = temp.path().join("install");

        let activated = run_after_fixture_ready_with_hold(
            &source,
            Duration::from_millis(2_250),
            || {
                activate_bundled_runtime_at(
                    &install_root,
                    &source,
                    QA_BUILD_INFO_TIMEOUT,
                )
            },
        )
        .unwrap();

        assert_eq!(activated.build_id, "loaded-valid");
    }

    #[cfg(unix)]
    #[test]
    fn bundled_runtime_timeout_identifies_the_process_exit_stage() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("bundled-hmux-runtime");
        fs::write(&source, b"#!/bin/sh\nwhile :; do :; done\n").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            inspect_runtime_at(&source, Duration::from_millis(30)).unwrap_err(),
            "hmux_bundled_runtime_timeout: build info probe timed out; stage=process_exit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn activation_records_previous_and_rollback_is_reversible() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "build-a", true);
        installed_build(temp.path(), "build-b", true);
        symlink("versions/build-a", temp.path().join("current")).unwrap();

        activate_current_symlink(temp.path(), "build-b").unwrap();
        assert_eq!(resolve_current_at(temp.path()).unwrap().build_id, "build-b");
        assert_eq!(
            resolve_version_link_at(temp.path(), "previous", "previous")
                .unwrap()
                .build_id,
            "build-a"
        );

        let rolled_back = rollback_current_at(temp.path()).unwrap();
        assert_eq!(rolled_back.build_id, "build-a");
        assert_eq!(
            resolve_version_link_at(temp.path(), "previous", "previous")
                .unwrap()
                .build_id,
            "build-b"
        );
    }

    #[cfg(unix)]
    #[test]
    fn invalid_rollback_or_activation_preserves_current() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "build-a", true);
        installed_build(temp.path(), "build-b", true);
        symlink("versions/build-a", temp.path().join("current")).unwrap();
        activate_current_symlink(temp.path(), "build-b").unwrap();

        fs::remove_file(temp.path().join("previous")).unwrap();
        symlink("../outside", temp.path().join("previous")).unwrap();
        assert!(rollback_current_at(temp.path()).is_err());
        assert_eq!(resolve_current_at(temp.path()).unwrap().build_id, "build-b");

        assert!(activate_current_symlink(temp.path(), "missing-build").is_err());
        assert_eq!(resolve_current_at(temp.path()).unwrap().build_id, "build-b");
    }

    #[cfg(unix)]
    #[test]
    fn independent_cli_requires_exact_build_protocol_and_pairing_capability() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "independent-1", true);
        mark_independent_install(temp.path(), "independent-1", true);
        write_cli_script(
            temp.path(),
            "independent-1",
            &pairing_capability_script("independent-1", &[PAIRING_CLI_CAPABILITY]),
        );
        symlink("versions/independent-1", temp.path().join("current")).unwrap();

        let selected = resolve_independent_cli_at_with_timeout(
            temp.path(),
            FIXTURE_OPERATION_TIMEOUT,
        )
            .unwrap()
            .expect("compatible independent CLI");
        let current = resolve_current_at(temp.path()).unwrap();
        assert_eq!(
            independent_install_health_at_with_timeout(
                &current,
                FIXTURE_OPERATION_TIMEOUT,
            )
            .readiness,
            IndependentInstallReadiness::Ready
        );
        assert_eq!(
            selected,
            temp.path().join("versions/independent-1/bin").join(cli_file_name())
        );

        write_cli_script(
            temp.path(),
            "independent-1",
            &pairing_capability_script("another-build", &[PAIRING_CLI_CAPABILITY]),
        );
        assert_eq!(
            resolve_independent_cli_at_with_timeout(
                temp.path(),
                FIXTURE_OPERATION_TIMEOUT,
            )
            .unwrap_err(),
            "hmux_independent_install_invalid: hmux_independent_install_probe_failed; stage=receipt_identity"
        );
    }

    #[cfg(unix)]
    #[test]
    fn independent_cli_probe_preserves_bounded_failure_stage() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "blocked-probe", true);
        mark_independent_install(temp.path(), "blocked-probe", true);
        write_cli_script(
            temp.path(),
            "blocked-probe",
            b"#!/bin/sh\nwhile :; do :; done\n",
        );
        symlink("versions/blocked-probe", temp.path().join("current")).unwrap();

        assert_eq!(
            resolve_independent_cli_at_with_timeout(
                temp.path(),
                Duration::from_millis(30),
            )
            .unwrap_err(),
            "hmux_independent_install_invalid: hmux_independent_install_probe_failed; stage=process_exit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn independent_cli_probe_classifies_each_failure_stage() {
        assert_eq!(CAPABILITY_PROBE_TIMEOUT, Duration::from_secs(5));

        let temp = TempDir::new().unwrap();
        let cli = temp.path().join("hmux-probe");
        let probe_with_timeout = |script: &[u8], timeout| {
            fs::write(&cli, script).unwrap();
            fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
            probe_pairing_cli_at(&cli, "expected-build", timeout)
        };
        let probe = |script: &[u8]| probe_with_timeout(script, FIXTURE_OPERATION_TIMEOUT);

        assert_eq!(
            probe_pairing_cli_at(
                &cli,
                "expected-build",
                FIXTURE_OPERATION_TIMEOUT,
            ),
            Err(IndependentCliProbeFailure::Command(CommandFailure::Spawn))
        );
        assert_eq!(
            probe(b"#!/bin/sh\nexit 7\n"),
            Err(IndependentCliProbeFailure::ExitStatus)
        );
        assert!(matches!(
            probe_with_timeout(
                b"#!/bin/sh\nwhile :; do sleep 1; done\n",
                Duration::from_millis(50),
            ),
            Err(IndependentCliProbeFailure::Command(
                CommandFailure::Timeout(_)
            ))
        ));

        let oversized = format!(
            "#!/bin/sh\nprintf '%s' '{}'\n",
            "x".repeat(BUILD_INFO_LIMIT + 1)
        );
        assert_eq!(
            probe(oversized.as_bytes()),
            Err(IndependentCliProbeFailure::StdoutLimit)
        );
        assert_eq!(
            probe(b"#!/bin/sh\nprintf '%s' 'not-json'\n"),
            Err(IndependentCliProbeFailure::ReceiptDecode)
        );
        assert_eq!(
            probe(&capability_receipt_script(
                "expected-build",
                1,
                "1.0",
                &[PAIRING_CLI_CAPABILITY],
            )),
            Err(IndependentCliProbeFailure::ReceiptSchema)
        );
        assert_eq!(
            probe(&pairing_capability_script(
                "another-build",
                &[PAIRING_CLI_CAPABILITY],
            )),
            Err(IndependentCliProbeFailure::ReceiptIdentity)
        );
        assert_eq!(
            probe(&capability_receipt_script(
                "expected-build",
                2,
                "2.0",
                &[PAIRING_CLI_CAPABILITY],
            )),
            Err(IndependentCliProbeFailure::ReceiptProtocol)
        );
        assert_eq!(
            probe(&pairing_capability_script(
                "expected-build",
                &["session_liveness_v1"],
            )),
            Ok(false)
        );
    }

    #[cfg(unix)]
    #[test]
    fn independent_installer_output_is_immediately_ready_under_group_umask() {
        let temp = TempDir::new().unwrap();
        let build_id = "0.1.4+installer-readiness";
        let artifacts = temp.path().join("artifacts");
        let install_root = temp.path().join("install");
        let commands = temp.path().join("commands");
        fs::create_dir_all(&artifacts).unwrap();
        let cli_source = artifacts.join(cli_file_name());
        fs::write(
            &cli_source,
            pairing_capability_script(build_id, &[PAIRING_CLI_CAPABILITY]),
        )
        .unwrap();
        fs::set_permissions(&cli_source, fs::Permissions::from_mode(0o755)).unwrap();
        let runtime_source = artifacts.join(runtime_file_name());
        fs::write(
            &runtime_source,
            b"#!/bin/sh\nprintf '%s\\n' '{\"productProfile\":\"structured-terminal-v1\"}'\n",
        )
        .unwrap();
        fs::set_permissions(&runtime_source, fs::Permissions::from_mode(0o755)).unwrap();
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has the repository as its parent");
        let installer = repository.join("scripts/install-hmux.sh");
        let run_installer = || {
            StdCommand::new("sh")
                .arg("-c")
                .arg("umask 002; exec sh \"$1\"")
                .arg("hmux-install")
                .arg(&installer)
                .current_dir(repository)
                .env("CARGO_BUILD_TARGET", "test-target")
                .env("HMUX_ARTIFACT_DIR", &artifacts)
                .env("HMUX_BUILD_ID", build_id)
                .env("HMUX_INSTALL_DIR", &commands)
                .env("HMUX_INSTALL_ROOT", &install_root)
                .env("HMUX_PROFILE", "release")
                .env("HMUX_SKIP_BUILD", "1")
                .env_remove("HMUX_PREBUILT_DIR")
                .env_remove("HMUX_EXPECTED_DIGEST")
                .output()
                .unwrap()
        };

        let first_install = run_installer();
        assert!(
            first_install.status.success(),
            "installer failed: {}",
            String::from_utf8_lossy(&first_install.stderr)
        );
        let installed_cli = install_root
            .join("versions")
            .join(build_id)
            .join("bin")
            .join(cli_file_name());
        let capability_output = StdCommand::new(&installed_cli)
            .arg("capabilities")
            .arg("--json")
            .env_clear()
            .output()
            .unwrap();
        assert!(
            capability_output.status.success(),
            "installed CLI capability probe failed: {}",
            String::from_utf8_lossy(&capability_output.stderr)
        );
        assert!(
            serde_json::from_slice::<CliCapabilityReceipt>(&capability_output.stdout).is_ok(),
            "installed CLI capability output is invalid: {}",
            String::from_utf8_lossy(&capability_output.stdout)
        );
        let selected = resolve_independent_cli_at_with_timeout(
            &install_root,
            FIXTURE_OPERATION_TIMEOUT,
        )
            .unwrap()
            .expect("fresh independent install is pairing-ready");
        assert_eq!(selected, installed_cli);

        let version = install_root.join("versions").join(build_id);
        let trust_paths = [
            install_root.clone(),
            install_root.join("versions"),
            version.clone(),
            version.join("bin"),
            version.join("install.json"),
            version.join("bin").join(cli_file_name()),
            version.join("bin").join(runtime_file_name()),
        ];
        for path in &trust_paths[2..4] {
            let mode = fs::metadata(path).unwrap().permissions().mode();
            fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o022)).unwrap();
        }
        let repaired_install = run_installer();
        assert!(
            repaired_install.status.success(),
            "directory repair failed: {}",
            String::from_utf8_lossy(&repaired_install.stderr)
        );
        assert!(trust_paths.iter().all(|path| {
            fs::metadata(path).unwrap().permissions().mode() & 0o022 == 0
        }));
        let current = resolve_current_at(&install_root).unwrap();
        assert_eq!(
            independent_install_health_at_with_timeout(
                &current,
                FIXTURE_OPERATION_TIMEOUT,
            )
            .readiness,
            IndependentInstallReadiness::Ready
        );

        let installed_cli_mode = fs::metadata(&installed_cli).unwrap().permissions().mode();
        fs::set_permissions(
            &installed_cli,
            fs::Permissions::from_mode(installed_cli_mode | 0o022),
        )
        .unwrap();
        let unsafe_reinstall = run_installer();
        assert!(
            !unsafe_reinstall.status.success(),
            "writable immutable CLI was unexpectedly accepted"
        );
        assert!(
            String::from_utf8_lossy(&unsafe_reinstall.stderr)
                .contains("refusing unsafe immutable Hmux build"),
            "unexpected installer failure: {}",
            String::from_utf8_lossy(&unsafe_reinstall.stderr)
        );
        assert_eq!(
            fs::metadata(&installed_cli).unwrap().permissions().mode() & 0o022,
            0o022
        );
    }

    #[cfg(unix)]
    #[test]
    fn census_reuses_a_successful_probe_for_one_immutable_build_path() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "cached-1", true);
        mark_independent_install(temp.path(), "cached-1", true);
        let count = temp.path().join("probe-count");
        let receipt = String::from_utf8(pairing_capability_script(
            "cached-1",
            &[PAIRING_CLI_CAPABILITY],
        ))
        .unwrap();
        let script = format!(
            "#!/bin/sh\nprintf 'x\\n' >> '{}'\n{}",
            count.display(),
            receipt.strip_prefix("#!/bin/sh\n").unwrap()
        );
        write_cli_script(temp.path(), "cached-1", script.as_bytes());
        symlink("versions/cached-1", temp.path().join("current")).unwrap();
        let current = resolve_current_at(temp.path()).unwrap();
        let cache = Mutex::new(None);

        assert_eq!(
            cached_independent_install_health_using(
                &cache,
                &current,
                FIXTURE_OPERATION_TIMEOUT,
            )
            .readiness,
            IndependentInstallReadiness::Ready
        );
        assert_eq!(
            cached_independent_install_health_using(
                &cache,
                &current,
                FIXTURE_OPERATION_TIMEOUT,
            )
            .readiness,
            IndependentInstallReadiness::Ready
        );
        assert_eq!(fs::read_to_string(count).unwrap(), "x\n");
    }

    #[cfg(unix)]
    #[test]
    fn capability_incomplete_independent_install_fails_closed() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "legacy-1", true);
        write_cli_script(
            temp.path(),
            "legacy-1",
            &pairing_capability_script("legacy-1", &["session_liveness_v1"]),
        );
        symlink("versions/legacy-1", temp.path().join("current")).unwrap();
        assert_eq!(
            resolve_independent_cli_at_with_timeout(
                temp.path(),
                FIXTURE_OPERATION_TIMEOUT,
            )
            .unwrap_err(),
            "hmux_independent_install_invalid: hmux_independent_install_pairing_capability_unavailable"
        );

        mark_independent_install(temp.path(), "legacy-1", true);
        assert_eq!(
            resolve_independent_cli_at_with_timeout(
                temp.path(),
                FIXTURE_OPERATION_TIMEOUT,
            )
            .unwrap_err(),
            "hmux_independent_install_invalid: hmux_independent_install_pairing_capability_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_runtime_only_legacy_install_keeps_the_transitional_bundle_fallback() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "runtime-only-1", false);
        symlink("versions/runtime-only-1", temp.path().join("current")).unwrap();

        assert_eq!(resolve_independent_cli_at(temp.path()).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn declared_cli_mismatch_is_corruption_not_a_bundle_fallback() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "inconsistent-1", true);
        mark_independent_install(temp.path(), "inconsistent-1", false);
        symlink("versions/inconsistent-1", temp.path().join("current")).unwrap();

        assert_eq!(
            resolve_independent_cli_at(temp.path()).unwrap_err(),
            "hmux_independent_install_invalid: hmux_independent_install_metadata_inconsistent"
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_independent_cli_is_rejected_before_its_capability_probe() {
        let temp = TempDir::new().unwrap();
        installed_build(temp.path(), "writable-1", true);
        mark_independent_install(temp.path(), "writable-1", true);
        let cli = temp
            .path()
            .join("versions/writable-1/bin")
            .join(cli_file_name());
        write_cli_script(
            temp.path(),
            "writable-1",
            &pairing_capability_script("writable-1", &[PAIRING_CLI_CAPABILITY]),
        );
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o777)).unwrap();
        symlink("versions/writable-1", temp.path().join("current")).unwrap();

        assert_eq!(
            resolve_independent_cli_at(temp.path()).unwrap_err(),
            "hmux_independent_install_invalid: hmux_independent_install_permissions_unsafe"
        );
    }

    #[test]
    fn inverted_install_protocol_range_is_rejected() {
        assert_eq!(
            validate_protocol(&InstallProtocol {
                minimum: "2.0".to_string(),
                maximum: "1.0".to_string(),
            })
            .unwrap_err(),
            "hmux_protocol_metadata_invalid: version range is inverted"
        );
    }

    #[test]
    fn direct_client_is_preferred_when_protocol_one_is_compatible() {
        let range = VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 2, minor: 0 },
        };
        assert!(protocol_contains(
            &range,
            &ProtocolVersion { major: 1, minor: 0 }
        ));
    }
}
