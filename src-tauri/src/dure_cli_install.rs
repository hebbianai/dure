mod commands;

pub(crate) use commands::resolve_channel_dure_payload;
#[cfg(unix)]
pub(crate) use commands::resolve_control_plane_companion;

use hebbian_bounded_process::CommandSpec;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_INSTALL_METADATA_BYTES: u64 = 16 * 1024;
const MAX_INSTALL_OUTPUT_BYTES: usize = 64 * 1024;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);
const BACKEND_RECONCILE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DureCliIdentity {
    version: String,
    digest: String,
    install_root: String,
    executable_path: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DureCliInstallState {
    Current,
    Outdated,
    Missing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DureCliInstallStatus {
    state: DureCliInstallState,
    installed: Option<DureCliIdentity>,
    available: DureCliIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMetadata {
    schema_version: u32,
    build_id: String,
    source_digest: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DureCliInstallScope {
    ChannelPinned,
    StableGlobal,
}

impl DureCliInstallScope {
    fn for_channel(channel: &str) -> Self {
        if channel == "stable" {
            Self::StableGlobal
        } else {
            Self::ChannelPinned
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DureCliInstallFailureReceipt {
    schema_version: u32,
    error: DureCliInstallFailure,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DureCliInstallFailure {
    code: String,
    message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DureChannelCommand {
    pub(crate) directory: PathBuf,
    pub(crate) executable: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendReconcileReceipt {
    schema_version: u32,
    api_version: String,
    kind: String,
    status: String,
    profile: BackendReconcileProfile,
    authority: BackendReconcileAuthority,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendReconcileProfile {
    id: String,
    source: String,
    transport_kind: String,
    #[serde(default)]
    managed_authority: Option<crate::dure_backend_transport::BackendProfile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendReconcileAuthority {
    backend_id: String,
    generation: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReconciledBackendAuthority {
    pub(crate) managed_authority: Option<crate::dure_backend_transport::BackendProfile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendReconcileError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

#[tauri::command(async)]
pub(crate) async fn dure_cli_install_status() -> Result<DureCliInstallStatus, String> {
    tauri::async_runtime::spawn_blocking(install_status_from_current_channel)
        .await
        .map_err(|error| format!("Dure CLI status task failed: {error}"))?
}

#[tauri::command(async)]
pub(crate) async fn install_dure_cli() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(install_from_current_channel)
        .await
        .map_err(|error| format!("Dure CLI install task failed: {error}"))?
}

pub(crate) fn prepare_startup_channel(channel: &str, resource_dir: &Path) -> Result<(), String> {
    if channel != "stable" {
        return Ok(());
    }
    let Some(bundle) = commands::startup_bundle(channel, resource_dir) else {
        return install_from_current_channel();
    };
    let home =
        dirs::home_dir().ok_or_else(|| "resolve home for Dure CLI bootstrap failed".to_string())?;
    let node = bundle.join("bin/node");
    validate_executable_file(&node, "bundled Dure Node runtime")?;
    let mut command = CommandSpec::new(node);
    command.arg(bundle.join("bin/lib/dure-cli-bootstrap.mjs"));
    command.arg(&home).arg(channel);
    let output = hebbian_bounded_process::run(&command, INSTALL_TIMEOUT, MAX_INSTALL_OUTPUT_BYTES)
        .map_err(|error| format!("run bundled Dure CLI bootstrap failed: {}", error.stage()))?;
    if output.exceeded_limit {
        return Err("Dure CLI bootstrap output exceeded its limit".to_string());
    }
    if !output.status.success() {
        return Err(format!("Dure CLI bootstrap exited with {}", output.status));
    }
    required_channel_cli(channel, &home)?;
    Ok(())
}

fn install_from_current_channel() -> Result<(), String> {
    let channel = crate::app_channel::current_name()
        .map_err(|error| format!("resolve Dure app channel failed: {error}"))?;
    let home =
        dirs::home_dir().ok_or_else(|| "resolve home for Dure CLI install failed".to_string())?;
    let cli = required_channel_cli(&channel, &home)?;
    read_cli_identity(&cli)?;
    if DureCliInstallScope::for_channel(&channel) == DureCliInstallScope::ChannelPinned {
        return Ok(());
    }
    let mut command = CommandSpec::new(cli);
    command.args(["install", "--global", "--json"]);
    let output = hebbian_bounded_process::run(
        &command,
        INSTALL_TIMEOUT,
        MAX_INSTALL_OUTPUT_BYTES,
    )
    .map_err(|error| format!("run Dure CLI installer failed: {}", error.stage()))?;
    if output.exceeded_limit {
        return Err("Dure CLI installer output exceeded its limit".to_string());
    }
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if let Some(message) = install_failure_message(&output.stdout) {
        format!("Dure CLI install failed: {message}")
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("Dure CLI installer exited with {}", output.status)
    })
}

pub(crate) fn reconcile_backend_from_current_channel(
    channel: &str,
    profile_id: Option<&str>,
) -> Result<ReconciledBackendAuthority, BackendReconcileError> {
    let fail = |code, message| BackendReconcileError { code, message };
    let home = dirs::home_dir().ok_or_else(|| {
        fail(
            "backend_reconcile_home_unavailable",
            "resolve home for Dure backend reconciliation failed".into(),
        )
    })?;
    let cli = required_channel_cli(channel, &home)
        .map_err(|message| fail("backend_reconcile_cli_unavailable", message))?;
    let command = backend_reconcile_command(&cli, channel, profile_id)?;
    let output = hebbian_bounded_process::run(
        &command,
        BACKEND_RECONCILE_TIMEOUT,
        MAX_INSTALL_OUTPUT_BYTES,
    )
    .map_err(|error| {
        fail(
            "backend_reconcile_process_failed",
            format!("run Dure backend reconciliation failed: {}", error.stage()),
        )
    })?;
    if output.exceeded_limit {
        return Err(fail(
            "backend_reconcile_output_limit",
            "Dure backend reconciliation output exceeded its limit".into(),
        ));
    }
    if !output.status.success() {
        return Err(fail(
            "backend_reconcile_failed",
            format!("Dure backend reconciliation exited with {}", output.status),
        ));
    }
    let receipt: BackendReconcileReceipt = serde_json::from_slice(&output.stdout)
        .map_err(|error| {
            fail(
                "backend_reconcile_receipt_invalid",
                format!("parse Dure backend reconciliation receipt failed: {error}"),
            )
        })?;
    validate_backend_reconcile_receipt(&receipt)
        .map_err(|message| fail("backend_reconcile_receipt_invalid", message))?;
    if profile_id.is_some_and(|expected| {
        receipt.profile.id != expected || receipt.profile.managed_authority.is_none()
    }) {
        return Err(fail(
            "backend_reconcile_not_managed",
            "Dure backend reconciliation did not select the managed local authority".into(),
        ));
    }
    Ok(ReconciledBackendAuthority {
        managed_authority: receipt.profile.managed_authority,
    })
}

fn backend_reconcile_command(
    cli: &Path,
    channel: &str,
    profile_id: Option<&str>,
) -> Result<CommandSpec, BackendReconcileError> {
    let mut command = CommandSpec::new(cli);
    // Startup activates the verified channel bundle. Recovery follows the
    // current compatible owner instead of replacing it with this app's bundle.
    let operation = if profile_id.is_none() {
        "activate"
    } else {
        "reconcile"
    };
    command.args(["backend", operation]);
    if let Some(profile_id) = profile_id {
        if !valid_token(profile_id) {
            return Err(BackendReconcileError {
                code: "backend_reconcile_profile_invalid",
                message: "the managed backend profile identity is invalid".into(),
            });
        }
        command.args(["--backend", profile_id]);
    }
    command.arg("--json");
    command.env(crate::app_channel::APP_CHANNEL_ENV, channel);
    Ok(command)
}

fn validate_backend_reconcile_receipt(receipt: &BackendReconcileReceipt) -> Result<(), String> {
    let managed = receipt
        .profile
        .managed_authority
        .as_ref()
        .is_some_and(|profile| {
            profile.matches_reconcile_receipt(
                &receipt.profile.id,
                &receipt.profile.transport_kind,
                &receipt.authority.backend_id,
                &receipt.authority.generation,
            )
        });
    let status_matches_authority = (receipt.status == "ready" && managed)
        || (receipt.status == "external" && receipt.profile.managed_authority.is_none());
    if receipt.schema_version != 1
        || receipt.api_version != "dure.backend-reconcile/v1"
        || receipt.kind != "dure.backend.reconcile"
        || !status_matches_authority
        || !valid_token(&receipt.profile.id)
        || !matches!(receipt.profile.source.as_str(), "cli" | "environment" | "default")
        || !valid_token(&receipt.profile.transport_kind)
        || !valid_token(&receipt.authority.backend_id)
        || !valid_token(&receipt.authority.generation)
    {
        return Err("Dure backend reconciliation receipt is invalid".to_string());
    }
    Ok(())
}

fn install_status_from_current_channel() -> Result<DureCliInstallStatus, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "resolve home for Dure CLI status failed".to_string())?;
    let channel = crate::app_channel::current_name()
        .map_err(|error| format!("resolve Dure app channel failed: {error}"))?;
    install_status_for_channel(&channel, &home)
}

fn install_status_for_channel(channel: &str, home: &Path) -> Result<DureCliInstallStatus, String> {
    let available = read_cli_identity(&required_channel_cli(channel, home)?)?;
    let installed = match DureCliInstallScope::for_channel(channel) {
        DureCliInstallScope::ChannelPinned => Some(available.clone()),
        DureCliInstallScope::StableGlobal => resolve_channel_dure_payload("stable", home)?
            .map(|path| read_cli_identity(&path))
            .transpose()?,
    };
    let state = installation_state(&available, installed.as_ref());
    Ok(DureCliInstallStatus {
        state,
        installed,
        available,
    })
}

fn required_channel_cli(channel: &str, home: &Path) -> Result<PathBuf, String> {
    resolve_channel_dure_payload(channel, home)?
        .ok_or_else(|| format!("Dure CLI payload is unavailable for app channel `{channel}`"))
}

fn install_failure_message(stdout: &[u8]) -> Option<String> {
    let receipt: DureCliInstallFailureReceipt = serde_json::from_slice(stdout).ok()?;
    if receipt.schema_version != 1
        || receipt.error.code != "dure_cli_install_failed"
        || receipt.error.message.trim().is_empty()
    {
        return None;
    }
    Some(receipt.error.message.trim().to_string())
}

fn channel_install_root(channel: &str, home: &Path) -> PathBuf {
    let root = home.join(".local").join("share").join("hebbian-ide-cli");
    if channel == "stable" {
        root
    } else {
        root.join("channels").join(channel)
    }
}

fn canonicalize_optional(path: &Path, label: &str) -> Result<Option<PathBuf>, String> {
    match path.canonicalize() {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("resolve {label} failed: {error}")),
    }
}

pub(crate) fn resolve_channel_dure_command(
    channel: &str,
    home: &Path,
) -> Result<Option<DureChannelCommand>, String> {
    let install_root = channel_install_root(channel, home);
    let Some(canonical_root) = canonicalize_optional(&install_root, "Dure CLI install root")?
    else {
        return Ok(None);
    };
    let directory = canonical_root.join("bin");
    let Some(canonical_directory) =
        canonicalize_optional(&directory, "Dure CLI command directory")?
    else {
        return Ok(None);
    };
    if canonical_directory != directory {
        return Err("Dure CLI command directory escaped its channel install".to_string());
    }
    let launcher = canonical_root.join("launcher").join("dure.mjs");
    let Some(canonical_launcher) = canonicalize_optional(&launcher, "Dure CLI launcher")? else {
        return Ok(None);
    };
    if canonical_launcher != launcher {
        return Err("Dure CLI launcher escaped its channel install".to_string());
    }
    let Some(executable) =
        canonicalize_optional(&canonical_directory.join("dure"), "Dure CLI command")?
    else {
        return Ok(None);
    };
    if executable != canonical_launcher {
        return Err("Dure CLI command bypassed its verified channel launcher".to_string());
    }
    validate_executable_file(&executable, "channel-pinned Dure launcher")?;
    Ok(Some(DureChannelCommand {
        directory: canonical_directory,
        executable,
    }))
}

pub(crate) fn validate_executable_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("inspect {label} failed: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!("{label} is not executable"));
        }
    }
    Ok(())
}

fn installation_state(
    available: &DureCliIdentity,
    installed: Option<&DureCliIdentity>,
) -> DureCliInstallState {
    match installed {
        None => DureCliInstallState::Missing,
        Some(installed) if installed.digest == available.digest => DureCliInstallState::Current,
        Some(_) => DureCliInstallState::Outdated,
    }
}

fn read_cli_identity(command: &Path) -> Result<DureCliIdentity, String> {
    let install_root = command
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "Dure CLI command has no immutable install root".to_string())?;
    let metadata_path = install_root.join("install.json");
    let mut bytes = Vec::new();
    fs::File::open(&metadata_path)
        .map_err(|error| format!("read Dure CLI install metadata failed: {error}"))?
        .take(MAX_INSTALL_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read Dure CLI install metadata failed: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_INSTALL_METADATA_BYTES {
        return Err("Dure CLI install metadata size is invalid".to_string());
    }
    let metadata: InstallMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse Dure CLI install metadata failed: {error}"))?;
    let root_name = install_root.file_name().and_then(|value| value.to_str());
    if metadata.schema_version != 3
        || root_name != Some(metadata.build_id.as_str())
        || !valid_token(&metadata.build_id)
        || !valid_digest(&metadata.source_digest)
    {
        return Err("Dure CLI install metadata is invalid".to_string());
    }
    Ok(DureCliIdentity {
        version: metadata.build_id,
        digest: metadata.source_digest,
        install_root: install_root
            .to_str()
            .ok_or_else(|| "Dure CLI install root is not UTF-8".to_string())?
            .to_string(),
        executable_path: command
            .to_str()
            .ok_or_else(|| "Dure CLI command path is not UTF-8".to_string())?
            .to_string(),
    })
}

fn valid_token(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value.len() <= 128
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(version: &str, digest: &str) -> DureCliIdentity {
        DureCliIdentity {
            version: version.to_string(),
            digest: digest.to_string(),
            install_root: format!("/immutable/{version}"),
            executable_path: format!("/immutable/{version}/bin/dure"),
        }
    }

    fn backend_reconcile_receipt(
        status: &str,
        transport_kind: &str,
    ) -> BackendReconcileReceipt {
        BackendReconcileReceipt {
            schema_version: 1,
            api_version: "dure.backend-reconcile/v1".to_string(),
            kind: "dure.backend.reconcile".to_string(),
            status: status.to_string(),
            profile: BackendReconcileProfile {
                id: "local".to_string(),
                source: "default".to_string(),
                transport_kind: transport_kind.to_string(),
                managed_authority: (status == "ready" && transport_kind == "local")
                    .then(|| serde_json::from_str(r#"{"id":"local","default":true,"transport":{"kind":"local","endpoint":{"kind":"unix_socket","path":"/tmp/dure.sock"}},"auth":{"kind":"peer"},"trust":{"kind":"local_peer"},"expected":{"backendId":"dure-local","generation":"local-v1-11111111111111111111111111111111","protocol":{"minimum":{"major":1,"minor":0},"maximum":{"major":1,"minor":0}},"capabilities":[]},"deadlineMs":10000}"#).unwrap()),
            },
            authority: BackendReconcileAuthority {
                backend_id: "dure-local".to_string(),
                generation: "local-v1-11111111111111111111111111111111".to_string(),
            },
        }
    }

    #[cfg(unix)]
    fn install_test_payload(
        home: &Path,
        channel: &str,
        version: &str,
        digest: &str,
    ) -> DureCliIdentity {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = channel_install_root(channel, home);
        let version_root = root.join("versions").join(version);
        let bin = version_root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let cli = bin.join("dure");
        fs::write(&cli, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            version_root.join("install.json"),
            format!(
                "{{\"schemaVersion\":3,\"buildId\":\"{version}\",\"sourceDigest\":\"{digest}\"}}"
            ),
        )
        .unwrap();
        symlink(format!("versions/{version}"), root.join("current")).unwrap();
        read_cli_identity(&cli.canonicalize().unwrap()).unwrap()
    }

    #[test]
    fn compares_the_installed_cli_with_the_channel_pinned_digest() {
        let available = identity("available", &"a".repeat(64));
        let current = identity("same-bytes", &"a".repeat(64));
        let outdated = identity("old", &"b".repeat(64));

        assert_eq!(
            installation_state(&available, Some(&current)),
            DureCliInstallState::Current
        );
        assert_eq!(
            installation_state(&available, Some(&outdated)),
            DureCliInstallState::Outdated
        );
        assert_eq!(
            installation_state(&available, None),
            DureCliInstallState::Missing
        );
    }

    #[cfg(unix)]
    #[test]
    fn development_status_uses_the_channel_pinned_install() {
        let home = tempfile::tempdir().unwrap();
        install_test_payload(
            home.path(),
            "stable",
            "0.1.4+stable",
            &"b".repeat(64),
        );
        let channel = "dev-status-a1b2c3d4";
        let expected = install_test_payload(
            home.path(),
            channel,
            "0.1.4+channel",
            &"a".repeat(64),
        );

        let status = install_status_for_channel(channel, home.path()).unwrap();

        assert_eq!(status.state, DureCliInstallState::Current);
        assert_eq!(status.installed, Some(expected.clone()));
        assert_eq!(status.available, expected);
    }

    #[test]
    fn only_stable_owns_global_cli_promotion() {
        assert_eq!(
            DureCliInstallScope::for_channel("stable"),
            DureCliInstallScope::StableGlobal
        );
        assert_eq!(
            DureCliInstallScope::for_channel("dev-status-a1b2c3d4"),
            DureCliInstallScope::ChannelPinned
        );
    }

    #[test]
    fn reads_a_bounded_structured_installer_failure() {
        let receipt = br#"{"schemaVersion":1,"error":{"code":"dure_cli_install_failed","message":"immutable install refused"}}"#;
        assert_eq!(
            install_failure_message(receipt).as_deref(),
            Some("immutable install refused")
        );
        assert_eq!(
            install_failure_message(
                br#"{"schemaVersion":1,"error":{"code":"other","message":"wrong authority"}}"#
            ),
            None
        );
    }

    #[test]
    fn reads_only_an_exact_immutable_install_identity() {
        let root = tempfile::tempdir().unwrap();
        let version = "0.1.4+abc";
        let install_root = root.path().join("versions").join(version);
        let bin = install_root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let command = bin.join("dure.mjs");
        fs::write(&command, "#!/usr/bin/env node\n").unwrap();
        fs::write(
            install_root.join("install.json"),
            format!(
                "{{\"schemaVersion\":3,\"buildId\":\"{version}\",\"sourceDigest\":\"{}\"}}",
                "a".repeat(64)
            ),
        )
        .unwrap();

        assert_eq!(read_cli_identity(&command).unwrap().version, version);
        fs::write(
            install_root.join("install.json"),
            format!(
                "{{\"schemaVersion\":3,\"buildId\":\"other\",\"sourceDigest\":\"{}\"}}",
                "a".repeat(64)
            ),
        )
        .unwrap();
        assert!(read_cli_identity(&command).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolves_only_an_immutable_channel_payload() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let home = tempfile::tempdir().unwrap();
        let channel = "dev-test-a1b2c3d4";
        let root = channel_install_root(channel, home.path());
        let version = root.join("versions/0.1.4+test/bin");
        fs::create_dir_all(&version).unwrap();
        let cli = version.join("dure");
        fs::write(&cli, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
        symlink("versions/0.1.4+test", root.join("current")).unwrap();

        assert_eq!(
            resolve_channel_dure_payload(channel, home.path()).unwrap(),
            Some(cli.canonicalize().unwrap())
        );

        fs::remove_file(root.join("current")).unwrap();
        let outside = home.path().join("outside-version/bin");
        fs::create_dir_all(&outside).unwrap();
        let outside_cli = outside.join("dure");
        fs::write(&outside_cli, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&outside_cli, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(outside.parent().unwrap(), root.join("current")).unwrap();
        assert!(resolve_channel_dure_payload(channel, home.path())
            .unwrap_err()
            .contains("escaped"));
    }

    #[test]
    fn missing_channel_payload_is_optional() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_channel_dure_payload("dev-test-a1b2c3d4", home.path()).unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_only_the_verified_channel_launcher_for_pane_commands() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let home = tempfile::tempdir().unwrap();
        let channel = "dev-launcher-a1b2c3d4";
        let root = channel_install_root(channel, home.path());
        let launcher = root.join("launcher/dure.mjs");
        let commands = root.join("bin");
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::create_dir_all(&commands).unwrap();
        fs::write(&launcher, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
        symlink("../launcher/dure.mjs", commands.join("dure")).unwrap();

        let resolved = resolve_channel_dure_command(channel, home.path())
            .unwrap()
            .unwrap();
        assert_eq!(resolved.directory, commands.canonicalize().unwrap());
        assert_eq!(resolved.executable, launcher.canonicalize().unwrap());

        fs::remove_file(commands.join("dure")).unwrap();
        let bypass = root.join("versions/old/bin/dure.mjs");
        fs::create_dir_all(bypass.parent().unwrap()).unwrap();
        fs::write(&bypass, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&bypass, fs::Permissions::from_mode(0o700)).unwrap();
        symlink("../versions/old/bin/dure.mjs", commands.join("dure")).unwrap();
        assert!(resolve_channel_dure_command(channel, home.path())
            .unwrap_err()
            .contains("bypassed"));
    }

    #[test]
    fn reconciliation_receipt_cannot_claim_an_external_transport_is_locally_ready() {
        assert!(validate_backend_reconcile_receipt(&backend_reconcile_receipt(
            "ready", "local"
        ))
        .is_ok());
        assert!(validate_backend_reconcile_receipt(&backend_reconcile_receipt(
            "external", "ssh"
        ))
        .is_ok());
        assert!(validate_backend_reconcile_receipt(&backend_reconcile_receipt(
            "ready", "ssh"
        ))
        .is_err());
    }
}
