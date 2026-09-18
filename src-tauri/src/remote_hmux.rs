mod standalone_create;

use crate::session_checkout::remote::RemoteCheckoutHost;
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use dure_app::{AgentProviderLaunchPlanV1, ProviderRuntimeIntegrationV1};
use dure_session_runtime::host_command::{CheckoutHostCommandV1, HelperCallErrorV1};
use hmux_client::{
    interactive_shell_with_command_bridge, ManagedCreateChainStopReceipt,
    ManagedCreateChainStopReceiptV2, ManagedCreateOutcome, ManagedCreateReconcileRequest,
    ManagedCreateRequest, ManagedRehostReceipt, ManagedRehostRecipe,
    ManagedRehostReconcileRequest, ManagedRehostReplacement, ManagedRehostRequest,
    ManagedStopOutcome, ManagedStopQuiescenceFence, ManagedStopReceipt, ManagedStopReconcileRequest,
    ManagedStopRequest,
    PermissionMode, ProviderConversationIdentitySeed, ProviderStateEnvironment,
    TerminalEnvironment, TerminalSurfaceAccess, MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
};
use hmux_ssh_transport::{
    abandon_unpresented_creation_over_ssh, attach_agent_prompt_over_ssh,
    attach_terminal_surface_over_ssh,
    list_sessions_over_ssh, list_sessions_with_facts_over_ssh,
    reconcile_managed_rehost_over_ssh, reconcile_managed_stop_over_ssh, rehost_managed_over_ssh,
    stop_managed_over_ssh, HostKeyPolicy,
    RemoteCatalogSession, RemoteCommandIntercept, RemoteHostLiveness,
    RemoteManagedRehostError,
    RemoteManagedStopError, RemoteProtocolVersion, RemoteSessionClass, RemoteSessionLifecycle,
    RemoteStandaloneCreateRequest, RemoteUnpresentedCreationAbandonRequest, RemoteVersionRange,
    FileDiffDocument, SessionFence, SessionRetirementPolicy, SourceControlDocument,
    SourceControlFileDiffRequest, SourceControlStatusRequest, SourceControlWant,
    SshAuthentication, SshEndpoint, SshExecConfig, file_diff_over_ssh,
    source_control_status_over_ssh,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Manager, State, WebviewWindow};

use crate::hmux::{
    structured_terminal::{StructuredTerminalAttachFailure, StructuredTerminalAttachReceipt},
    ManagedRehostTargetReceipt,
};
use crate::hmux_input_contract::{
    project_command_input_receipt, send_fresh_agent_prompt, HmuxCommandInputReceipt,
    HmuxInitialAgentPromptReceipt, HmuxInputFailure,
};
use crate::managed_create_resolution::{
    LegacyManagedCreateReceipt, ManagedCreateAdvanceCommandResolution, ManagedCreateRetrySameReason,
};
use crate::ssh;
use crate::structured_terminal_access::RequestedTerminalSurfaceAccess;

const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);
/// How long one box gets to answer what version control says about a session.
///
/// The box spends five seconds inside its own reader for the two local answers
/// and twelve for the one that also asks the code host; this covers the slower
/// of those plus the SSH handshake, so the side that gives up is the box —
/// which can say why — rather than this deadline, which cannot.
const SOURCE_CONTROL_TIMEOUT: Duration = Duration::from_secs(20);
const CREATE_TIMEOUT: Duration = Duration::from_secs(30);
const INPUT_TIMEOUT: Duration = Duration::from_secs(12);
const REMOTE_APP_STANDALONE_RETIREMENT_GRACE_MS: u64 = 2_000;

pub(crate) fn local_shell_with_ssh_shim() -> Vec<String> {
    fail_open_optional_ssh_shim(prepare_local_shell_with_ssh_shim())
}

fn fail_open_optional_ssh_shim(prepared: Result<Vec<String>, String>) -> Vec<String> {
    match prepared {
        Ok(command) => command,
        Err(error) => {
            eprintln!(
                "dure: optional SSH command shim is unavailable ({error}); starting a plain local shell"
            );
            Vec::new()
        }
    }
}

fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

/// One-shot command argv for app-owned command panes. `-lc` runs through the
/// user's login shell so the pane sees the same PATH an interactive shell
/// would (channel CLIs, nvm-style version managers).
pub(crate) fn login_shell_command(command_line: &str) -> Vec<String> {
    vec![
        login_shell().to_string_lossy().into_owned(),
        "-lc".to_string(),
        command_line.to_string(),
    ]
}

fn prepare_local_shell_with_ssh_shim() -> Result<Vec<String>, String> {
    let channel = crate::app_channel::current()
        .map_err(|error| format!("resolve Dure app channel for SSH shim failed: {error}"))?;
    let shell = login_shell();
    let home =
        dirs::home_dir().ok_or_else(|| "resolve home for Dure SSH shim failed".to_string())?;
    let Some(dure_command) =
        crate::dure_cli_install::resolve_channel_dure_command(&channel.name, &home)?
    else {
        eprintln!(
            "dure: channel-pinned CLI is not installed for `{}`; starting a plain local shell without the optional SSH command shim",
            channel.name
        );
        return Ok(Vec::new());
    };
    local_shell_with_ssh_shim_in(
        &channel.control_dir,
        &shell,
        &home,
        &channel.name,
        &dure_command,
    )
}

fn local_shell_with_ssh_shim_in(
    control_dir: &Path,
    shell: &Path,
    home: &Path,
    channel_name: &str,
    dure_command: &crate::dure_cli_install::DureChannelCommand,
) -> Result<Vec<String>, String> {
    let control_dir = control_dir
        .canonicalize()
        .map_err(|error| format!("resolve Dure control directory failed: {error}"))?;
    let dure_cli = &dure_command.executable;
    let cli_text = dure_cli
        .to_str()
        .ok_or_else(|| "channel-pinned Dure CLI path is not UTF-8".to_string())?;
    let bridge_digest = format!("{:x}", Sha256::digest(cli_text.as_bytes()));
    let directory = control_dir.join(format!(".command-bridges-v2-{}", &bridge_digest[..16]));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("create Dure SSH shim directory failed: {error}"))?;
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("inspect Dure SSH shim directory failed: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Dure refuses a symlink or non-directory SSH shim root".to_string());
    }
    set_private_directory_permissions(&directory)?;
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("resolve Dure SSH shim directory failed: {error}"))?;
    if directory.parent() != Some(control_dir.as_path()) {
        return Err("Dure SSH shim directory escaped its channel state".to_string());
    }
    let script_path = directory.join("ssh");
    let script = format!(
        "#!/bin/sh\nexec /usr/bin/env DURE_APP_CHANNEL={channel} {cli} __ssh \"$@\"\n",
        channel = shell_quote(channel_name),
        cli = shell_quote(cli_text),
    );
    write_exact_executable(&script_path, script.as_bytes())?;
    // `dure` itself is otherwise reachable only through ~/.local/bin, which
    // only the user's interactive rc exports — a sanitized `pnpm app:dev`
    // launch environment omits it, and every agent spawned from such an app
    // loses `dure checkpoint` to a silent exit 127 (2026-08-12). The bridge
    // directory is already on pane PATH and inherited by provider processes,
    // so a channel-pinned shim restores resolution independent of how the
    // app itself was launched.
    let dure_shim_path = directory.join("dure");
    let dure_shim = format!(
        "#!/bin/sh\nexec /usr/bin/env DURE_APP_CHANNEL={channel} {cli} \"$@\"\n",
        channel = shell_quote(channel_name),
        cli = shell_quote(cli_text),
    );
    write_exact_executable(&dure_shim_path, dure_shim.as_bytes())?;
    interactive_shell_with_command_bridge(shell, home, &directory, &[])
        .map_err(|error| format!("prepare Dure SSH shim shell failed: {error}"))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn write_exact_executable(path: &Path, expected: &[u8]) -> Result<(), String> {
    if path
        .try_exists()
        .map_err(|error| format!("inspect Dure SSH shim failed: {error}"))?
    {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("inspect Dure SSH shim metadata failed: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Dure refuses a symlink or non-file SSH shim".to_string());
        }
        let current =
            fs::read(path).map_err(|error| format!("read Dure SSH shim failed: {error}"))?;
        if current != expected {
            return Err("Dure SSH shim conflicts with existing channel state".to_string());
        }
    } else {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| format!("create Dure SSH shim exclusively failed: {error}"))?;
        file.write_all(expected)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("write Dure SSH shim failed: {error}"))?;
    }
    set_private_executable_permissions(path)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("protect Dure SSH shim directory failed: {error}"))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_private_executable_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("protect Dure SSH shim failed: {error}"))
}

#[cfg(not(unix))]
fn set_private_executable_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub(crate) use crate::ssh::target::SshTargetRequest as RemoteHmuxTargetRequest;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxCatalogRequest {
    host_id: String,
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret_id: Option<String>,
    key_path: Option<String>,
    host_key_fingerprints: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxCatalogReceipt {
    schema_version: u16,
    host_id: String,
    sessions: Vec<RemoteHmuxCatalogSession>,
}

/// 상자 하나를 맞춘 결과.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxProvisionReceipt {
    schema_version: u16,
    host_id: String,
    /// 무엇으로 맞췄나. 화면이 "최신" 을 무조건적인 주장이 아니라 "이 앱이 들고
    /// 있는 빌드" 로 말할 수 있게 하는 값이다.
    build_id: String,
    target_triple: String,
    outcome: crate::remote_hmux_install::ProvisionOutcome,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHmuxCatalogSession {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_name: Option<String>,
    workspace_id: String,
    session_class: RemoteSessionClass,
    lifecycle: RemoteSessionLifecycle,
    provider_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
    supported_protocol: RemoteHmuxVersionRange,
    capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retirement_policy: Option<RemoteHmuxRetirementPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    launch_program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_liveness: Option<RemoteHostLiveness>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gateway_build_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxStructuredTerminalAttachRequest {
    observer_id: String,
    surface_id: String,
    access: RequestedTerminalSurfaceAccess,
    session: RemoteHmuxCatalogSession,
    target: RemoteHmuxTargetRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxPaneDepartureRequest {
    owner_id: String,
    session: RemoteHmuxCatalogSession,
    target: RemoteHmuxTargetRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxCommandInputRequest {
    text: String,
    submit: bool,
    session: RemoteHmuxCatalogSession,
    target: RemoteHmuxTargetRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxInitialAgentPromptRequest {
    prompt: String,
    session: RemoteHmuxCatalogSession,
    target: RemoteHmuxTargetRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxCommandInputReceipt {
    host_id: String,
    session_id: String,
    workspace_id: String,
    #[serde(flatten)]
    input: HmuxCommandInputReceipt,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxInitialAgentPromptReceipt {
    host_id: String,
    session_id: String,
    workspace_id: String,
    #[serde(flatten)]
    input: HmuxInitialAgentPromptReceipt,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxStandaloneCreateCommand {
    target: RemoteHmuxTargetRequest,
    pending_owner_id: String,
    request_id: String,
    target_session_id: String,
    launch_owner_proof: String,
    session_name: String,
    bridge_nonce: String,
    cwd: Option<String>,
    initial_rows: u16,
    initial_columns: u16,
    command_intercepts: Vec<RemoteHmuxCommandIntercept>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteManagedLaunchOptions {
    model: Option<dure_app::AgentSpawnModelSelectionV1>,
    effort: Option<dure_app::AgentSpawnEffortSelectionV1>,
    permission_override: Option<dure_app::ProviderLaunchPermissionOverrideV1>,
    setup_command: Option<dure_app::WorkflowSessionPrelaunchCommandV1>,
}

impl RemoteManagedLaunchOptions {
    fn permission(&self, permission_mode: PermissionMode) -> dure_app::ProviderPermissionModeV1 {
        self.permission_override
            .map(|mode| mode.concrete())
            .unwrap_or_else(|| match permission_mode {
                PermissionMode::Default => dure_app::ProviderPermissionModeV1::Default,
                PermissionMode::BypassApprovals => {
                    dure_app::ProviderPermissionModeV1::SkipPermissions
                }
            })
    }

    fn plan(
        &self,
        provider_id: &str,
        permission_mode: PermissionMode,
        conversation: dure_provider_adapter::NativeProviderConversationReference<'_>,
        prompt: Option<&str>,
    ) -> Result<AgentProviderLaunchPlanV1, String> {
        let provider =
            dure_app::ProviderIdV1::new(provider_id).map_err(|error| error.to_string())?;
        dure_provider_adapter::native_provider_launch_plan_with_initial_prompt(
            &provider,
            &self.permission(permission_mode),
            self.model.as_ref(),
            self.effort.as_ref(),
            conversation,
            prompt,
        )
        .map_err(|error| error.as_str().to_string())?
        .ok_or_else(|| "remote_hmux_provider_unsupported".to_string())
    }

    fn rehost_plan(
        &self,
        provider_id: &str,
        permission_mode: PermissionMode,
    ) -> Result<AgentProviderLaunchPlanV1, String> {
        let provider =
            dure_app::ProviderIdV1::new(provider_id).map_err(|error| error.to_string())?;
        let mut session = dure_provider_adapter::native_provider_session_launch_plan(
            &provider,
            &self.permission(permission_mode),
            self.model.as_ref(),
            self.effort.as_ref(),
            dure_provider_adapter::NativeProviderConversationReference::Fresh,
            hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        )
        .map_err(|error| error.as_str().to_string())?
        .ok_or_else(|| "remote_hmux_provider_unsupported".to_string())?;
        session.launch.arguments = session
            .resume_arguments
            .ok_or_else(|| "remote_hmux_provider_resume_unsupported".to_string())?;
        Ok(session.launch)
    }

    fn command(&self, command: Vec<String>) -> Vec<String> {
        match &self.setup_command {
            None => command,
            Some(setup) => vec![
                "/bin/sh".into(),
                "-lc".into(),
                format!(
                    "{} && exec {}",
                    setup.as_str(),
                    command
                        .iter()
                        .map(|arg| shell_quote(arg))
                        .collect::<Vec<_>>()
                        .join(" "),
                ),
            ],
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxManagedCreateCommand {
    target: RemoteHmuxTargetRequest,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    conversation_id: Option<String>,
    permission_mode: PermissionMode,
    bridge_nonce: String,
    cwd: String,
    #[serde(default, rename = "command")]
    _legacy_command: Option<String>,
    #[serde(default)]
    initial_prompt: Option<String>,
    #[serde(default)]
    launch_options: Option<RemoteManagedLaunchOptions>,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default)]
    terminal_environment: TerminalEnvironment,
    #[serde(default)]
    credential_id: Option<String>,
    #[serde(default)]
    credential_profile_directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxManagedRehostCommand {
    target: RemoteHmuxTargetRequest,
    operation_id: String,
    source_session_id: String,
    source_workspace_id: String,
    source_fence: RemoteHmuxManagedStopFence,
    provider_id: String,
    conversation_id: Option<String>,
    fresh_source_guard: Option<RemoteHmuxFreshSourceGuard>,
    #[serde(default)]
    expected_target_build_id: Option<String>,
    permission_mode: PermissionMode,
    cwd: String,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default)]
    terminal_environment: TerminalEnvironment,
    #[serde(default)]
    target_credential_id: Option<String>,
    #[serde(default)]
    target_credential_profile_directory: Option<String>,
    bridge_nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteHmuxFreshSourceGuard {
    runtime_revision: String,
    output_sequence: String,
}

impl RemoteHmuxManagedRehostCommand {
    fn source_guard(&self) -> Result<Option<ManagedStopQuiescenceFence>, String> {
        if self.conversation_id.is_some() == self.fresh_source_guard.is_some() {
            return Err("remote_hmux_managed_rehost_invalid: exact conversation or fresh source guard required".into());
        }
        self.fresh_source_guard
            .as_ref()
            .map(|guard| {
                let revision = guard.runtime_revision.parse::<u64>().map_err(|_| {
                    "remote_hmux_managed_rehost_invalid: invalid runtime revision".to_string()
                })?;
                let output = guard.output_sequence.parse::<u64>().map_err(|_| {
                    "remote_hmux_managed_rehost_invalid: invalid output sequence".to_string()
                })?;
                ManagedStopQuiescenceFence::new(&self.source_fence.terminal_epoch, revision, output)
                    .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))
            })
            .transpose()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxManagedRehostReconcileCommand {
    target: RemoteHmuxTargetRequest,
    operation_id: String,
    source_session_id: String,
    source_workspace_id: String,
    bridge_nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxManagedStopCommand {
    target: RemoteHmuxTargetRequest,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    expected_fence: RemoteHmuxManagedStopFence,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxManagedCreateChainStopCommand {
    target: RemoteHmuxTargetRequest,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteHmuxManagedStopFence {
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteHmuxStandaloneAbandonCommand {
    target: RemoteHmuxTargetRequest,
    request_id: String,
    session_id: String,
    workspace_id: String,
    launch_owner_proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteHmuxCommandIntercept {
    command: String,
    provider_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxStandaloneCreateReceipt {
    request_id: String,
    bridge_nonce: String,
    session: RemoteHmuxCatalogSession,
}

#[path = "remote_hmux_managed_create_receipt.rs"]
mod managed_create_receipt;
use managed_create_receipt::RemoteHmuxManagedCreateReceipt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxManagedRehostReceipt {
    operation_id: String,
    bridge_nonce: String,
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    launch_reference: Option<String>,
    replayed: bool,
    source_stop_receipt: RemoteHmuxManagedRehostStopReceipt,
    replacement: ManagedRehostTargetReceipt,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHmuxManagedRehostStopReceipt {
    stop_id: String,
    session_id: String,
    workspace_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
    outcome: &'static str,
    exit_reason: String,
}

impl From<&ManagedStopReceipt> for RemoteHmuxManagedRehostStopReceipt {
    fn from(receipt: &ManagedStopReceipt) -> Self {
        Self {
            stop_id: receipt.stop_id().to_string(),
            session_id: receipt.session_id().to_string(),
            workspace_id: receipt.workspace_id().to_string(),
            runner_principal: receipt.runner_principal().to_string(),
            runner_instance: receipt.runner_instance().to_string(),
            channel_epoch: receipt.channel_epoch().to_string(),
            host_instance_id: receipt.host_instance_id().to_string(),
            terminal_epoch: receipt.terminal_epoch().to_string(),
            outcome: match receipt.outcome() {
                ManagedStopOutcome::Stopped => "stopped",
                ManagedStopOutcome::AlreadyExited => "already_exited",
            },
            exit_reason: receipt.exit_reason().to_string(),
        }
    }
}

fn resolve_remote_managed_rehost_receipt(
    receipt: ManagedRehostReceipt,
    bridge_nonce: String,
) -> Result<RemoteHmuxManagedRehostReceipt, String> {
    let replacement = ManagedRehostTargetReceipt::from_rehost(&receipt)
        .map_err(|error| format!("remote_hmux_managed_rehost_receipt_invalid: {error}"))?;
    let conversation_id = receipt.conversation_id().map(str::to_string);
    Ok(RemoteHmuxManagedRehostReceipt {
        operation_id: receipt.operation_id().to_string(),
        bridge_nonce,
        conversation_id,
        launch_reference: receipt.launch_reference().map(str::to_string),
        replayed: receipt.replayed(),
        source_stop_receipt: receipt.source_stop_receipt().into(),
        replacement,
    })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHmuxVersionRange {
    minimum: RemoteHmuxProtocolVersion,
    maximum: RemoteHmuxProtocolVersion,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHmuxProtocolVersion {
    major: u16,
    minor: u16,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RemoteHmuxRetirementPolicy {
    AfterGracefulLastClientDepartureV1 {
        #[serde(rename = "gracePeriodMs")]
        grace_period_ms: u64,
    },
}

impl From<SessionRetirementPolicy> for RemoteHmuxRetirementPolicy {
    fn from(value: SessionRetirementPolicy) -> Self {
        match value {
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 { grace_period_ms } => {
                Self::AfterGracefulLastClientDepartureV1 { grace_period_ms }
            }
        }
    }
}

impl From<RemoteHmuxRetirementPolicy> for SessionRetirementPolicy {
    fn from(value: RemoteHmuxRetirementPolicy) -> Self {
        match value {
            RemoteHmuxRetirementPolicy::AfterGracefulLastClientDepartureV1 { grace_period_ms } => {
                Self::AfterGracefulLastClientDepartureV1 { grace_period_ms }
            }
        }
    }
}

impl From<RemoteProtocolVersion> for RemoteHmuxProtocolVersion {
    fn from(value: RemoteProtocolVersion) -> Self {
        Self {
            major: value.major,
            minor: value.minor,
        }
    }
}

impl From<RemoteVersionRange> for RemoteHmuxVersionRange {
    fn from(value: RemoteVersionRange) -> Self {
        Self {
            minimum: value.minimum.into(),
            maximum: value.maximum.into(),
        }
    }
}

impl From<RemoteCatalogSession> for RemoteHmuxCatalogSession {
    fn from(value: RemoteCatalogSession) -> Self {
        Self {
            session_id: value.session_id,
            session_name: value.session_name,
            workspace_id: value.workspace_id,
            session_class: value.session_class,
            lifecycle: value.lifecycle,
            provider_id: value.provider_id,
            runner_principal: value.runner_principal,
            runner_instance: value.runner_instance,
            channel_epoch: value.channel_epoch,
            host_instance_id: value.host_instance_id,
            terminal_epoch: value.terminal_epoch,
            supported_protocol: value.supported_protocol.into(),
            capabilities: value.capabilities,
            retirement_policy: value.retirement_policy.map(Into::into),
            launch_program: value.launch_program,
            host_liveness: value.host_liveness,
            gateway_build_id: value.gateway_build_id,
        }
    }
}

impl From<RemoteHmuxCatalogSession> for RemoteCatalogSession {
    fn from(value: RemoteHmuxCatalogSession) -> Self {
        Self {
            session_id: value.session_id,
            session_name: value.session_name,
            workspace_id: value.workspace_id,
            session_class: value.session_class,
            lifecycle: value.lifecycle,
            provider_id: value.provider_id,
            runner_principal: value.runner_principal,
            runner_instance: value.runner_instance,
            channel_epoch: value.channel_epoch,
            host_instance_id: value.host_instance_id,
            terminal_epoch: value.terminal_epoch,
            supported_protocol: RemoteVersionRange {
                minimum: RemoteProtocolVersion {
                    major: value.supported_protocol.minimum.major,
                    minor: value.supported_protocol.minimum.minor,
                },
                maximum: RemoteProtocolVersion {
                    major: value.supported_protocol.maximum.major,
                    minor: value.supported_protocol.maximum.minor,
                },
            },
            capabilities: value.capabilities,
            retirement_policy: value.retirement_policy.map(Into::into),
            launch_program: value.launch_program,
            host_liveness: value.host_liveness,
            gateway_build_id: value.gateway_build_id,
        }
    }
}

fn remote_session_fence(session: &RemoteHmuxCatalogSession) -> Result<SessionFence, String> {
    let channel_epoch = session
        .channel_epoch
        .parse::<u64>()
        .map_err(|_| "remote_hmux_input_identity_invalid: channel epoch is invalid".to_string())?;
    if channel_epoch == 0 {
        return Err("remote_hmux_input_identity_invalid: channel epoch is zero".to_string());
    }
    Ok(SessionFence {
        workspace_id: session.workspace_id.clone(),
        session_id: session.session_id.clone(),
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch,
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
    })
}

impl From<&RemoteHmuxCatalogRequest> for RemoteHmuxTargetRequest {
    fn from(value: &RemoteHmuxCatalogRequest) -> Self {
        Self {
            host_id: value.host_id.clone(),
            host: value.host.clone(),
            port: value.port,
            user: value.user.clone(),
            auth: value.auth.clone(),
            secret_id: value.secret_id.clone(),
            key_path: value.key_path.clone(),
            host_key_fingerprints: value.host_key_fingerprints.clone(),
        }
    }
}

#[tauri::command]
pub(crate) async fn remote_hmux_catalog(
    request: RemoteHmuxCatalogRequest,
) -> Result<RemoteHmuxCatalogReceipt, String> {
    let target = RemoteHmuxTargetRequest::from(&request);
    let host_id = target.host_id.clone();
    let sessions = tauri::async_runtime::spawn_blocking(move || list_remote_sessions(&target))
    .await
    .map_err(|error| format!("remote_hmux_catalog_task_failed: {error}"))??;
    Ok(RemoteHmuxCatalogReceipt {
        schema_version: 1,
        host_id,
        sessions: sessions.into_iter().map(Into::into).collect(),
    })
}

/// 이 상자의 hmux 를 이 앱이 들고 있는 빌드로 맞춘다.
///
/// 앱 번들이 리눅스 트리를 들고 다니고(`resources/hmux-remote/<triple>`),
/// 그것을 올리는 코드도 이미 있었다 — 다만 원격 에이전트를 **만들 때만**
/// 돌았다. 그래서 오래전에 짝지은 상자는 그날의 hmux 를 그대로 들고 있었고,
/// 폰은 그 상자에서 새 기능을 못 썼다.
///
/// 이미 최신인 상자는 바이트를 하나도 안 올리고 `alreadyCurrent` 로 돌아온다 —
/// 그것이 실패처럼 보이면 안 되는 것이 이 명령이 값을 돌려주는 이유다.
#[tauri::command]
pub(crate) async fn remote_hmux_provision(
    app: tauri::AppHandle,
    request: RemoteHmuxTargetRequest,
) -> Result<RemoteHmuxProvisionReceipt, String> {
    let host_id = request.host_id.clone();
    let provisioned = tauri::async_runtime::spawn_blocking(move || {
        let opts = request.ssh_options();
        crate::remote_hmux_install::ensure(&app, &opts)
    })
    .await
    .map_err(|error| format!("remote_hmux_provision_task_failed: {error}"))??;
    Ok(RemoteHmuxProvisionReceipt {
        schema_version: 1,
        host_id,
        build_id: provisioned.build_id,
        target_triple: provisioned.target_triple,
        outcome: provisioned.outcome,
    })
}

fn list_remote_sessions(
    target: &RemoteHmuxTargetRequest,
) -> Result<Vec<RemoteCatalogSession>, String> {
    let started = Instant::now();
    let remaining = || CATALOG_TIMEOUT.saturating_sub(started.elapsed());
    // The compatibility config (a second key-file read) is built only for a
    // box whose gateway predates the facts protocol.
    match list_sessions_with_facts_over_ssh(build_config(target)?, remaining()) {
        Ok(sessions) => Ok(sessions),
        Err(error) if error.is_unsupported_protocol_version() => {
            list_sessions_over_ssh(build_config(target)?, remaining())
        }
        Err(error) => Err(error),
    }
    .map_err(|error| format!("{}: {error}", error.code()))
}

pub(crate) fn hub_remote_catalog(
    host: &crate::hub::layout::RemoteHost,
) -> Result<Vec<RemoteCatalogSession>, String> {
    list_remote_sessions(&hub_remote_target(host)?)
}

/// Asks a box the hub can reach what version control says about one session.
///
/// This is the half that makes the phone's source-control screen work for a
/// session running somewhere only the laptop is paired with. The phone names a
/// session; the laptop resolves which box that is from its own layout and asks
/// that box with the connection it already holds. The phone never names a host,
/// a path, or a revision — the same bound the gateway request itself keeps.
pub(crate) fn hub_remote_source_control(
    host: &crate::hub::layout::RemoteHost,
    request_id: String,
    session_id: String,
    workspace_id: String,
    want: SourceControlWant,
) -> Result<SourceControlDocument, String> {
    let config = build_config(&hub_remote_target(host)?)?;
    source_control_status_over_ssh(
        config,
        SourceControlStatusRequest {
            request_id,
            session_id,
            workspace_id,
            // The changes tab has an older way to ask, and every box already
            // serves it. Sending the newer version for it would turn a box that
            // answers one tab into a box that answers none.
            want: match want {
                SourceControlWant::Changes => None,
                other => Some(other),
            },
        },
        SOURCE_CONTROL_TIMEOUT,
    )
    .map_err(|error| format!("{}: {error}", error.code()))
}

/// Asks a box the hub can reach for one file's patch.
///
/// The same shape as [`hub_remote_source_control`], and the same bound on who
/// names what — with one addition. This request carries a path, and the box is
/// what admits it: it lists the repository itself and refuses a path its own
/// listing did not produce. The laptop does not re-check that here, because two
/// copies of one rule drift, and the copy that matters is the one standing next
/// to the repository.
pub(crate) fn hub_remote_file_diff(
    host: &crate::hub::layout::RemoteHost,
    request_id: String,
    session_id: String,
    workspace_id: String,
    path: String,
    commit: Option<String>,
) -> Result<FileDiffDocument, String> {
    let config = build_config(&hub_remote_target(host)?)?;
    file_diff_over_ssh(
        config,
        SourceControlFileDiffRequest {
            request_id,
            session_id,
            workspace_id,
            path,
            commit,
        },
        SOURCE_CONTROL_TIMEOUT,
    )
    .map_err(|error| format!("{}: {error}", error.code()))
}

pub(crate) fn hub_remote_gateway_config(
    host: &crate::hub::layout::RemoteHost,
    writable: bool,
) -> Result<SshExecConfig, String> {
    let config = build_config(&hub_remote_target(host)?)?;
    Ok(if writable {
        config.with_controller_gateway()
    } else {
        config
    })
}

fn hub_remote_target(
    host: &crate::hub::layout::RemoteHost,
) -> Result<RemoteHmuxTargetRequest, String> {
    Ok(RemoteHmuxTargetRequest {
        host_id: host.id.clone(),
        host: host.host.clone(),
        port: host.port,
        user: host.user.clone(),
        auth: host.auth.clone(),
        secret_id: host.secret_id.clone(),
        key_path: host.key_path.clone(),
        host_key_fingerprints: known_host_fingerprints(&host.host, host.port)?,
    })
}

#[tauri::command]
pub(crate) async fn remote_hmux_command_input(
    request: RemoteHmuxCommandInputRequest,
) -> Result<RemoteHmuxCommandInputReceipt, HmuxInputFailure> {
    if request.session.lifecycle != RemoteSessionLifecycle::Ready {
        return Err(HmuxInputFailure::not_written(
            "remote_hmux_session_exited",
            "input requires a ready session",
        ));
    }
    let host_id = request.target.host_id.clone();
    let session_id = request.session.session_id.clone();
    let workspace_id = request.session.workspace_id.clone();
    let ssh = build_config(&request.target).map_err(|message| {
        HmuxInputFailure::not_written("remote_hmux_target_invalid", message)
    })?;
    let fence = remote_session_fence(&request.session).map_err(|message| {
        HmuxInputFailure::not_written("remote_hmux_input_identity_invalid", message)
    })?;
    let input = tauri::async_runtime::spawn_blocking(move || {
        let mut surface = attach_terminal_surface_over_ssh(
            ssh,
            fence,
            TerminalSurfaceAccess::Writer,
        )
        .map_err(|error| HmuxInputFailure::not_written(error.code(), error.to_string()))?;
        let receipt = surface
            .send_command_input_confirmed(request.text, request.submit, INPUT_TIMEOUT)
            .map_err(HmuxInputFailure::from_command_input)?;
        let projected = project_command_input_receipt(&receipt);
        let _ = surface.detach();
        Ok::<_, HmuxInputFailure>(projected)
    })
    .await
    .map_err(|error| {
        HmuxInputFailure::unknown("remote_hmux_input_task_failed", error.to_string())
    })??;
    Ok(RemoteHmuxCommandInputReceipt {
        host_id,
        session_id,
        workspace_id,
        input,
    })
}

#[tauri::command]
pub(crate) async fn remote_hmux_initial_agent_prompt(
    request: RemoteHmuxInitialAgentPromptRequest,
) -> Result<RemoteHmuxInitialAgentPromptReceipt, HmuxInputFailure> {
    if request.session.lifecycle != RemoteSessionLifecycle::Ready {
        return Err(HmuxInputFailure::not_written(
            "remote_hmux_session_exited",
            "initial agent prompt requires a ready session",
        ));
    }
    let host_id = request.target.host_id.clone();
    let session_id = request.session.session_id.clone();
    let workspace_id = request.session.workspace_id.clone();
    let ssh = build_config(&request.target).map_err(|message| {
        HmuxInputFailure::not_written("remote_hmux_target_invalid", message)
    })?;
    let fence = remote_session_fence(&request.session).map_err(|message| {
        HmuxInputFailure::not_written("remote_hmux_input_identity_invalid", message)
    })?;
    let provider_id = request.session.provider_id.clone();
    let input = tauri::async_runtime::spawn_blocking(move || {
        let mut surface = attach_agent_prompt_over_ssh(ssh, fence)
            .map_err(|error| HmuxInputFailure::not_written(error.code(), error.to_string()))?;
        let projected =
            send_fresh_agent_prompt(&mut surface, &provider_id, request.prompt, INPUT_TIMEOUT)?;
        let _ = surface.detach();
        Ok::<_, HmuxInputFailure>(projected)
    })
    .await
    .map_err(|error| {
        HmuxInputFailure::unknown(
            "remote_hmux_initial_agent_prompt_task_failed",
            error.to_string(),
        )
    })??;
    Ok(RemoteHmuxInitialAgentPromptReceipt {
        host_id,
        session_id,
        workspace_id,
        input,
    })
}

#[tauri::command]
pub(crate) async fn remote_hmux_standalone_create(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    request: RemoteHmuxStandaloneCreateCommand,
) -> Result<RemoteHmuxStandaloneCreateReceipt, String> {
    standalone_create::execute(app, state, request).await
}

fn remote_managed_launch_plan(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: Option<&str>,
) -> Result<AgentProviderLaunchPlanV1, String> {
    let plan = match conversation_id {
        Some(conversation_id) => crate::managed_provider_launch::exact_plan(
            provider_id,
            permission_mode,
            conversation_id,
        ),
        None => crate::managed_provider_launch::fresh_plan(provider_id, permission_mode),
    };
    plan.ok_or_else(|| {
        format!("remote_hmux_provider_unsupported: {provider_id} has no reviewed launch plan")
    })
}

fn remote_managed_rehost_recipe(
    provider_id: &str,
    permission_mode: PermissionMode,
    launch_reference: Option<String>,
    integration: Option<&ProviderRuntimeIntegrationV1>,
    github_directory: Option<&str>,
) -> Result<ManagedRehostRecipe, String> {
    let plan = remote_managed_launch_plan(
        provider_id,
        permission_mode,
        Some(hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER),
    )?;
    let command_template = crate::remote_provider_runtime::launch_command(
        provider_id, plan, integration, github_directory,
    )?;
    ManagedRehostRecipe::new(command_template, launch_reference)
        .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))
}

fn remote_managed_create_request(
    request: &RemoteHmuxManagedCreateCommand,
    command: Vec<String>,
) -> Result<ManagedCreateRequest, String> {
    let conversation_identity = request
        .conversation_id
        .as_deref()
        .map(|conversation_id| {
            ProviderConversationIdentitySeed::new(&request.provider_id, conversation_id)
        })
        .transpose()
        .map_err(|error| format!("remote_hmux_conversation_invalid: {error}"))?;
    let create = ManagedCreateRequest::new(
        &request.idempotency_key,
        &request.session_id,
        &request.workspace_id,
        &request.provider_id,
        request.permission_mode,
        &request.cwd,
        command,
        request.initial_rows,
        request.initial_columns,
    )
    .and_then(|create| {
        create.with_required_managed_stop_request_version(
            MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
        )
    })
    .and_then(|create| create.with_terminal_environment(request.terminal_environment.clone()))
    .map_err(|error| format!("remote_hmux_managed_request_invalid: {error}"))?;
    match conversation_identity {
        Some(conversation_identity) => create
            .with_conversation_identity(conversation_identity)
            .map_err(|error| format!("remote_hmux_managed_request_invalid: {error}")),
        None => Ok(create),
    }
}

fn prepare_remote_provider_state_environment(
    opts: &ssh::SshOptions,
    provider_id: &str,
    credential_id: Option<&str>,
    credential_profile_directory: Option<&str>,
) -> Result<ProviderStateEnvironment, String> {
    match (credential_id, credential_profile_directory) {
        (None, None) => crate::accounts::provider_default_state_environment(provider_id),
        (Some(_), Some(directory)) => crate::remote_accounts::prepare(
            opts,
            provider_id,
            directory,
            true,
        )?
        .provider_state_environment(provider_id),
        _ => Err(
            "remote_hmux_credential_selection_invalid: credential id and profile directory must be supplied together"
                .to_string(),
        ),
    }
}

fn remote_profile_launch_reference(
    provider_id: &str,
    credential_id: Option<&str>,
    credential_profile_directory: Option<&str>,
) -> Result<Option<String>, String> {
    match (credential_id, credential_profile_directory) {
        (None, None) => Ok(None),
        (Some(reference), Some(directory)) => {
            crate::remote_accounts::validate_remote_directory(provider_id, directory)?;
            Ok(Some(reference.to_string()))
        }
        _ => Err(
            "remote_hmux_credential_selection_invalid: credential id and profile directory must be supplied together"
                .to_string(),
        ),
    }
}

struct RemoteManagedCreateProjection {
    idempotency_key: String,
    bridge_nonce: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    initial_prompt_accepted: bool,
}

struct PreparedRemoteManagedCreate {
    catalog_target: RemoteHmuxTargetRequest,
    account_ssh: ssh::SshOptions,
    request: RemoteHmuxManagedCreateCommand,
    launch_plan: AgentProviderLaunchPlanV1,
    expected: RemoteManagedCreateProjection,
}

struct ReadyRemoteManagedCreate {
    checkout_host: RemoteCheckoutHost,
    catalog_target: RemoteHmuxTargetRequest,
    create: ManagedCreateRequest,
    expected: RemoteManagedCreateProjection,
}

fn prepare_remote_managed_create(
    request: RemoteHmuxManagedCreateCommand,
) -> Result<PreparedRemoteManagedCreate, String> {
    let account_ssh = request.target.checkout_options()?;
    let catalog_target = request.target.clone();
    let (launch_plan, initial_prompt_accepted) = if let Some(options) = &request.launch_options {
        use dure_provider_adapter::NativeProviderConversationReference;
        let conversation = request
            .conversation_id
            .as_deref()
            .map(NativeProviderConversationReference::Exact)
            .unwrap_or(NativeProviderConversationReference::Fresh);
        match options.plan(
            &request.provider_id,
            request.permission_mode,
            conversation,
            request.initial_prompt.as_deref(),
        ) {
            Ok(plan) => (plan, request.initial_prompt.is_some()),
            Err(_) if request.initial_prompt.is_some() => (
                options.plan(
                    &request.provider_id,
                    request.permission_mode,
                    conversation,
                    None,
                )?,
                false,
            ),
            Err(error) => return Err(error),
        }
    } else {
        crate::managed_provider_launch::create_plan(
            &request.provider_id,
            request.permission_mode,
            request.conversation_id.as_deref(),
            request.initial_prompt.as_deref(),
        )
        .ok_or_else(|| {
            format!(
                "remote_hmux_provider_unsupported: {} has no reviewed launch plan",
                request.provider_id
            )
        })?
    };
    let expected = RemoteManagedCreateProjection {
        idempotency_key: request.idempotency_key.clone(),
        bridge_nonce: request.bridge_nonce.clone(),
        session_id: request.session_id.clone(),
        workspace_id: request.workspace_id.clone(),
        provider_id: request.provider_id.clone(),
        initial_prompt_accepted,
    };
    Ok(PreparedRemoteManagedCreate {
        catalog_target,
        account_ssh,
        request,
        launch_plan,
        expected,
    })
}

fn ready_remote_managed_create<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    prepared: PreparedRemoteManagedCreate,
) -> Result<ReadyRemoteManagedCreate, String> {
    let PreparedRemoteManagedCreate {
        catalog_target,
        account_ssh,
        request,
        launch_plan,
        mut expected,
    } = prepared;
    let provisioned = crate::remote_hmux_install::ensure(app, &account_ssh)?;
    let provider_state_environment = prepare_remote_provider_state_environment(
        &account_ssh,
        &expected.provider_id,
        request.credential_id.as_deref(),
        request.credential_profile_directory.as_deref(),
    )?;
    let integration = crate::remote_provider_runtime::ensure(
        &account_ssh,
        &request.provider_id,
        provisioned.runtime(),
        &request.cwd,
        &provider_state_environment,
    )?;
    let github_directory = crate::remote_github::prepare(
        &account_ssh, provisioned.runtime().home(), &request.cwd,
    );
    let command = crate::remote_provider_runtime::launch_command(
        &request.provider_id,
        launch_plan,
        integration.as_ref(),
        github_directory.as_deref(),
    )?;
    let command = match &request.launch_options {
        Some(options) => options.command(command),
        None => command,
    };
    let mut create = match remote_managed_create_request(&request, command) {
        Ok(create) => create,
        Err(error) if expected.initial_prompt_accepted => {
            let fallback_plan = if let Some(options) = &request.launch_options {
                options.plan(
                    &request.provider_id,
                    request.permission_mode,
                    request
                        .conversation_id
                        .as_deref()
                        .map(dure_provider_adapter::NativeProviderConversationReference::Exact)
                        .unwrap_or(
                            dure_provider_adapter::NativeProviderConversationReference::Fresh,
                        ),
                    None,
                )?
            } else {
                remote_managed_launch_plan(
                    &request.provider_id,
                    request.permission_mode,
                    request.conversation_id.as_deref(),
                )?
            };
            let fallback_command = crate::remote_provider_runtime::launch_command(
                &request.provider_id,
                fallback_plan,
                integration.as_ref(),
                github_directory.as_deref(),
            )?;
            let fallback_command = match &request.launch_options {
                Some(options) => options.command(fallback_command),
                None => fallback_command,
            };
            expected.initial_prompt_accepted = false;
            remote_managed_create_request(&request, fallback_command).map_err(|fallback| {
                format!("{fallback}; launch-prompt command was also invalid: {error}")
            })?
        }
        Err(error) => return Err(error),
    };
    let launch_reference = remote_profile_launch_reference(
        &expected.provider_id,
        request.credential_id.as_deref(),
        request.credential_profile_directory.as_deref(),
    )?;
    let recipe = if let Some(options) = &request.launch_options {
        let plan = options.rehost_plan(&expected.provider_id, request.permission_mode)?;
        let command = crate::remote_provider_runtime::launch_command(
            &expected.provider_id,
            plan,
            integration.as_ref(),
            github_directory.as_deref(),
        )?;
        ManagedRehostRecipe::new(command, launch_reference).map_err(|error| error.to_string())?
    } else {
        remote_managed_rehost_recipe(
            &expected.provider_id,
            request.permission_mode,
            launch_reference,
            integration.as_ref(),
            github_directory.as_deref(),
        )?
    };
    create = create
        .with_managed_rehost_recipe(recipe)
        .map_err(|error| format!("remote_hmux_managed_request_invalid: {error}"))?;
    if !provider_state_environment.is_empty() {
        create = create
            .with_provider_state_environment(provider_state_environment)
            .map_err(|error| format!("remote_hmux_managed_request_invalid: {error}"))?;
    }
    let checkout_host = RemoteCheckoutHost::prepare(app, account_ssh, Some(provisioned.runtime()))?;
    Ok(ReadyRemoteManagedCreate {
        checkout_host,
        catalog_target,
        create,
        expected,
    })
}

fn project_remote_managed_create_receipt(
    receipt: hmux_client::ManagedCreateReceipt,
    catalog_ssh: SshExecConfig,
    expected: &RemoteManagedCreateProjection,
    state: RemoteManagedCreateReceiptState,
) -> Result<RemoteHmuxManagedCreateReceipt, String> {
    let successor = state == RemoteManagedCreateReceiptState::Advanced;
    if receipt.workspace_id() != expected.workspace_id
        || receipt.provider_id() != expected.provider_id
        || (successor
            && (receipt.idempotency_key() == expected.idempotency_key
                || receipt.session_id() == expected.session_id))
        || (!successor
            && (receipt.idempotency_key() != expected.idempotency_key
                || receipt.session_id() != expected.session_id))
    {
        return Err("remote_hmux_managed_receipt_invalid: broker identity changed".to_string());
    }
    let sessions = list_sessions_over_ssh(catalog_ssh, CATALOG_TIMEOUT)
        .map_err(|error| format!("{}: {error}", error.code()))?;
    let mut matches = sessions.into_iter().filter(|session| {
        session.session_id == receipt.session_id()
            && session.workspace_id == expected.workspace_id
    });
    let session = matches.next().ok_or_else(|| {
        "remote_hmux_managed_receipt_invalid: created session is absent from catalog".to_string()
    })?;
    if matches.next().is_some()
        || session.session_class != RemoteSessionClass::Managed
        || session.lifecycle != RemoteSessionLifecycle::Ready
        || session.provider_id != expected.provider_id
    {
        return Err(
            "remote_hmux_managed_receipt_invalid: catalog fence does not match creation"
                .to_string(),
        );
    }
    let generation_fence = receipt.generation_fence().ok_or_else(|| {
        "remote_hmux_managed_receipt_invalid: broker omitted generation fence".to_string()
    })?;
    if !generation_fence.matches_generation(
        &session.runner_principal,
        &session.runner_instance,
        &session.channel_epoch,
        &session.host_instance_id,
        &session.terminal_epoch,
    ) {
        return Err(
            "remote_hmux_managed_receipt_invalid: catalog generation changed after creation"
                .to_string(),
        );
    }
    Ok(RemoteHmuxManagedCreateReceipt {
        idempotency_key: receipt.idempotency_key().to_string(),
        bridge_nonce: expected.bridge_nonce.clone(),
        outcome: match receipt.outcome() {
            ManagedCreateOutcome::Created => "created",
            ManagedCreateOutcome::Reused => "reused",
        },
        initial_prompt_accepted: expected.initial_prompt_accepted,
        session: session.into(),
    })
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum RemoteManagedCreateReceiptState {
    Current,
    Advanced,
}

fn project_remote_managed_create_resolution(
    resolution: Result<
        ManagedCreateAdvanceCommandResolution<hmux_client::ManagedCreateReceipt>,
        HelperCallErrorV1,
    >,
    catalog_target: RemoteHmuxTargetRequest,
    expected: RemoteManagedCreateProjection,
) -> Result<ManagedCreateAdvanceCommandResolution<RemoteHmuxManagedCreateReceipt>, String> {
    match resolution {
        Ok(ManagedCreateAdvanceCommandResolution::Current { receipt }) => {
            Ok(ManagedCreateAdvanceCommandResolution::Current {
                receipt: project_remote_managed_create_receipt(
                    receipt,
                    build_config(&catalog_target)?,
                    &expected,
                    RemoteManagedCreateReceiptState::Current,
                )?,
            })
        }
        Ok(ManagedCreateAdvanceCommandResolution::Advanced { receipt }) => {
            Ok(ManagedCreateAdvanceCommandResolution::Advanced {
                receipt: project_remote_managed_create_receipt(
                    receipt,
                    build_config(&catalog_target)?,
                    &expected,
                    RemoteManagedCreateReceiptState::Advanced,
                )?,
            })
        }
        Ok(ManagedCreateAdvanceCommandResolution::RetrySame {
            reason,
            code,
            message,
        }) => Ok(ManagedCreateAdvanceCommandResolution::retry_same(
            reason, code, message,
        )),
        Ok(ManagedCreateAdvanceCommandResolution::Rejected { code, message }) => Ok(
            ManagedCreateAdvanceCommandResolution::rejected(code, message),
        ),
        Err(HelperCallErrorV1::Reported(error)) => Err(error.to_string()),
        Err(error @ HelperCallErrorV1::OutcomeUnknown(_)) => {
            Ok(ManagedCreateAdvanceCommandResolution::retry_same(
                ManagedCreateRetrySameReason::CreateRetryable,
                "remote_session_checkout_outcome_unknown",
                error.to_string(),
            ))
        }
    }
}

#[tauri::command]
pub(crate) async fn remote_hmux_managed_create<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: RemoteHmuxManagedCreateCommand,
) -> Result<LegacyManagedCreateReceipt<RemoteHmuxManagedCreateReceipt>, String> {
    let prepared = prepare_remote_managed_create(request)?;
    let receipt = tauri::async_runtime::spawn_blocking(move || {
        let ready = ready_remote_managed_create(&app, prepared)?;
        let receipt = ready
            .checkout_host
            .execute(
                CheckoutHostCommandV1::CreateManaged {
                    request: ready.create,
                },
                CREATE_TIMEOUT,
            )
            .map_err(|error| error.to_string())?;
        let catalog_ssh = build_config(&ready.catalog_target)?;
        project_remote_managed_create_receipt(
            receipt,
            catalog_ssh,
            &ready.expected,
            RemoteManagedCreateReceiptState::Current,
        )
    })
    .await
    .map_err(|error| format!("remote_hmux_managed_create_task_failed: {error}"))??;
    Ok(LegacyManagedCreateReceipt::new(receipt))
}

#[tauri::command]
pub(crate) async fn remote_hmux_managed_create_advance_v1<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: RemoteHmuxManagedCreateCommand,
) -> Result<ManagedCreateAdvanceCommandResolution<RemoteHmuxManagedCreateReceipt>, String> {
    let prepared = prepare_remote_managed_create(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let ready = ready_remote_managed_create(&app, prepared)?;
        let ReadyRemoteManagedCreate {
            checkout_host,
            catalog_target,
            create,
            expected,
        } = ready;
        let resolution = checkout_host.execute(
            CheckoutHostCommandV1::AdvanceManaged {
                request: create,
                replace_current: false,
            },
            CREATE_TIMEOUT,
        );
        project_remote_managed_create_resolution(resolution, catalog_target, expected)
    })
    .await
    .map_err(|error| format!("remote_hmux_managed_create_task_failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_hmux_managed_rehost_reconcile(
    app: tauri::AppHandle,
    request: RemoteHmuxManagedRehostReconcileCommand,
) -> Result<Option<RemoteHmuxManagedRehostReceipt>, String> {
    let reconcile_ssh = build_config(&request.target)?;
    let account_ssh = request.target.ssh_options();
    tauri::async_runtime::spawn_blocking(move || {
        let reconcile = remote_managed_rehost_reconcile_request(&request)?;
        crate::remote_hmux_install::ensure(&app, &account_ssh)?;
        let receipt = match reconcile_managed_rehost_over_ssh(
            reconcile_ssh,
            reconcile,
            CREATE_TIMEOUT,
        ) {
            Ok(receipt) => receipt,
            Err(RemoteManagedRehostError::IntentNotFound(_)) => return Ok(None),
            Err(error) => return Err(format!("{}: {error}", error.code())),
        };
        resolve_remote_managed_rehost_receipt(receipt, request.bridge_nonce).map(Some)
    })
    .await
    .map_err(|error| format!("remote_hmux_managed_rehost_task_failed: {error}"))?
}

fn remote_managed_rehost_reconcile_request(
    request: &RemoteHmuxManagedRehostReconcileCommand,
) -> Result<ManagedRehostReconcileRequest, String> {
    ManagedRehostReconcileRequest::by_operation_identity(
        &request.operation_id,
        &request.source_session_id,
        &request.source_workspace_id,
    )
    .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))
}

#[tauri::command]
pub(crate) async fn remote_hmux_managed_rehost(
    app: tauri::AppHandle,
    request: RemoteHmuxManagedRehostCommand,
) -> Result<RemoteHmuxManagedRehostReceipt, String> {
    let fresh_source_guard = request.source_guard()?;
    let reconcile_ssh = build_config(&request.target)?;
    let rehost_ssh = build_config(&request.target)?;
    let account_ssh = request.target.ssh_options();
    let operation_id = request.operation_id;
    let source_session_id = request.source_session_id;
    let source_workspace_id = request.source_workspace_id;
    let source_fence = request.source_fence;
    let provider_id = request.provider_id;
    let conversation_id = request.conversation_id;
    let expected_target_build_id = request.expected_target_build_id;
    let permission_mode = request.permission_mode;
    let cwd = request.cwd;
    let initial_rows = request.initial_rows;
    let initial_columns = request.initial_columns;
    let terminal_environment = request.terminal_environment;
    let target_credential_id = request.target_credential_id;
    let target_credential_profile_directory = request.target_credential_profile_directory;
    let bridge_nonce = request.bridge_nonce;
    tauri::async_runtime::spawn_blocking(move || {
        let reconcile = ManagedRehostReconcileRequest::by_operation_identity(
            &operation_id,
            &source_session_id,
            &source_workspace_id,
        )
        .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))?;
        let provisioned = crate::remote_hmux_install::ensure(&app, &account_ssh)?;
        let receipt = crate::hmux::reconcile_managed_rehost_then_initiate(
            || {
                match reconcile_managed_rehost_over_ssh(
                    reconcile_ssh,
                    reconcile,
                    CREATE_TIMEOUT,
                ) {
                    Ok(receipt) => Ok(Some(receipt)),
                    Err(RemoteManagedRehostError::IntentNotFound(_)) => Ok(None),
                    Err(error) => Err(format!("{}: {error}", error.code())),
                }
            },
            || {
                let channel_epoch =
                    source_fence.channel_epoch.parse::<u64>().map_err(|_| {
                        "remote_hmux_managed_rehost_invalid: channel epoch is not an unsigned integer"
                            .to_string()
                    })?;
                let provider_state_environment = prepare_remote_provider_state_environment(
                    &account_ssh,
                    &provider_id,
                    target_credential_id.as_deref(),
                    target_credential_profile_directory.as_deref(),
                )?;
                let integration = crate::remote_provider_runtime::ensure(
                    &account_ssh,
                    &provider_id,
                    provisioned.runtime(),
                    &cwd,
                    &provider_state_environment,
                )?;
                let github_directory = crate::remote_github::prepare(
                    &account_ssh, provisioned.runtime().home(), &cwd,
                );
                let launch_reference = remote_profile_launch_reference(
                    &provider_id,
                    target_credential_id.as_deref(),
                    target_credential_profile_directory.as_deref(),
                )?;
                let recipe = remote_managed_rehost_recipe(
                    &provider_id,
                    permission_mode,
                    launch_reference.clone(),
                    integration.as_ref(),
                    github_directory.as_deref(),
                )?;
                let replacement = ManagedRehostReplacement::new(
                    &provider_id,
                    permission_mode,
                    &cwd,
                    initial_rows,
                    initial_columns,
                    terminal_environment,
                    launch_reference,
                    provider_state_environment,
                    recipe,
                )
                .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))?;
                let replacement = if conversation_id.is_none() {
                    let plan = remote_managed_launch_plan(&provider_id, permission_mode, None)?;
                    let command = crate::remote_provider_runtime::launch_command(
                        &provider_id,
                        plan,
                        integration.as_ref(),
                        github_directory.as_deref(),
                    )?;
                    replacement
                        .with_fresh_command(command)
                        .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))?
                } else {
                    replacement
                };
                let rehost = ManagedRehostRequest::new(
                    &operation_id,
                    &source_session_id,
                    &source_workspace_id,
                    &source_fence.runner_principal,
                    &source_fence.runner_instance,
                    channel_epoch,
                    &source_fence.host_instance_id,
                    &source_fence.terminal_epoch,
                    true,
                )
                .and_then(|rehost| rehost.with_expected_provider_id(&provider_id))
                .and_then(|rehost| match conversation_id {
                    Some(conversation_id) => rehost.with_expected_conversation_id(conversation_id),
                    None => Ok(rehost),
                })
                .and_then(|rehost| rehost.with_replacement(replacement))
                .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))?;
                let rehost = match expected_target_build_id {
                    Some(build_id) => rehost
                        .with_expected_target_build_id(build_id)
                        .map_err(|error| {
                            format!("remote_hmux_managed_rehost_invalid: {error}")
                        })?,
                    None => rehost,
                };
                let rehost = match fresh_source_guard {
                    Some(guard) => rehost
                        .with_fresh_source_quiescence(guard)
                        .map_err(|error| format!("remote_hmux_managed_rehost_invalid: {error}"))?,
                    None => rehost,
                };
                rehost_managed_over_ssh(rehost_ssh, rehost, CREATE_TIMEOUT)
                    .map_err(|error| format!("{}: {error}", error.code()))
            },
        )?;
        resolve_remote_managed_rehost_receipt(receipt, bridge_nonce)
    })
    .await
    .map_err(|error| format!("remote_hmux_managed_rehost_task_failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_hmux_managed_stop(
    request: RemoteHmuxManagedStopCommand,
) -> Result<ManagedStopReceipt, String> {
    let reconcile_ssh = build_config(&request.target)?;
    let stop_ssh = build_config(&request.target)?;
    tauri::async_runtime::spawn_blocking(move || {
        let channel_epoch = request.expected_fence.channel_epoch.parse::<u64>().map_err(|_| {
            "remote_hmux_managed_stop_invalid: channel epoch is not an unsigned integer"
                .to_string()
        })?;
        let stop = ManagedStopRequest::new(
            &request.stop_id,
            &request.session_id,
            &request.workspace_id,
        )
        .and_then(|stop| {
            stop.with_expected_fence(
                &request.expected_fence.runner_principal,
                &request.expected_fence.runner_instance,
                channel_epoch,
                &request.expected_fence.host_instance_id,
                &request.expected_fence.terminal_epoch,
            )
        })
        .map_err(|error| format!("remote_hmux_managed_stop_invalid: {error}"))?;
        let reconcile = ManagedStopReconcileRequest::from_stop_request(&stop)
            .map_err(|error| format!("remote_hmux_managed_stop_invalid: {error}"))?;
        match reconcile_managed_stop_over_ssh(reconcile_ssh, reconcile, CREATE_TIMEOUT) {
            Ok(receipt)
                if receipt.runner_principal() != request.expected_fence.runner_principal
                    || receipt.runner_instance() != request.expected_fence.runner_instance
                    || receipt.channel_epoch() != channel_epoch
                    || receipt.host_instance_id() != request.expected_fence.host_instance_id
                    || receipt.terminal_epoch() != request.expected_fence.terminal_epoch =>
            {
                return Err(
                    "hmux_remote_managed_stop_outcome_unknown: reconciled receipt changed the persisted generation fence"
                        .to_string(),
                );
            }
            Ok(receipt) => return Ok(receipt),
            Err(RemoteManagedStopError::IntentNotFound(_)) => {}
            Err(error) => return Err(format!("{}: {error}", error.code())),
        }
        stop_managed_over_ssh(stop_ssh, stop, CREATE_TIMEOUT)
            .map_err(|error| format!("{}: {error}", error.code()))
    })
    .await
    .map_err(|error| format!("remote_hmux_managed_stop_task_failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_hmux_managed_create_chain_stop_v1<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: RemoteHmuxManagedCreateChainStopCommand,
) -> Result<ManagedCreateChainStopReceipt, String> {
    let root = ManagedCreateReconcileRequest::new(
        &request.idempotency_key,
        &request.session_id,
        &request.workspace_id,
    )
    .map_err(|error| format!("remote_hmux_managed_create_chain_stop_invalid: {error}"))?;
    remote_hmux_managed_create_chain_stop_v2(app, request)
        .await?
        .legacy_projection(&root)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn remote_hmux_managed_create_chain_stop_v2<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: RemoteHmuxManagedCreateChainStopCommand,
) -> Result<ManagedCreateChainStopReceiptV2, String> {
    let options = request.target.checkout_options()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = ManagedCreateReconcileRequest::new(
            request.idempotency_key,
            request.session_id,
            request.workspace_id,
        )
        .map_err(|error| format!("remote_hmux_managed_create_chain_stop_invalid: {error}"))?;
        // Retirement observes the installed runtime on the same SSH connection;
        // it never provisions or activates a build as a cleanup side effect.
        RemoteCheckoutHost::prepare(&app, options, None)?
            .execute(
                CheckoutHostCommandV1::CloseManaged { request: root },
                CREATE_TIMEOUT,
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("remote_hmux_managed_create_chain_stop_task_failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_hmux_standalone_abandon_unpresented(
    request: RemoteHmuxStandaloneAbandonCommand,
) -> Result<crate::hmux::PaneDepartureReceipt, String> {
    let policy = Some(
        SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
            grace_period_ms: REMOTE_APP_STANDALONE_RETIREMENT_GRACE_MS,
        },
    );
    let ssh = match build_config(&request.target) {
        Ok(ssh) => ssh,
        Err(_) => {
            return Ok(crate::hmux::preserved_receipt(
                "transport_unavailable",
                policy,
            ));
        }
    };
    let abandon = RemoteUnpresentedCreationAbandonRequest {
        request_id: request.request_id,
        session_id: request.session_id,
        workspace_id: request.workspace_id,
        launch_owner_proof: request.launch_owner_proof,
    };
    tauri::async_runtime::spawn_blocking(move || {
        match abandon_unpresented_creation_over_ssh(ssh, abandon, CREATE_TIMEOUT) {
            Ok(receipt) => crate::hmux::project_receipt(receipt.receipt, policy),
            Err(_) => crate::hmux::preserved_receipt("transport_unavailable", policy),
        }
    })
    .await
    .map_err(|error| format!("remote_hmux_abandon_task_failed: {error}"))
}

#[tauri::command]
pub(crate) async fn remote_hmux_known_host_fingerprints(
    host: String,
    port: u16,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || known_host_fingerprints(&host, port))
        .await
        .map_err(|error| format!("remote_hmux_known_host_task_failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_hmux_structured_terminal_attach(
    window: WebviewWindow,
    webview_instance_id: String,
    request: RemoteHmuxStructuredTerminalAttachRequest,
) -> Result<StructuredTerminalAttachReceipt, StructuredTerminalAttachFailure> {
    let state = window.state::<crate::AppState>();
    let webview = state
        .hmux
        .claim_observer_webview(&window, &webview_instance_id)
        .await?;
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(
        move || -> Result<_, StructuredTerminalAttachFailure> {
            let ssh = build_config(&request.target)?;
            let host_id = request.target.host_id;
            let session = request.session.into();
            let reservation = hmux.reserve_structured_terminal(
                request.observer_id,
                request.surface_id,
                webview,
            )?;
            hmux.attach_remote_pane(
                reservation,
                host_id,
                session,
                ssh,
                request.access.into(),
            )
        },
    )
    .await
    .map_err(|error| {
        StructuredTerminalAttachFailure::adapter(
            "hmux_structured_attach_task_failed",
            format!("attach remote Hmux structured terminal task failed: {error}"),
        )
    })?
}

#[tauri::command]
pub(crate) async fn remote_hmux_pane_depart_gracefully(
    state: State<'_, crate::AppState>,
    request: RemoteHmuxPaneDepartureRequest,
) -> Result<crate::hmux::PaneDepartureReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        let policy = request.session.retirement_policy.map(Into::into);
        let host_id = request.target.host_id.clone();
        let ssh = match build_config(&request.target) {
            Ok(ssh) => ssh,
            Err(_) => {
                return crate::hmux::preserved_receipt("transport_unavailable", policy);
            }
        };
        match hmux.depart_remote_pane_gracefully(
            request.owner_id,
            host_id,
            request.session.into(),
            ssh,
        ) {
            Ok(receipt) => crate::hmux::project_receipt(receipt, policy),
            Err(error) => {
                crate::hmux::preserved_receipt(remote_departure_preserve_reason(&error), policy)
            }
        }
    })
    .await
    .map_err(|error| format!("depart remote Hmux pane task failed: {error}"))
}

fn remote_departure_preserve_reason(error: &str) -> &'static str {
    if error.starts_with("remote_hmux_pane_identity_changed") {
        "generation_changed"
    } else if error.starts_with("remote_hmux_pane_not_attached") {
        "not_attached"
    } else if error.starts_with("remote_hmux_retirement_managed") {
        "managed_session"
    } else {
        "transport_unavailable"
    }
}

fn build_config(request: &RemoteHmuxTargetRequest) -> Result<SshExecConfig, String> {
    request.validate()?;
    let authentication = resolve_authentication(request)?;
    Ok(SshExecConfig::new(
        SshEndpoint {
            host: request.host.clone(),
            port: request.port,
        },
        request.user.clone(),
        authentication,
        HostKeyPolicy::pinned(request.host_key_fingerprints.clone()),
    ))
}

fn known_host_fingerprints(host: &str, port: u16) -> Result<Vec<String>, String> {
    let host = host.trim();
    if host.is_empty()
        || port == 0
        || host
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err("remote_hmux_target_invalid: host and port are required".into());
    }
    let known_hosts = dirs::home_dir()
        .ok_or_else(|| "remote_hmux_host_untrusted: home directory is unavailable".to_string())?
        .join(".ssh")
        .join("known_hosts");
    let lookup = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    let output = Command::new("ssh-keygen")
        .args(["-F", &lookup, "-f"])
        .arg(&known_hosts)
        .output()
        .map_err(|error| {
            format!("remote_hmux_host_untrusted: could not inspect known_hosts: {error}")
        })?;
    if !output.status.success() {
        return Err(format!(
            "remote_hmux_host_untrusted: {lookup} has no enrolled known_hosts key"
        ));
    }
    let fingerprints = fingerprints_from_known_hosts_search(&output.stdout)?;
    if fingerprints.is_empty() {
        return Err(format!(
            "remote_hmux_host_untrusted: {lookup} has no usable known_hosts key"
        ));
    }
    Ok(fingerprints)
}

fn fingerprints_from_known_hosts_search(output: &[u8]) -> Result<Vec<String>, String> {
    let text = std::str::from_utf8(output)
        .map_err(|_| "remote_hmux_host_untrusted: known_hosts output is not UTF-8".to_string())?;
    let mut fingerprints = BTreeSet::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let _hosts = fields.next();
        let _algorithm = fields.next();
        let Some(encoded_key) = fields.next() else {
            continue;
        };
        let key = base64::engine::general_purpose::STANDARD
            .decode(encoded_key)
            .map_err(|_| {
                "remote_hmux_host_untrusted: known_hosts contains an invalid public key".to_string()
            })?;
        fingerprints.insert(format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(key))
        ));
    }
    Ok(fingerprints.into_iter().collect())
}

fn resolve_authentication(request: &RemoteHmuxTargetRequest) -> Result<SshAuthentication, String> {
    match request.auth.as_str() {
        "password" => {
            let secret_id = request.secret_id.as_deref().ok_or_else(|| {
                "remote_hmux_password_unavailable: no credential reference is configured"
                    .to_string()
            })?;
            let password = crate::secrets::get_ssh_secret(secret_id)
                .map_err(|error| format!("remote_hmux_password_unavailable: {error}"))?
                .ok_or_else(|| {
                    "remote_hmux_password_unavailable: the stored SSH password is missing"
                        .to_string()
                })?;
            Ok(SshAuthentication::Password(password))
        }
        "key" => read_private_key(request.key_path.as_deref().ok_or_else(|| {
            "remote_hmux_key_unavailable: no private key path is configured".to_string()
        })?),
        "auto" => {
            if let Some(path) = request.key_path.as_deref() {
                return read_private_key(path);
            }
            for candidate in default_private_keys() {
                if candidate.is_file() {
                    return read_private_key_path(&candidate);
                }
            }
            Err(
                "remote_hmux_auth_unsupported: agent-only auto authentication is not available for the pinned no-PTY transport"
                    .into(),
            )
        }
        _ => Err("remote_hmux_auth_invalid: unsupported SSH authentication mode".into()),
    }
}

fn read_private_key(path: &str) -> Result<SshAuthentication, String> {
    read_private_key_path(&expand_path(path))
}

fn read_private_key_path(path: &Path) -> Result<SshAuthentication, String> {
    let openssh_pem = std::fs::read_to_string(path).map_err(|error| {
        format!("remote_hmux_key_unavailable: could not read private key: {error}")
    })?;
    Ok(SshAuthentication::PrivateKey {
        openssh_pem,
        passphrase: None,
    })
}

fn default_private_keys() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    ["id_ed25519", "id_rsa", "id_ecdsa"]
        .into_iter()
        .map(|name| home.join(".ssh").join(name))
        .collect()
}

fn expand_path(path: &str) -> PathBuf {
    let trimmed = path.trim();
    let Some(home) = dirs::home_dir() else {
        return PathBuf::from(trimmed);
    };
    if trimmed == "~" {
        return home;
    }
    trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("$HOME/"))
        .map_or_else(|| PathBuf::from(trimmed), |rest| home.join(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_helper_advance(
        code: i32,
        output: &[u8],
    ) -> Result<ManagedCreateAdvanceCommandResolution<RemoteHmuxManagedCreateReceipt>, String> {
        let command =
            serde_json::from_value::<RemoteHmuxManagedCreateCommand>(managed_create_json())
                .unwrap();
        project_remote_managed_create_resolution(
            dure_session_runtime::host_command::decode_helper_response(code, output),
            command.target,
            RemoteManagedCreateProjection {
                idempotency_key: command.idempotency_key,
                bridge_nonce: command.bridge_nonce,
                session_id: command.session_id,
                workspace_id: command.workspace_id,
                provider_id: command.provider_id,
                initial_prompt_accepted: false,
            },
        )
    }

    #[test]
    fn helper_advance_preserves_reported_failure_instead_of_claiming_unknown_outcome() {
        let resolution = project_helper_advance(
            50,
            br#"{"schemaVersion":1,"error":{"code":"session_checkout_failed","message":"checkout is being removed"}}"#,
        );
        assert!(matches!(resolution, Err(message) if message ==
            "session_checkout_failed: checkout is being removed"));
    }

    #[test]
    fn helper_advance_retries_only_unknown_transport_outcome_with_the_same_request() {
        for output in [b"".as_slice(), br#"{"schemaVersion":1,"value":"#] {
            let resolution = project_helper_advance(0, output).unwrap();
            assert!(
                matches!(resolution, ManagedCreateAdvanceCommandResolution::RetrySame {
                reason: ManagedCreateRetrySameReason::CreateRetryable,
                code,
                ..
            } if code == "remote_session_checkout_outcome_unknown")
            );
        }
    }

    fn verified_dure_command(path: &Path) -> crate::dure_cli_install::DureChannelCommand {
        let executable = path.canonicalize().unwrap();
        crate::dure_cli_install::validate_executable_file(
            &executable,
            "test channel-pinned Dure CLI",
        )
        .unwrap();
        crate::dure_cli_install::DureChannelCommand {
            directory: executable.parent().unwrap().to_path_buf(),
            executable,
        }
    }

    fn managed_rehost_reconcile_command(
        legacy_hints: serde_json::Value,
    ) -> RemoteHmuxManagedRehostReconcileCommand {
        let mut value = serde_json::json!({
            "target": {
                "hostId": "host-1",
                "host": "server.example",
                "port": 22,
                "user": "developer",
                "auth": "key",
                "keyPath": "/does/not/exist",
                "hostKeyFingerprints": ["SHA256:abcdefghijklmnop"]
            },
            "operationId": "operation-1",
            "sourceSessionId": "session-source",
            "sourceWorkspaceId": "workspace-1",
            "bridgeNonce": "bridge-1"
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(legacy_hints.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    fn managed_rehost_legacy_hints(
        channel_epoch: &str,
        provider_id: &str,
        conversation_id: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "sourceFence": {
                "runnerPrincipal": "principal-1",
                "runnerInstance": "runner-1",
                "channelEpoch": channel_epoch,
                "hostInstanceId": "host-1",
                "terminalEpoch": "terminal-1"
            },
            "providerId": provider_id,
            "conversationId": conversation_id
        })
    }

    fn managed_rehost_changed_legacy_hints() -> serde_json::Value {
        serde_json::json!({
            "sourceFence": {
                "runnerPrincipal": "changed-principal",
                "runnerInstance": "changed-runner",
                "channelEpoch": "not-an-integer",
                "hostInstanceId": "changed-host",
                "terminalEpoch": "changed-terminal"
            },
            "providerId": "changed-provider",
            "conversationId": "changed-conversation"
        })
    }

    fn catalog_session(channel_epoch: &str) -> RemoteHmuxCatalogSession {
        RemoteHmuxCatalogSession {
            session_id: "session-1".into(),
            session_name: Some("remote-shell".into()),
            workspace_id: "workspace-1".into(),
            session_class: RemoteSessionClass::Standalone,
            lifecycle: RemoteSessionLifecycle::Ready,
            provider_id: "shell".into(),
            runner_principal: "principal-1".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: channel_epoch.into(),
            host_instance_id: "host-instance-1".into(),
            terminal_epoch: "terminal-1".into(),
            supported_protocol: RemoteHmuxVersionRange {
                minimum: RemoteHmuxProtocolVersion { major: 1, minor: 0 },
                maximum: RemoteHmuxProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec!["screen_snapshot".into(), "shared_terminal_input".into()],
            retirement_policy: None,
            launch_program: None,
            host_liveness: None,
            gateway_build_id: None,
        }
    }

    fn managed_create_json() -> serde_json::Value {
        serde_json::json!({
            "target": {
                "hostId": "host-1",
                "host": "server.example",
                "port": 22,
                "user": "developer",
                "auth": "key",
                "keyPath": "/does/not/exist",
                "hostKeyFingerprints": ["SHA256:abcdefghijklmnop"]
            },
            "idempotencyKey": "create-1",
            "sessionId": "session-1",
            "workspaceId": "workspace-1",
            "providerId": "codex",
            "permissionMode": "default",
            "bridgeNonce": "bridge-1",
            "cwd": "/repo/worktree",
            "initialRows": 40,
            "initialColumns": 100
        })
    }

    fn request() -> RemoteHmuxCatalogRequest {
        RemoteHmuxCatalogRequest {
            host_id: "host-1".into(),
            host: "server.example".into(),
            port: 22,
            user: "developer".into(),
            auth: "key".into(),
            secret_id: None,
            key_path: Some("/does/not/exist".into()),
            host_key_fingerprints: vec!["SHA256:abcdefghijklmnop".into()],
        }
    }

    #[test]
    fn fresh_remote_managed_create_deserializes_without_conversation_identity() {
        let request = serde_json::from_value::<RemoteHmuxManagedCreateCommand>(
            managed_create_json(),
        )
        .unwrap();
        let create = remote_managed_create_request(&request, vec!["codex".into()]).unwrap();
        assert!(create.conversation_identity().is_none());
        assert_eq!(
            create.required_managed_stop_request_version(),
            Some(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        );
    }

    #[test]
    fn remote_fresh_rehost_requires_an_exact_source_guard() {
        let mut value = managed_create_json();
        let object = value.as_object_mut().unwrap();
        object.remove("idempotencyKey");
        object.remove("sessionId");
        object.remove("workspaceId");
        object.insert("operationId".into(), serde_json::json!("switch-1"));
        object.insert("sourceSessionId".into(), serde_json::json!("session-1"));
        object.insert("sourceWorkspaceId".into(), serde_json::json!("workspace-1"));
        object.insert(
            "sourceFence".into(),
            serde_json::json!({
                "runnerPrincipal": "principal-1", "runnerInstance": "runner-1",
                "channelEpoch": "1", "hostInstanceId": "host-1", "terminalEpoch": "terminal-1"
            }),
        );
        let decode = |value| serde_json::from_value::<RemoteHmuxManagedRehostCommand>(value).unwrap();
        assert!(decode(value.clone()).source_guard().is_err());
        value["freshSourceGuard"] =
            serde_json::json!({ "runtimeRevision": "7", "outputSequence": "19" });
        let guard = decode(value.clone()).source_guard().unwrap().unwrap();
        assert_eq!(guard.terminal_epoch(), "terminal-1");
        assert_eq!(guard.runtime_revision(), 7);
        assert_eq!(guard.observed_through_output_seq(), 19);
        value["conversationId"] = serde_json::json!("conversation-1");
        assert!(decode(value.clone()).source_guard().is_err());
        value.as_object_mut().unwrap().remove("freshSourceGuard");
        assert!(decode(value.clone()).source_guard().unwrap().is_none());
        value["conversationId"] = serde_json::Value::Null;
        value["freshSourceGuard"] =
            serde_json::json!({ "runtimeRevision": "0", "outputSequence": "19" });
        assert!(decode(value).source_guard().is_err());
    }

    #[test]
    fn explicit_remote_managed_create_keeps_the_exact_conversation_seed() {
        let mut value = managed_create_json();
        value["conversationId"] = serde_json::json!("conversation-1");
        let request = serde_json::from_value::<RemoteHmuxManagedCreateCommand>(value).unwrap();
        let create = remote_managed_create_request(
            &request,
            vec!["codex".into(), "resume".into(), "conversation-1".into()],
        )
        .unwrap();
        let identity = create.conversation_identity().unwrap();
        assert_eq!(identity.provider_id(), "codex");
        assert_eq!(identity.conversation_id(), "conversation-1");
    }

    #[test]
    fn quick_dispatch_ssh_launch_options_reach_the_provider_adapter() {
        let mut value = managed_create_json();
        value["providerId"] = serde_json::json!("claude");
        value["initialPrompt"] = serde_json::json!("Fix the remote repo");
        value["launchOptions"] = serde_json::json!({
            "model": "opus", "effort": "high", "permissionOverride": "auto_edit",
            "setupCommand": "printf setup",
        });
        let prepared =
            prepare_remote_managed_create(serde_json::from_value(value).unwrap()).unwrap();
        assert!(prepared.expected.initial_prompt_accepted);
        assert_eq!(prepared.launch_plan.executable, "claude");
        for value in [
            "--model",
            "opus",
            "--effort",
            "high",
            "--permission-mode",
            "acceptEdits",
            "Fix the remote repo",
        ] {
            assert!(
                prepared
                    .launch_plan
                    .arguments
                    .iter()
                    .any(|arg| arg == value),
                "{value}"
            );
        }
        let command = prepared.request.launch_options.unwrap().command(vec![
            "printf".into(),
            "%s".into(),
            "literal ' value".into(),
        ]);
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "setupliteral ' value"
        );
    }

    #[test]
    fn quick_dispatch_ssh_rejects_invalid_or_unsupported_launch_selections() {
        for options in [
            serde_json::json!({"model":"unsafe model"}),
            serde_json::json!({"effort":"--inject"}),
            serde_json::json!({"setupCommand":"\u{001b}"}),
        ] {
            let mut value = managed_create_json();
            value["launchOptions"] = options;
            assert!(serde_json::from_value::<RemoteHmuxManagedCreateCommand>(value).is_err());
        }
        let mut value = managed_create_json();
        value["providerId"] = serde_json::json!("pi");
        value["launchOptions"] = serde_json::json!({"permissionOverride":"bypass_approvals"});
        assert!(prepare_remote_managed_create(serde_json::from_value(value).unwrap()).is_err());
    }

    #[test]
    fn quick_dispatch_ssh_rehost_preserves_only_resume_supported_selections() {
        let options: RemoteManagedLaunchOptions = serde_json::from_value(serde_json::json!({
            "model": "claude-opus", "setupCommand": "printf do-not-repeat",
        }))
        .unwrap();
        let recipe = options
            .rehost_plan("opencode", PermissionMode::Default)
            .unwrap();
        assert!(!recipe.arguments.iter().any(|arg| arg == "--model"));
        assert!(
            recipe
                .arguments
                .iter()
                .any(|arg| arg == hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER)
        );
        let recipe = options
            .rehost_plan("claude", PermissionMode::Default)
            .unwrap();
        assert!(recipe.arguments.iter().any(|arg| arg == "claude-opus"));
        assert!(
            !recipe
                .arguments
                .iter()
                .any(|arg| arg.contains("do-not-repeat"))
        );
    }

    #[test]
    fn legacy_remote_command_is_ignored_in_favor_of_the_provider_adapter() {
        let mut value = managed_create_json();
        value["command"] = serde_json::json!("codex --unreviewed-legacy-option");
        let request = serde_json::from_value::<RemoteHmuxManagedCreateCommand>(value).unwrap();
        let plan = remote_managed_launch_plan(
            &request.provider_id,
            request.permission_mode,
            request.conversation_id.as_deref(),
        )
        .unwrap();

        assert_eq!(
            plan,
            crate::managed_provider_launch::fresh_plan("codex", PermissionMode::Default).unwrap()
        );
    }

    #[test]
    fn remote_claude_create_and_rehost_share_one_settings_integration() {
        let settings_path = "/home/developer/.local/share/dure/provider-integrations/claude/settings/integration.json";
        let integration = ProviderRuntimeIntegrationV1::SettingsFile {
            path: settings_path.into(),
        };
        let create = crate::remote_provider_runtime::launch_command(
            "claude",
            remote_managed_launch_plan("claude", PermissionMode::Default, None).unwrap(),
            Some(&integration),
            Some("/home/developer/GitHub bridge"),
        )
        .unwrap();
        let recipe = remote_managed_rehost_recipe(
            "claude",
            PermissionMode::Default,
            Some("credential-1".into()),
            Some(&integration),
            Some("/home/developer/GitHub bridge"),
        )
        .unwrap();
        let create_command = create.join(" ");
        let recipe_command = recipe.command_template().join(" ");

        assert!(create_command.contains("/home/developer/GitHub bridge"));
        assert!(recipe_command.contains("/home/developer/GitHub bridge"));
        assert_eq!(create_command.matches(settings_path).count(), 1);
        assert_eq!(recipe_command.matches(settings_path).count(), 1);
        assert_eq!(
            recipe_command
                .matches(hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER)
                .count(),
            1
        );
        assert_eq!(recipe.launch_reference(), Some("credential-1"));
    }

    #[test]
    fn ssh_reconcile_uses_only_the_durable_operation_and_source_identity() {
        let original = remote_managed_rehost_reconcile_request(
            &managed_rehost_reconcile_command(managed_rehost_legacy_hints(
                "7",
                "codex",
                "conversation-1",
            )),
        )
        .unwrap();
        let changed_hints = remote_managed_rehost_reconcile_request(
            &managed_rehost_reconcile_command(managed_rehost_changed_legacy_hints()),
        )
        .unwrap();

        assert!(original.source().is_none());
        assert_eq!(original.operation_id(), "operation-1");
        assert_eq!(original.source_session_id(), "session-source");
        assert_eq!(original.source_workspace_id(), "workspace-1");
        assert_eq!(original.expected_provider_id(), None);
        assert_eq!(original.expected_conversation_id(), None);
        assert_eq!(
            serde_json::to_value(original).unwrap(),
            serde_json::to_value(changed_hints).unwrap(),
        );
    }

    #[test]
    fn malformed_explicit_remote_managed_create_conversation_stays_a_typed_error() {
        let mut value = managed_create_json();
        value["conversationId"] = serde_json::json!("unsafe conversation");
        let request = serde_json::from_value::<RemoteHmuxManagedCreateCommand>(value).unwrap();
        let error = remote_managed_create_request(&request, vec!["codex".into()]).unwrap_err();
        assert!(error.starts_with("remote_hmux_conversation_invalid:"));
    }

    #[test]
    fn an_unpinned_catalog_target_fails_before_authentication() {
        let mut request = request();
        request.host_key_fingerprints.clear();
        let error = build_config(&RemoteHmuxTargetRequest::from(&request)).unwrap_err();
        assert!(error.starts_with("remote_hmux_host_untrusted:"));
    }

    #[test]
    fn malformed_host_ids_fail_before_authentication() {
        let mut request = request();
        request.host_id = "../other-host".into();
        let error = build_config(&RemoteHmuxTargetRequest::from(&request)).unwrap_err();
        assert!(error.starts_with("remote_hmux_host_id_invalid:"));
    }

    #[test]
    fn remote_input_fence_uses_every_catalog_generation_component() {
        let fence = remote_session_fence(&catalog_session("7")).unwrap();
        assert_eq!(fence.session_id, "session-1");
        assert_eq!(fence.workspace_id, "workspace-1");
        assert_eq!(fence.runner_principal, "principal-1");
        assert_eq!(fence.runner_instance, "runner-1");
        assert_eq!(fence.channel_epoch, 7);
        assert_eq!(fence.host_instance_id, "host-instance-1");
        assert_eq!(fence.terminal_epoch, "terminal-1");
        assert!(remote_session_fence(&catalog_session("0")).is_err());
        assert!(remote_session_fence(&catalog_session("not-a-generation")).is_err());
    }

    #[test]
    fn remote_profile_launch_reference_is_the_exact_credential_reference() {
        assert_eq!(
            remote_profile_launch_reference(
                "codex",
                Some("account-b"),
                Some(".dure/accounts/codex-work"),
            )
            .unwrap()
            .as_deref(),
            Some("account-b")
        );
        assert_eq!(remote_profile_launch_reference("codex", None, None).unwrap(), None);
        assert!(remote_profile_launch_reference(
            "codex",
            Some("account-b"),
            Some(".dure/accounts/claude-work"),
        )
        .unwrap_err()
        .starts_with("remote_credential_directory_untrusted:"));
        assert!(remote_profile_launch_reference(
            "codex",
            Some("account-b"),
            None,
        )
        .unwrap_err()
        .starts_with("remote_hmux_credential_selection_invalid:"));
    }

    #[test]
    fn catalog_receipts_serialize_only_non_secret_remote_identity() {
        let receipt = RemoteHmuxCatalogReceipt {
            schema_version: 1,
            host_id: "host-1".into(),
            sessions: vec![RemoteCatalogSession {
                session_id: "session-1".into(),
                session_name: None,
                workspace_id: "workspace-1".into(),
                session_class: RemoteSessionClass::Standalone,
                lifecycle: RemoteSessionLifecycle::Ready,
                provider_id: "shell".into(),
                runner_principal: "principal".into(),
                runner_instance: "instance".into(),
                channel_epoch: "7".into(),
                host_instance_id: "host-instance".into(),
                terminal_epoch: "terminal-epoch".into(),
                supported_protocol: RemoteVersionRange {
                    minimum: RemoteProtocolVersion { major: 1, minor: 0 },
                    maximum: RemoteProtocolVersion { major: 1, minor: 0 },
                },
                capabilities: vec!["screen_snapshot".into()],
                retirement_policy: Some(
                    SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                        grace_period_ms: REMOTE_APP_STANDALONE_RETIREMENT_GRACE_MS,
                    },
                ),
                launch_program: Some("zsh".into()),
                host_liveness: Some(RemoteHostLiveness::Live),
                gateway_build_id: Some("build-current".into()),
            }
            .into()],
        };
        let value = serde_json::to_value(receipt).unwrap();
        assert_eq!(value["hostId"], "host-1");
        assert_eq!(value["sessions"][0]["channelEpoch"], "7");
        assert_eq!(
            value["sessions"][0]["retirementPolicy"]["kind"],
            "after_graceful_last_client_departure_v1"
        );
        assert_eq!(
            value["sessions"][0]["retirementPolicy"]["gracePeriodMs"],
            REMOTE_APP_STANDALONE_RETIREMENT_GRACE_MS
        );
        assert!(value["sessions"][0].get("sessionName").is_none());
        let serialized = value.to_string();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("keyPath"));
    }

    #[test]
    fn known_hosts_search_is_projected_to_deduplicated_sha256_pins() {
        let output = b"\
# Host server.example found: line 1\n\
server.example ssh-ed25519 aGVsbG8=\n\
server.example ssh-ed25519 aGVsbG8=\n\
server.example ssh-rsa d29ybGQ=\n";
        assert_eq!(
            fingerprints_from_known_hosts_search(output).unwrap(),
            vec![
                "SHA256:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ".to_string(),
                "SHA256:SG6kYiTRu0+2gPNPfJrZao8k7Ii+c+qOWmxlJg6cuKc".to_string(),
            ]
        );
    }

    #[test]
    fn local_shell_installs_an_exact_private_ssh_shim_idempotently() {
        let state = tempfile::tempdir().unwrap();
        let invocation = state.path().join("pinned-cli-invocation");
        let dure_cli = state.path().join("pinned-dure");
        fs::write(
            &dure_cli,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$DURE_APP_CHANNEL:$*\" >{}\n",
                shell_quote(invocation.to_str().unwrap())
            ),
        )
        .unwrap();
        set_private_executable_permissions(&dure_cli).unwrap();
        let dure_command = verified_dure_command(&dure_cli);
        let command = local_shell_with_ssh_shim_in(
            state.path(),
            Path::new("/bin/zsh"),
            state.path(),
            "dev-test-a1b2c3d4",
            &dure_command,
        )
        .unwrap();
        let repeated = local_shell_with_ssh_shim_in(
            state.path(),
            Path::new("/bin/zsh"),
            state.path(),
            "dev-test-a1b2c3d4",
            &dure_command,
        )
        .unwrap();
        assert_eq!(command, repeated);
        assert_eq!(command[0], "/usr/bin/env");
        assert!(command.iter().any(|entry| entry == "/bin/zsh"));
        assert_eq!(command.last().map(String::as_str), Some("-l"));
        let cli_text = dure_cli.canonicalize().unwrap();
        let bridge_digest = format!(
            "{:x}",
            Sha256::digest(cli_text.to_str().unwrap().as_bytes())
        );
        let script = state
            .path()
            .join(format!(".command-bridges-v2-{}/ssh", &bridge_digest[..16]));
        let script_text = fs::read_to_string(&script).unwrap();
        assert!(script_text.contains("DURE_APP_CHANNEL='dev-test-a1b2c3d4'"));
        assert!(script_text.contains(&shell_quote(cli_text.to_str().unwrap())));
        let old_path = tempfile::tempdir().unwrap();
        let old_dure = old_path.path().join("dure");
        fs::write(&old_dure, "#!/bin/sh\nexit 91\n").unwrap();
        set_private_executable_permissions(&old_dure).unwrap();
        let status = Command::new(&script)
            .arg("rts@server.example")
            .env("PATH", old_path.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            fs::read_to_string(&invocation).unwrap(),
            "dev-test-a1b2c3d4:__ssh rts@server.example\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&script).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(script.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn local_shell_installs_a_dure_shim_next_to_ssh() {
        let state = tempfile::tempdir().unwrap();
        let invocation = state.path().join("pinned-cli-invocation");
        let dure_cli = state.path().join("pinned-dure");
        fs::write(
            &dure_cli,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$DURE_APP_CHANNEL:$*\" >{}\n",
                shell_quote(invocation.to_str().unwrap())
            ),
        )
        .unwrap();
        set_private_executable_permissions(&dure_cli).unwrap();
        let dure_command = verified_dure_command(&dure_cli);
        local_shell_with_ssh_shim_in(
            state.path(),
            Path::new("/bin/zsh"),
            state.path(),
            "dev-test-a1b2c3d4",
            &dure_command,
        )
        .unwrap();
        let cli_text = dure_cli.canonicalize().unwrap();
        let bridge_digest = format!(
            "{:x}",
            Sha256::digest(cli_text.to_str().unwrap().as_bytes())
        );
        let shim = state
            .path()
            .join(format!(".command-bridges-v2-{}/dure", &bridge_digest[..16]));
        // A stale `dure` earlier on PATH must not shadow the pinned CLI the
        // shim execs, and arguments must pass through verbatim.
        let old_path = tempfile::tempdir().unwrap();
        let old_dure = old_path.path().join("dure");
        fs::write(&old_dure, "#!/bin/sh\nexit 91\n").unwrap();
        set_private_executable_permissions(&old_dure).unwrap();
        let status = Command::new(&shim)
            .args(["checkpoint", "wiring check"])
            .env("PATH", old_path.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            fs::read_to_string(&invocation).unwrap(),
            "dev-test-a1b2c3d4:checkpoint wiring check\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&shim).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn local_shell_fails_open_when_optional_ssh_shim_state_conflicts() {
        assert!(fail_open_optional_ssh_shim(Err(
            "command bridge shell init conflicts with existing private state".into()
        ))
        .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn local_shell_refuses_a_symlinked_ssh_shim_root() {
        use std::os::unix::fs::symlink;
        let state = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dure_cli = state.path().join("pinned-dure");
        fs::write(&dure_cli, "#!/bin/sh\nexit 0\n").unwrap();
        set_private_executable_permissions(&dure_cli).unwrap();
        let dure_command = verified_dure_command(&dure_cli);
        let cli_text = dure_cli.canonicalize().unwrap();
        let bridge_digest = format!(
            "{:x}",
            Sha256::digest(cli_text.to_str().unwrap().as_bytes())
        );
        symlink(
            outside.path(),
            state
                .path()
                .join(format!(".command-bridges-v2-{}", &bridge_digest[..16])),
        )
        .unwrap();
        let error = local_shell_with_ssh_shim_in(
            state.path(),
            Path::new("/bin/zsh"),
            state.path(),
            "dev-test-a1b2c3d4",
            &dure_command,
        )
        .unwrap_err();
        assert!(error.contains("symlink"));
        assert!(!outside.path().join("ssh").exists());
    }

}
