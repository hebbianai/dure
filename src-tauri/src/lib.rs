#![cfg(not(windows))]

mod accounts;
mod resources;
mod agent_naming;
mod agent_registry;
mod app_channel;
mod worktree_release;
mod app_home;
mod claude_collector;
mod codex_usage_collector;
mod codex_trust;
mod conv;
mod conversation_commands;
mod design_mode;
mod mobile_simulator;
mod screen_capture;
mod webview_storage;
mod desktop_notification;
mod diff;
mod forge;
mod diff_review_store;
mod discover;
mod dropped_files;
mod durable_window_exit;
mod dure_cli_install;
mod dure_checkpoint_backend;
mod dure_backend_coordinator;
mod dure_backend_transport;
mod dure_client_view_identity;
mod error_report;
mod existing_worktree;
mod external_workspace;
mod feedback_capture;
mod files;
mod local_directories;
mod ghx;
mod git_checkout_instance;
mod gitx;
mod git_availability;
mod hardware_profile;
mod hmux;
mod hmux_exact_termination;
mod hmux_input_contract;
// 통합 시험이 진짜 TLS 소켓 위에서 붙는 과정을 검사한다. 가짜 스트림으로는
// 인증서가 rustls 가 받는 모양인지, 프레임이 TLS 레코드 경계를 넘는지 알 수 없다.
pub mod hub;
mod hmux_diagnostics;
mod login_shell;
mod login_identity;
#[cfg(target_os = "macos")]
mod macos_dev_bundle;
#[cfg(target_os = "macos")]
mod macos_notification_bridge;
#[cfg(target_os = "macos")]
mod macos_notification_center;
mod managed_hook_rendering;
mod managed_hooks;
mod managed_create_resolution;
#[path = "hmux/managed_provider_launch.rs"]
mod managed_provider_launch;
mod mobile_pairing;
mod native_title_bar;
mod notification_click_qa;
mod provider_extension;
mod provider_preflight;
mod provider_wiring;
mod plugin_bundled_package;
mod plugin_installed_package_source;
#[cfg(all(unix, any(test, feature = "provider-conformance-test-support")))]
mod plugin_package_materialization;
pub mod plugin_native_cli;
pub mod plugin_native_apply_executor;
pub mod plugin_native_cli_inspect;
pub mod plugin_native_cli_state;
pub mod plugin_native_target_binding;
#[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
mod plugin_native_provider_route_conformance_tests;
pub mod plugin_catalog;
mod plugin_permission_commands;
mod plugin_issue_tracker;
mod plugin_permissions;
mod process_liveness;
#[cfg(debug_assertions)]
mod qa;
mod remote_accounts;
mod remote_git_checkout_helper;
mod remote_login;
mod remote_hmux;
mod scm_write;
mod remote_hmux_install;
mod remote_path;
mod remote_provider_runtime;
mod remote_github;
mod remote_platform;
mod secrets;
mod ssh_credential_registry;
mod session_credentials;
mod session_checkout;
mod standalone_create_request;
mod server;
mod share;
mod shell_corner;
mod telemetry;
mod traffic_lights;
mod window_resize;
mod spawn;
mod random_token;
mod ssh;
mod ssh_directory_commands;
mod sshconfig;
mod structured_terminal_access;
mod usage;
mod usage_cache;
mod usage_cache_runtime;
mod usage_recent_runtime;
mod working_directory;
#[cfg(test)]
mod windows_managed_provider_launch;

use conversation_commands::{
    list_conversations, list_provider_conversations, list_remote_provider_conversations,
    provider_conversation_metadata, read_provider_conversation_transcript, ssh_list_conversations,
    ssh_provider_conversation_metadata,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;
use tauri::Manager;
use tauri::State;

const APP_PROTOCOL_VERSION: u32 = 1;
const APP_FEATURES: &[&str] = &[
    "app.runtime-fingerprint-v1",
    "hmux.terminal-state-binary-v1",
    "hmux.standalone-terminal-surface-v1",
    "hmux.standalone-command-v1",
    "hmux.managed-create-v1",
    "hmux.managed-create-advance-v1",
    "hmux.managed-launch-prompt-v1",
    "hmux.managed-create-chain-stop-v1",
    "hmux.managed-create-chain-stop-v2",
    "hmux.managed-shell-v1",
    "hmux.managed-stop-v1",
    "hmux.initial-agent-prompt-v1",
    "hmux.update-control-plane-v1",
    "hmux.standalone-upgrade-v1",
    "hmux.remote-catalog-v1",
    "hmux.remote-pane-departure-v1",
    "hmux.remote-structured-terminal-v1",
    "hmux.remote-exact-input-v1",
    "hmux.remote-initial-agent-prompt-v1",
    "hmux.remote-known-host-trust-v1",
    "hmux.remote-provision-v1",
    "hmux.remote-create-v1",
    "hmux.remote-managed-create-v1",
    "hmux.remote-managed-create-advance-v1",
    "hmux.remote-managed-create-chain-stop-v1",
    "hmux.remote-managed-create-chain-stop-v2",
    "hmux.remote-managed-rehost-v1",
    "hmux.remote-managed-stop-v1",
    "provider-history.remote-v1",
    "ssh.credential-overlay-v1",
    "git.remote-checkout-helper-v1",
    "git.existing-worktree-v1",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppCapabilities {
    name: &'static str,
    package_version: &'static str,
    protocol_version: u32,
    build_id: &'static str,
    runtime_fingerprint: Option<&'static str>,
    features: &'static [&'static str],
}

fn embedded_runtime_fingerprint() -> Option<&'static str> {
    match env!("DURE_BACKEND_RUNTIME_FINGERPRINT") {
        "unavailable" => None,
        value => Some(value),
    }
}

#[tauri::command]
fn app_caps() -> AppCapabilities {
    AppCapabilities {
        name: "dure-backend",
        package_version: env!("CARGO_PKG_VERSION"),
        protocol_version: APP_PROTOCOL_VERSION,
        build_id: env!("DURE_BUILD_ID"),
        runtime_fingerprint: embedded_runtime_fingerprint(),
        features: APP_FEATURES,
    }
}

struct AppState {
    hmux: Arc<hmux::HmuxManager>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            hmux: Arc::new(hmux::HmuxManager::default()),
        }
    }
}

#[tauri::command]
async fn provider_preflight(
    providers: State<'_, provider_extension::DureAgentProviderState>,
    provider: String,
    command: String,
    cwd: String,
    terminal_env: Option<BTreeMap<String, Option<String>>>,
    include_version: Option<bool>,
) -> Result<provider_preflight::ProviderPreflight, String> {
    let command = providers.preflight_command(&provider, &command)?;
    let terminal_environment =
        hmux_client::TerminalEnvironment::new(terminal_env.unwrap_or_default())
            .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        provider_preflight::run(
            &provider,
            &command,
            std::path::Path::new(&cwd),
            terminal_environment,
            include_version.unwrap_or(true),
        )
    })
    .await
    .map_err(|error| format!("provider preflight task failed: {error}"))?
}

// ---------- Hmux session commands ----------

#[tauri::command]
async fn hmux_list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<hmux::SessionSummary>, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.list_sessions())
        .await
        .map_err(|error| format!("list Hmux sessions task failed: {error}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppHomeInfo {
    /// 앱 홈(계정·에이전트 레지스트리·사용량 캐시 등)의 실제 경로
    app_root: String,
    /// 무엇이 이 경로를 정했나 — env_override | renamed | legacy
    app_root_source: app_home::AppRootSource,
    /// CLI 설치 루트
    cli_install_root: String,
    /// uiPrefs 등 앱 상태 저장 위치 (Tauri app data dir)
    app_data_dir: Option<String>,
    /// hmux 세션 discovery root
    discovery_root: Option<String>,
}

/// 설정 › 데이터 위치 — 사용자가 "내 데이터가 어디 있나"를 앱 안에서 답할 수
/// 있게 한다(사용자 요구 2026-07-31). 경로와 해석 근거만 준다 — 열기는
/// 프론트가 opener 플러그인으로 한다.
#[tauri::command]
fn app_home_info(app: tauri::AppHandle) -> Result<AppHomeInfo, String> {
    let (app_root, app_root_source) = app_home::app_root_resolution()?;
    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    Ok(AppHomeInfo {
        app_root: app_root.to_string_lossy().into_owned(),
        app_root_source,
        cli_install_root: home
            .join(".local/share/hebbian-ide-cli")
            .to_string_lossy()
            .into_owned(),
        app_data_dir: app
            .path()
            .app_data_dir()
            .ok()
            .map(|path| path.to_string_lossy().into_owned()),
        discovery_root: hmux::product_discovery_root_path()
            .map(|path| path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
async fn hmux_local_state_gc(
    state: State<'_, AppState>,
    mode: String,
) -> Result<hmux_client::LocalStateGcReport, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.local_state_gc(&mode))
        .await
        .map_err(|error| format!("Hmux local state GC task failed: {error}"))?
}

#[tauri::command]
async fn hmux_inspect_sessions_exact(
    state: State<'_, AppState>,
    targets: Vec<hmux::ExactSessionTarget>,
) -> Result<Vec<hmux::ExactSessionInspectionResult>, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.inspect_sessions_exact(targets))
        .await
        .map_err(|error| format!("inspect exact Hmux sessions task failed: {error}"))?
}

#[tauri::command]
async fn list_existing_worktrees(
    repo: String,
    preferred_path: Option<String>,
) -> Result<existing_worktree::ExistingWorktreeList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        existing_worktree::list(&repo, preferred_path.as_deref())
    })
        .await
        .map_err(|error| format!("list existing worktrees task failed: {error}"))?
}

#[tauri::command]
async fn inspect_existing_worktree(
    state: State<'_, AppState>,
    repo: String,
    reference: existing_worktree::ExistingWorktreeRef,
) -> Result<existing_worktree::ExistingWorktreeCandidate, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        existing_worktree::inspect(&repo, reference, &hmux)
    })
    .await
    .map_err(|error| format!("inspect existing worktree task failed: {error}"))?
}

#[tauri::command]
async fn resolve_existing_worktree(
    state: State<'_, AppState>,
    repo: String,
    reference: existing_worktree::ExistingWorktreeRef,
    receipt_id: String,
) -> Result<existing_worktree::ExistingWorktreeResolution, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        existing_worktree::resolve(&repo, reference, &receipt_id, &hmux)
    })
    .await
    .map_err(|error| format!("resolve existing worktree task failed: {error}"))
}

#[tauri::command]
async fn recover_existing_worktree_ownership(
    state: State<'_, AppState>,
    repo: String,
    reference: existing_worktree::ExistingWorktreeRef,
    expected_receipt_id: Option<String>,
) -> Result<existing_worktree::ExistingWorktreeRecovery, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        existing_worktree::recover(&repo, reference, expected_receipt_id.as_deref(), &hmux)
    })
    .await
    .map_err(|error| format!("recover existing worktree ownership task failed: {error}"))
}

#[tauri::command]
async fn hmux_resolve_managed_rehost(
    session_id: String,
    workspace_id: String,
) -> Result<hmux_client::ManagedRehostResolutionResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        hmux::managed_rehost_resolution::resolve(&session_id, &workspace_id)
    })
    .await
    .map_err(|error| format!("resolve managed Hmux rehost task failed: {error}"))?
}

#[tauri::command]
async fn hmux_resolve_named_session(
    state: State<'_, AppState>,
    name: String,
) -> Result<hmux::SessionSummary, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.resolve_named_session(&name))
        .await
        .map_err(|error| format!("resolve named Hmux session task failed: {error}"))?
}

#[tauri::command]
async fn hmux_managed_conversation_identity(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    cwd: String,
) -> Result<hmux::ManagedConversationIdentity, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.inspect_managed_conversation_identity(
            &app,
            session_id,
            workspace_id,
            provider_id,
            cwd,
        )
    })
    .await
    .map_err(|error| format!("inspect managed conversation identity task failed: {error}"))?
}

#[tauri::command]
async fn hmux_existing_managed_writer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::ExistingManagedWriterRequest,
) -> Result<hmux::ExistingManagedWriterInspection, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.inspect_existing_managed_writer(&app, request)
    })
    .await
    .map_err(|error| format!("inspect existing managed writer task failed: {error}"))?
}

#[tauri::command]
async fn hmux_control_plane_census(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<hmux::ControlPlaneCensus, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.control_plane_census(&app))
        .await
        .map_err(|error| format!("Hmux control-plane census task failed: {error}"))?
}

#[tauri::command]
async fn hmux_activate_installed_build(
    state: State<'_, AppState>,
    build_id: String,
) -> Result<hmux::CurrentBuildChangeReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.activate_installed_build(build_id))
        .await
        .map_err(|error| format!("Hmux build activation task failed: {error}"))?
}

#[tauri::command]
async fn hmux_rollback_current_build(
    state: State<'_, AppState>,
) -> Result<hmux::CurrentBuildChangeReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.rollback_current_build())
        .await
        .map_err(|error| format!("Hmux build rollback task failed: {error}"))?
}

#[tauri::command]
async fn hmux_plan_recovery(
    state: State<'_, AppState>,
    request: hmux::RecoveryPlanRequest,
) -> Result<hmux::RecoveryPlanReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.plan_recovery(request))
        .await
        .map_err(|error| format!("Hmux recovery planning task failed: {error}"))?
}

#[tauri::command]
async fn hmux_retire_exited_sessions(
    state: State<'_, AppState>,
    items: Vec<hmux::RetireExitedItem>,
    confirmed: bool,
) -> Result<Vec<hmux::RetireExitedReceipt>, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.retire_exited_sessions(items, confirmed))
        .await
        .map_err(|error| format!("Hmux retire task failed: {error}"))?
}

#[tauri::command]
async fn hmux_cleanup_stale_sessions(
    state: State<'_, AppState>,
    items: Vec<hmux::CleanupStaleItem>,
    confirmed: bool,
) -> Result<Vec<hmux::CleanupStaleReceipt>, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.cleanup_stale_sessions(items, confirmed))
        .await
        .map_err(|error| format!("Hmux stale cleanup task failed: {error}"))?
}

#[tauri::command]
async fn hmux_execute_recovery(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::RecoveryExecutionRequest,
) -> Result<hmux::RecoveryExecutionReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.execute_recovery(&app, request))
        .await
        .map_err(|error| format!("Hmux recovery execution task failed: {error}"))?
}

#[tauri::command]
async fn hmux_reconcile_managed_recovery(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::ManagedRecoveryReconcileRequest,
) -> Result<Option<hmux::RecoveryExecutionReceipt>, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.reconcile_managed_recovery(&app, request))
        .await
        .map_err(|error| format!("Hmux managed recovery reconcile task failed: {error}"))?
}

#[tauri::command]
async fn hmux_upgrade_standalone(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::StandaloneUpgradeRequest,
) -> Result<hmux::StandaloneUpgradeReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.upgrade_standalone(&app, request))
        .await
    .map_err(|error| format!("Hmux standalone upgrade task failed: {error}"))?
}

#[tauri::command]
async fn hmux_standalone_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::AppStandaloneCreateRequest,
) -> Result<hmux::SessionSummary, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.create_app_standalone(&app, request))
    .await
    .map_err(|error| format!("create standalone Hmux session task failed: {error}"))?
}

#[tauri::command]
async fn hmux_standalone_abandon_unpresented(
    state: State<'_, AppState>,
    session_id: String,
    workspace_id: String,
) -> Result<hmux::PaneDepartureReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.abandon_unpresented_creation(session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("abandon unpresented Hmux creation task failed: {error}"))?
}

#[tauri::command]
async fn hmux_pane_depart_gracefully(
    state: State<'_, AppState>,
    owner_id: String,
    session_id: String,
    workspace_id: String,
) -> Result<hmux::PaneDepartureReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.depart_pane_gracefully(owner_id, session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("gracefully depart Hmux pane task failed: {error}"))?
}

#[tauri::command]
async fn hmux_pane_attachment_status(
    state: State<'_, AppState>,
    owner_id: String,
    session_id: String,
    workspace_id: String,
) -> Result<hmux::PaneAttachmentStatus, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.pane_attachment_status(owner_id, session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("inspect Hmux pane attachment task failed: {error}"))?
}

fn prepare_local_managed_create_launch(
    payload: managed_create_resolution::ManagedCreateCommandPayload,
) -> Result<hmux::ManagedCreateLaunch, String> {
    let managed_create_resolution::ManagedCreateCommandPayload {
        replace_current,
        idempotency_key,
        session_id,
        workspace_id,
        provider_id,
        conversation_id,
        permission_mode,
        credential_id,
        credential_directory,
        credential_generation,
        cwd,
        command: legacy_command,
        initial_prompt,
        rows,
        columns,
        terminal_env,
        terminal_default_colors,
    } = payload;
    let terminal_environment =
        hmux_client::TerminalEnvironment::new(terminal_env.unwrap_or_default())
            .map_err(|error| error.to_string())?;
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    let selected_provider_state_environment = accounts::prepare_managed_provider_profile(
        &provider_id,
        &home,
        credential_id.as_deref(),
        credential_directory.as_deref(),
    );
    let (credential_id, credential_generation, provider_state_environment) =
        match selected_provider_state_environment {
            Ok(environment) => (credential_id, credential_generation, environment),
            Err(_error) if replace_current => {
                eprintln!("managed exact Resume credential fallback: invalid_profile");
                (
                    None,
                    None,
                    accounts::prepare_managed_provider_profile(
                        &provider_id,
                        &home,
                        None,
                        None,
                    )?,
                )
            }
            Err(error) => return Err(error),
        };
    Ok(hmux::ManagedCreateLaunch {
        replace_current,
        idempotency_key,
        session_id,
        workspace_id,
        provider_id,
        conversation_id,
        permission_mode,
        credential_id,
        credential_generation,
        provider_state_environment,
        cwd,
        command: legacy_command,
        initial_prompt,
        rows,
        columns,
        terminal_environment,
        terminal_default_colors,
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn hmux_managed_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    conversation_id: Option<String>,
    permission_mode: hmux_client::PermissionMode,
    credential_id: Option<String>,
    credential_directory: Option<String>,
    credential_generation: Option<u64>,
    cwd: String,
    command: String,
    initial_prompt: Option<String>,
    rows: u16,
    columns: u16,
    terminal_env: Option<BTreeMap<String, Option<String>>>,
    terminal_default_colors: hmux_client::TerminalDefaultColors,
) -> Result<
    managed_create_resolution::LegacyManagedCreateReceipt<hmux::ManagedCreateSummary>,
    String,
> {
    let hmux = Arc::clone(&state.hmux);
    let launch = prepare_local_managed_create_launch(
        managed_create_resolution::ManagedCreateCommandPayload {
            replace_current: false,
            idempotency_key,
            session_id,
            workspace_id,
            provider_id,
            conversation_id,
            permission_mode,
            credential_id,
            credential_directory,
            credential_generation,
            cwd,
            command,
            initial_prompt,
            rows,
            columns,
            terminal_env,
            terminal_default_colors,
        },
    )?;
    let receipt = tauri::async_runtime::spawn_blocking(move || hmux.create_managed(&app, launch))
        .await
        .map_err(|error| format!("create managed Hmux session task failed: {error}"))??;
    Ok(managed_create_resolution::LegacyManagedCreateReceipt::new(
        receipt,
    ))
}

#[tauri::command]
async fn hmux_managed_create_advance_v1(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: managed_create_resolution::ManagedCreateCommandPayload,
    broker_timing: Option<bool>,
) -> Result<
    managed_create_resolution::ManagedCreateAdvanceCommandResolution<hmux::ManagedCreateSummary>,
    String,
> {
    let mut timing = hmux::managed_create_timing::ManagedCreateTiming::new(
        broker_timing == Some(true),
        &request.idempotency_key,
    );
    timing.mark("command.entry");
    let hmux = Arc::clone(&state.hmux);
    let launch = prepare_local_managed_create_launch(request)?;
    timing.mark("profile.ready");
    let (result, mut timing) = tauri::async_runtime::spawn_blocking(move || {
        timing.mark("worker.entry");
        let result = hmux.advance_managed_create_with_timing(&app, launch, &mut timing);
        timing.mark("worker.complete");
        (result, timing)
    })
    .await
    .map_err(|error| format!("create managed Hmux session task failed: {error}"))?;
    timing.mark("command.complete");
    result
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn hmux_managed_shell_create(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
    cwd: String,
    rows: u16,
    columns: u16,
    terminal_env: Option<BTreeMap<String, Option<String>>>,
    terminal_default_colors: hmux_client::TerminalDefaultColors,
) -> Result<hmux::ManagedCreateSummary, String> {
    let hmux = Arc::clone(&state.hmux);
    let terminal_environment =
        hmux_client::TerminalEnvironment::new(terminal_env.unwrap_or_default())
            .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        hmux.create_managed_shell(
            &app,
            idempotency_key,
            session_id,
            workspace_id,
            cwd,
            rows,
            columns,
            terminal_environment,
            terminal_default_colors,
        )
    })
    .await
    .map_err(|error| format!("create managed Hmux shell task failed: {error}"))?
}

#[tauri::command]
async fn hmux_promote_app_standalone_shell(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::ManagedShellPromotionRequest,
) -> Result<hmux::ManagedShellPromotionSummary, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.promote_app_standalone_shell(&app, request)
    })
    .await
    .map_err(|error| format!("promote standalone Hmux shell task failed: {error}"))?
}

#[tauri::command]
async fn hmux_sweep_app_standalone_shell(
    state: State<'_, AppState>,
    session_id: String,
    workspace_id: String,
    terminal_epoch: String,
    target_session_id: String,
    target_workspace_id: String,
    target_terminal_epoch: String,
) -> Result<hmux::PaneDepartureReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.sweep_app_standalone_shell(
            session_id,
            workspace_id,
            terminal_epoch,
            target_session_id,
            target_workspace_id,
            target_terminal_epoch,
        )
    })
    .await
    .map_err(|error| format!("sweep standalone Hmux shell task failed: {error}"))?
}

/// Exact standalone Host termination. Ownership policy stays in the caller;
/// the adapter only fences the requested session/workspace generation.
#[tauri::command]
async fn hmux_standalone_terminate(
    state: State<'_, AppState>,
    session_id: String,
    workspace_id: String,
) -> Result<(), String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.terminate_standalone_session(
            &session_id,
            &workspace_id,
            std::time::Duration::from_secs(3),
        )
    })
    .await
    .map_err(|error| format!("terminate standalone Hmux session task failed: {error}"))?
}

#[tauri::command]
async fn hmux_session_terminate_exact(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    workspace_id: String,
    terminal_epoch: String,
    session_class: hmux_client::SessionClass,
) -> Result<hmux::ExactSessionTerminationReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.terminate_live_session_exact(
            &app,
            &session_id,
            &workspace_id,
            &terminal_epoch,
            session_class,
        )
    })
    .await
    .map_err(|error| format!("terminate exact Hmux session task failed: {error}"))?
}

#[tauri::command]
async fn hmux_managed_stop(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    expected_fence: hmux::ManagedStopFence,
) -> Result<hmux_client::ManagedStopReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.stop_managed_session(
            &app,
            &stop_id,
            &session_id,
            &workspace_id,
            expected_fence,
        )
    })
    .await
    .map_err(|error| format!("stop managed Hmux session task failed: {error}"))?
}

#[tauri::command]
async fn hmux_managed_create_chain_stop_v1(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
) -> Result<hmux_client::ManagedCreateChainStopReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.stop_managed_create_chain(
            &app,
            &idempotency_key,
            &session_id,
            &workspace_id,
        )
    })
    .await
    .map_err(|error| format!("stop managed Hmux create chain task failed: {error}"))?
}

#[tauri::command]
async fn hmux_managed_create_chain_stop_v2(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
) -> Result<hmux_client::ManagedCreateChainStopReceiptV2, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || {
        hmux.stop_managed_create_chain_v2(
            &app,
            &idempotency_key,
            &session_id,
            &workspace_id,
        )
    })
    .await
    .map_err(|error| format!("stop managed Hmux create chain task failed: {error}"))?
}

#[tauri::command]
async fn hmux_convert_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::SessionConversionRequest,
) -> Result<hmux::SessionConversionReceipt, String> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.convert_session(&app, request))
        .await
        .map_err(|error| format!("convert Hmux session task failed: {error}"))?
}

/// 훅 4-state 보고를 hmux Host로 전달한다 — 얇은 어댑터 래퍼. 판단 로직은
/// 전부 hmux 모듈(report_agent_state)에 있고, 실패는 타입드 payload로 reject된다.
#[tauri::command]
async fn hmux_report_agent_state(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: hmux::AgentStateReportRequest,
) -> Result<hmux::AgentStateReportReceiptSummary, hmux::AgentStateReportFailure> {
    let hmux = Arc::clone(&state.hmux);
    tauri::async_runtime::spawn_blocking(move || hmux.report_agent_state(&app, request))
        .await
        .map_err(|error| hmux::AgentStateReportFailure {
            code: "hmux_report_task_failed".to_string(),
            message: format!("agent state report task failed: {error}"),
        })?
}

/// Resolve an Hmux Host attached inside a legacy terminal pane. This lets the
/// frontend present the inner durable session's identity instead of a generic
/// runtime label.
#[tauri::command(async)]
fn session_hmux(id: String) -> Option<hmux::SessionSummary> {
    hmux::legacy_attached_session_summary(&id)
}

// ---------- ssh ----------

#[tauri::command(async)]
fn ssh_secret_set(id: String, value: String) -> Result<(), String> {
    secrets::set_ssh_secret(&id, &value)
}

#[tauri::command(async)]
fn ssh_secret_copy(source: String, destination: String) -> Result<(), String> {
    secrets::copy_ssh_secret(&source, &destination)
}

#[tauri::command(async)]
fn ssh_credential_claim_stage(
    claims: Vec<ssh_credential_registry::SshCredentialClaimV1>,
) -> Result<(), String> {
    ssh_credential_registry::stage(claims)
}

#[tauri::command(async)]
fn ssh_credential_claim_activate(
    claims: Vec<ssh_credential_registry::SshCredentialClaimV1>,
) -> Result<(), String> {
    ssh_credential_registry::activate(claims)
}

#[tauri::command(async)]
fn ssh_credential_claim_retire(
    claims: Vec<ssh_credential_registry::SshCredentialClaimV1>,
) -> Result<(), String> {
    ssh_credential_registry::retire(claims)
}

#[tauri::command(async)]
fn ssh_credential_claim_reconcile(
    live_claims: Vec<ssh_credential_registry::SshCredentialClaimV1>,
    referenced_ids: Vec<String>,
) -> Result<ssh_credential_registry::SshCredentialCleanupReport, String> {
    ssh_credential_registry::reconcile(live_claims, referenced_ids)
}

/// Run a command over a throwaway ssh connection (blocking; used for
/// remote browsing / git status / worktree creation).
#[tauri::command(async)]
fn ssh_exec_once(
    opts: ssh::SshOptions,
    cmd: String,
    stdin: Option<String>,
) -> Result<ssh::ExecResult, String> {
    ssh::exec_once_with_stdin(&opts, &cmd, stdin.as_deref())
}

// ---------- git / fs ----------

#[tauri::command(async)]
fn git_status(path: String) -> gitx::GitStatus {
    gitx::status(&path)
}

#[tauri::command(async)]
fn create_worktree(
    repo: String,
    name: String,
    from: Option<String>,
) -> Result<gitx::WorktreeInfo, String> {
    gitx::create_worktree(&repo, &name, from.as_deref())
}

/// Run an arbitrary git subcommand for a local project (pull/push/fetch/…).
#[tauri::command(async)]
fn git_exec(path: String, args: Vec<String>) -> gitx::ExecOut {
    gitx::exec(&path, &args)
}

/// Bounded variant of `git_exec` — for best-effort subcommands (default-branch
/// fetch/probe) that must never block indefinitely. `git_exec` has no
/// timeout; this exists for callers that need one.
#[tauri::command(async)]
fn git_exec_bounded(path: String, args: Vec<String>, timeout_ms: u64) -> gitx::ExecOut {
    gitx::exec_bounded(&path, &args, timeout_ms)
}

/// 이 브랜치에 열린 리뷰. 폰의 Pull Request 탭이 읽는다.
#[tauri::command(async)]
fn agent_pull_request(path: String, branch: String) -> forge::ForgeReview {
    forge::review(&path, &branch)
}

/// 이 브랜치에 리뷰를 연다.
///
/// 폰이 일으킬 수 있는 첫 **바깥으로 나가는** 일이다 — 브랜치를 밀고 다른
/// 사람이 보는 리뷰를 만든다. 그래서 argv 는 여기 고정이고 폰이 주는 것은 제목,
/// 본문, 초안 여부 셋뿐이다. 브랜치와 저장소는 워크트리에서 온다.
#[tauri::command(async)]
fn agent_pull_request_create(
    path: String,
    branch: String,
    title: String,
    body: String,
    draft: bool,
) -> forge::ForgeReview {
    forge::create_review(&path, &branch, &title, &body, draft)
}

/// 기준 브랜치 이후의 커밋들. 폰의 커밋 탭이 읽는다.
#[tauri::command(async)]
fn agent_commits(path: String, base_ref: Option<String>) -> Result<Vec<diff::AgentCommit>, String> {
    diff::agent_commits(&path, base_ref.as_deref())
}

/// 워크트리의 fork-point(기본 브랜치와의 merge-base) 대비 파일별 numstat.
#[tauri::command(async)]
fn agent_diff_stat(path: String, base_ref: Option<String>) -> Result<diff::AgentDiffStat, String> {
    diff::agent_diff_stat(&path, base_ref.as_deref())
}

/// 워크트리의 fork-point 대비 full unified diff.
#[tauri::command(async)]
fn agent_diff(path: String, base_ref: Option<String>) -> Result<String, String> {
    diff::agent_diff(&path, base_ref.as_deref())
}

/// 리뷰를 부탁할 만한 사람들, 최근 함께 일한 순.
#[tauri::command(async)]
fn agent_reviewer_candidates(path: String) -> Option<Vec<forge::Reviewer>> {
    forge::reviewer_candidates(&path)
}

/// 이 리뷰의 리뷰어를 바꾼다. 더할 사람과 뺄 사람만.
#[tauri::command(async)]
fn agent_set_reviewers(
    path: String,
    number: u64,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), forge::ForgeUnavailable> {
    forge::set_reviewers(&path, number, &add, &remove)
}

/// 커밋 하나의 본문과 바뀐 파일들. 폰이 커밋 목록의 한 줄을 눌렀을 때 온다.
#[tauri::command(async)]
fn agent_commit_detail(
    path: String,
    commit: String,
) -> Result<diff::AgentCommitDetail, String> {
    diff::agent_commit_detail(&path, &commit)
}

/// 폰이 부탁한 저장소 변경. 무엇이 허용되는지는 `scm_write.rs` 가 정한다.
///
/// 명령 하나에 닫힌 갈래 하나. 넷으로 나누면 각각의 인증·검증 자리가 넷이 되고,
/// 그중 하나에서 검사를 빠뜨려도 나머지 셋은 멀쩡해 보인다.
#[tauri::command(async)]
fn agent_scm_write(
    path: String,
    action: scm_write::Action,
) -> Result<scm_write::Receipt, String> {
    scm_write::apply(&path, &action)
}

/// 이 저장소의 브랜치들. 전환 시트가 열릴 때 한 번 읽는다.
#[tauri::command(async)]
fn agent_branches(path: String) -> Result<Vec<scm_write::BranchRow>, String> {
    scm_write::branches(&path)
}

/// 파일 하나의 패치. 폰이 목록에서 한 줄을 눌렀을 때 온다.
#[tauri::command(async)]
fn agent_file_diff(
    path: String,
    base_ref: Option<String>,
    file: String,
    commit: Option<String>,
) -> Result<diff::AgentFileDiff, String> {
    diff::agent_file_diff(&path, base_ref.as_deref(), &file, commit.as_deref())
}

/// 패널 새로고침용: 같은 스냅샷에서 stat + full diff를 한 번에.
#[tauri::command(async)]
fn agent_diff_review(
    path: String,
    base_ref: Option<String>,
) -> Result<diff::AgentDiffReview, String> {
    diff::agent_diff_review(&path, base_ref.as_deref())
}

/// Run a command in a login shell (so provider CLIs like `claude`/`codex` are
/// on PATH). Used by the settings UI to drive `claude mcp`, `claude plugin`, etc.
#[tauri::command(async)]
fn run_shell(cmd: String) -> gitx::ExecOut {
    match login_shell::run(&cmd) {
        Ok(out) => gitx::ExecOut {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code().unwrap_or(-1),
        },
        Err(e) => gitx::ExecOut { stdout: String::new(), stderr: format!("shell: {e}"), code: -1 },
    }
}

/// Write text to an absolute path, creating parent dirs. Used to save config
/// files (settings.json / config.toml) from the settings UI.
#[tauri::command(async)]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, content).map_err(|e| e.to_string())
}

/// Returns (command, path, branch) so the frontend can run the same
/// worktree creation on a remote host over ssh.
#[tauri::command]
fn worktree_command(repo: String, name: String, from: Option<String>) -> (String, String, String) {
    gitx::worktree_command(&repo, &name, from.as_deref())
}

/// 브랜치 명시 워크트리 프로비저닝(신규/기존 브랜치/adopt) — 브랜치 피커용.
#[tauri::command(async)]
fn provision_worktree(plan: gitx::WorktreeProvisionPlan) -> Result<gitx::WorktreeInfo, String> {
    gitx::provision_worktree(&plan)
}

/// 위와 동일한 프로비저닝을 원격 호스트에서 실행할 셸 명령 + wt 경로.
#[tauri::command]
fn provision_worktree_command(plan: gitx::WorktreeProvisionPlan) -> (String, String) {
    gitx::provision_worktree_command(&plan)
}

/// 저장소의 로컬 브랜치 목록 + 각 브랜치의 체크아웃 워크트리 경로.
#[tauri::command(async)]
fn list_branches(repo: String) -> Result<Vec<gitx::BranchInfo>, String> {
    gitx::list_branches(&repo)
}

/// 위 목록을 원격 호스트에서 수집할 셸 명령(parse_branches로 파싱).
#[tauri::command]
fn list_branches_command(repo: String) -> String {
    gitx::list_branches_command(&repo)
}

/// GitHub CLI 실행 — 인증은 gh에 위임한다(자체 토큰 보관 없음).
///
/// 0이 아닌 종료도 정상 결과로 돌려준다: 미인증·스코프 부족·레포 아님이 전부
/// 호출부가 안내를 갈라야 하는 상태다. 파싱은 TS(src/lib/github/)가 맡는다.
#[tauri::command(async)]
fn gh_exec(repo: Option<String>, args: Vec<String>, timeout_ms: Option<u64>) -> ghx::GhExecOut {
    ghx::exec(repo.as_deref(), &args, timeout_ms.unwrap_or(15_000))
}

/// 원격 브랜치 스캔 출력 파서.
#[tauri::command]
fn parse_branches(output: String) -> Vec<gitx::BranchInfo> {
    gitx::parse_branches(&output)
}

/// 상태 표시줄 자원 위젯의 표본. `path`는 디스크 여유를 잴 볼륨을 고르는 데만
/// 쓰이고, 없으면 디스크 항목이 비어 온다.
#[tauri::command(async)]
fn system_resources(path: Option<String>) -> resources::SystemResources {
    resources::sample(path.as_deref())
}

/// Image bytes read straight from the OS clipboard, base64 for the webview.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardImage {
    data_b64: String,
    ext: String,
}

#[cfg(target_os = "macos")]
mod clipboard_image;

#[cfg(target_os = "macos")]
fn clipboard_image_png() -> Option<Vec<u8>> {
    clipboard_image::read_png()
}

#[cfg(not(target_os = "macos"))]
fn clipboard_image_png() -> Option<Vec<u8>> {
    None
}

/// Read the image on the OS clipboard, bypassing the webview's own snapshot.
///
/// WKWebView builds `ClipboardEvent.clipboardData` from a copy of the pasteboard
/// its web content process took, and a process that was not running when the
/// pasteboard last changed keeps serving the older copy. So an image captured
/// before the agent window opened pastes as whatever was copied before it. The
/// app process reads NSPasteboard itself and always sees current contents.
///
/// Returns None when the platform has no native reader or the clipboard holds
/// no image; callers then fall back to the webview's bytes.
#[tauri::command(async)]
fn read_clipboard_image() -> Option<ClipboardImage> {
    use base64::Engine;
    let png = clipboard_image_png()?;
    Some(ClipboardImage {
        data_b64: base64::engine::general_purpose::STANDARD.encode(png),
        ext: "png".to_string(),
    })
}

/// Save pasted image bytes to a temp file, return its path (local paste).
#[tauri::command(async)]
fn save_temp_image(data_b64: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    let safe_ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let name = format!(
        "agent-ide-paste-{}.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        if safe_ext.is_empty() { "png".to_string() } else { safe_ext }
    );
    let path = std::env::temp_dir().join(name);
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 로컬 파일 읽기 (뷰어용). 종류/크기 판별, 상한 25MB.
#[tauri::command(async)]
fn read_file(path: String) -> Result<files::FileContent, String> {
    files::read_local(&path)
}

/// 원격 파일 읽기 — 저장된 host 옵션의 일회성 연결. (interactive 세션 경유와
/// 그 세션 cwd 기준 상대 경로 절대화는 legacy 데몬 은퇴(2026-08-16)와 함께
/// 제거됐다.)
#[tauri::command(async)]
fn ssh_read_file(
    opts: Option<ssh::SshOptions>,
    path: String,
) -> Result<files::FileContent, String> {
    if let Some(opts) = opts {
        files::read_remote(|cmd| ssh::exec_once(&opts, cmd).map(|r| r.stdout), &path)
    } else {
        Err("An SSH session or connection options are required".into())
    }
}

/// 로컬 텍스트 파일 저장 (에디터용). 임시 파일 + rename 으로 원자적 교체.
#[tauri::command(async)]
fn write_file(path: String, content: String) -> Result<u64, String> {
    files::write_local(&path, &content)
}

/// 원격 텍스트 파일 저장 — 읽기와 동일한 일회성 연결 규칙을 따른다.
#[tauri::command(async)]
fn ssh_write_file(
    opts: Option<ssh::SshOptions>,
    path: String,
    content: String,
) -> Result<u64, String> {
    if let Some(opts) = opts {
        files::write_remote(|cmd| ssh::exec_once(&opts, cmd).map(|r| r.stdout), &path, &content)
    } else {
        Err("An SSH session or connection options are required".into())
    }
}

/// SSH Files 영구 삭제. 트리는 live terminal session에 종속되지 않으므로
/// 저장된 host 연결 옵션으로 일회성 연결하고, files 모듈이 workspace root와
/// 대상의 정확한 경계를 검증한 뒤 삭제한다.
#[tauri::command(async)]
fn ssh_delete_file(
    opts: ssh::SshOptions,
    root: String,
    path: String,
    is_directory: bool,
) -> Result<(), String> {
    files::delete_remote(
        |command| ssh::exec_once(&opts, command).map(|result| result.stdout),
        &root,
        &path,
        is_directory,
    )
}

/// 열려던 경로가 없을 때, 저장소에서 같은 이름의 파일을 찾아 후보를 돌려준다.
/// 에이전트가 "TerminalView.tsx"처럼 디렉토리 없이 이름만 말하는 경우가 잦다.
#[tauri::command(async)]
fn find_file_candidates(path: String, limit: Option<usize>) -> Vec<String> {
    files::find_local_candidates(&path, limit.unwrap_or(20).clamp(1, 100))
}

/// 원격판. 읽기와 같은 일회성 연결 규칙을 따른다.
#[tauri::command(async)]
fn ssh_find_file_candidates(
    opts: Option<ssh::SshOptions>,
    path: String,
    limit: Option<usize>,
) -> Vec<String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    if let Some(opts) = opts {
        files::find_remote_candidates(
            |cmd| ssh::exec_once(&opts, cmd).map(|r| r.stdout),
            &path,
            limit,
        )
    } else {
        Vec::new()
    }
}

/// 최근 N시간 Claude/Codex 토큰 사용량 (로컬 세션 로그 집계).
#[tauri::command]
async fn usage_recent_snapshot(
    runtime: tauri::State<'_, usage_recent_runtime::UsageRecentRuntime>,
    collector: tauri::State<'_, codex_usage_collector::CodexUsageCollector>,
    refresh: Option<usage_recent_runtime::UsageRefreshProvider>,
) -> Result<usage::UsageRecentSnapshot, String> {
    if matches!(
        refresh,
        Some(usage_recent_runtime::UsageRefreshProvider::Codex)
    ) {
        collector.refresh_all().await;
    }
    let runtime = runtime.inner().clone();
    let mut snapshot = tauri::async_runtime::spawn_blocking(move || {
        if refresh.is_some() {
            runtime.refresh()
        } else {
            runtime.snapshot()
        }
    })
    .await
    .map_err(|error| format!("usage snapshot task failed: {error}"))?;
    let account_snapshots = collector.snapshots();
    snapshot.five_hours.codex_account_snapshots = account_snapshots.clone();
    snapshot.twenty_four_hours.codex_account_snapshots = account_snapshots;
    Ok(snapshot)
}

#[tauri::command]
async fn usage_recent(
    hours: u64,
    runtime: tauri::State<'_, usage_recent_runtime::UsageRecentRuntime>,
    collector: tauri::State<'_, codex_usage_collector::CodexUsageCollector>,
) -> Result<usage::UsageReport, String> {
    let hours = hours.clamp(1, 24 * 30);
    let mut report = if hours == 5 || hours == 24 {
        let runtime = runtime.inner().clone();
        let snapshot = tauri::async_runtime::spawn_blocking(move || runtime.snapshot())
            .await
            .map_err(|error| format!("usage snapshot task failed: {error}"))?;
        if hours == 5 { snapshot.five_hours } else { snapshot.twenty_four_hours }
    } else {
        tauri::async_runtime::spawn_blocking(move || usage::usage_recent(hours))
            .await
            .map_err(|error| format!("usage scan task failed: {error}"))?
    };
    report.codex_account_snapshots = collector.snapshots();
    Ok(report)
}

/// 최근 N일 사용량 통계 (세션·턴·일별 포함) — 설정 '통계 및 사용량' 페이지용.
#[tauri::command]
async fn usage_stats(days: u64) -> Result<usage::UsageStats, String> {
    tauri::async_runtime::spawn_blocking(move || usage::usage_stats(days.clamp(1, 365)))
        .await
        .map_err(|error| format!("usage stats task failed: {error}"))
}

/// 프로바이더 계정 프로필용 설정 디렉토리 생성.
/// Claude/Codex overlay는 accounts 모듈의 검토된 allowlist만 canonical과
/// 공유한다. Kimi는 기존 whole-directory alias를 유지한다.
#[tauri::command(async)]
fn create_account_dir(provider: String, name: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let (app_root, _) = app_home::app_root_resolution()?;
    let dir = accounts::create_account_profile_directory_at_app_root(
        &provider,
        &app_root,
        std::path::Path::new(&home),
        &name,
    )?;
    Ok(dir.to_string_lossy().into_owned())
}

// ---------- macOS 권한 (설정 창) ----------

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

// AnyClass::get은 이미 로드된 클래스만 찾는다 — 빈 extern 블록으로 두 프레임워크를
// 링크해 AVCaptureDevice·CBManager가 런타임에 존재하게 한다.
#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}
#[cfg(target_os = "macos")]
#[link(name = "CoreBluetooth", kind = "framework")]
extern "C" {}

/// AVAuthorizationStatus / CBManagerAuthorization 은 같은 값 배치를 쓴다:
/// 0 = notDetermined, 1 = restricted, 2 = denied, 3 = authorized.
/// 아직 물어보지 않은 상태(0)는 "허용 안 됨"이 아니라 "모름"이므로 None으로 둔다 —
/// 여기서 false로 단정하면 실제로는 쓸 수 있는 권한을 막힌 것처럼 보여준다.
#[cfg(target_os = "macos")]
fn authorization_to_option(status: isize) -> Option<bool> {
    match status {
        3 => Some(true),
        1 | 2 => Some(false),
        _ => None,
    }
}

/// 프롬프트를 띄우지 않는 상태 조회. `authorizationStatusForMediaType:` 과
/// `CBManager.authorization` 은 둘 다 순수 조회라 권한 요청을 유발하지 않는다.
#[cfg(target_os = "macos")]
fn capture_authorization(media_type: &str) -> Option<bool> {
    use objc2::runtime::AnyClass;
    use objc2::{msg_send, rc::Retained};
    use objc2_foundation::NSString;

    let class = AnyClass::get(c"AVCaptureDevice")?;
    let media: Retained<NSString> = NSString::from_str(media_type);
    let status: isize =
        unsafe { msg_send![class, authorizationStatusForMediaType: &*media] };
    authorization_to_option(status)
}

#[cfg(target_os = "macos")]
fn bluetooth_authorization() -> Option<bool> {
    use objc2::runtime::AnyClass;
    use objc2::msg_send;

    // CBManager.authorization 은 클래스 프로퍼티(macOS 10.15+). 인스턴스를 만들면
    // 그 자체로 권한 프롬프트가 뜨므로 절대 만들지 않는다.
    let class = AnyClass::get(c"CBManager")?;
    let status: isize = unsafe { msg_send![class, authorization] };
    authorization_to_option(status)
}

/// 실측 가능한 macOS 권한 상태. true/false = 실측, None = 실측 불가(수동 확인).
#[derive(serde::Serialize)]
struct MacosPermissions {
    accessibility: Option<bool>,
    screen_recording: Option<bool>,
    full_disk: Option<bool>,
    microphone: Option<bool>,
    camera: Option<bool>,
    bluetooth: Option<bool>,
}

#[tauri::command]
fn macos_permissions() -> MacosPermissions {
    #[cfg(target_os = "macos")]
    {
        let accessibility = Some(unsafe { AXIsProcessTrusted() });
        let screen_recording = Some(unsafe { CGPreflightScreenCaptureAccess() });
        // macOS has no non-triggering Full Disk Access status API. Reading a
        // protected folder here would itself request App Data access.
        let full_disk = None;
        MacosPermissions {
            accessibility,
            screen_recording,
            full_disk,
            microphone: capture_authorization("soun"),
            camera: capture_authorization("vide"),
            bluetooth: bluetooth_authorization(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        MacosPermissions {
            accessibility: None,
            screen_recording: None,
            full_disk: None,
            microphone: None,
            camera: None,
            bluetooth: None,
        }
    }
}

// ---------- 설치된 글꼴 (설정 › 외관 › 글꼴군) ----------

/// 이 기기에 설치된 글꼴 가족 하나.
#[derive(Clone, serde::Serialize)]
struct FontFamily {
    name: String,
    /// 고정폭인가 — 설정의 글꼴 목록은 이것으로 순서를 바꾸지 않는다(한
    /// 목록이다). 부팅 스모크가 고정폭을 몇 개 찾았는지 적는 데 쓴다.
    monospaced: bool,
}

/// CTFontSymbolicTraits의 kCTFontTraitMonoSpace.
#[cfg(target_os = "macos")]
const CT_FONT_TRAIT_MONO_SPACE: u32 = 1 << 10;

// CoreText를 쓴다. NSFontManager도 같은 목록을 주지만 AppKit이라 메인 스레드
// 전용이고, 실측하니 첫 호출이 1.4~4.4초(콜드 캐시 4.8초) 걸린다 — 동기
// 커맨드는 메인 스레드에서 도는데 그 사이 app.emit이 막혀 모든 창의 터미널
// 출력까지 멈춘다. CoreText의 이 함수들은 스레드 안전해서 async 커맨드로
// 워커 스레드에 보낼 수 있다.
#[cfg(target_os = "macos")]
#[link(name = "CoreText", kind = "framework")]
extern "C" {
    /// CFArrayRef<CFStringRef> — NSArray<NSString*>와 toll-free bridged. Copy라 +1.
    fn CTFontManagerCopyAvailableFontFamilyNames() -> *mut objc2::runtime::AnyObject;
    /// CFStringRef를 받아 CTFontRef를 만든다. Create라 +1.
    fn CTFontCreateWithName(
        name: *const objc2::runtime::AnyObject,
        size: f64,
        matrix: *const std::ffi::c_void,
    ) -> *mut std::ffi::c_void;
    fn CTFontGetSymbolicTraits(font: *mut std::ffi::c_void) -> u32;
}
#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *mut std::ffi::c_void);
}

/// 한 번 읽으면 캐시한다 — 글꼴이 설치/삭제되는 일은 드물고, 설정 창을 여닫을
/// 때마다 수백 번의 CoreText 조회를 반복할 이유가 없다.
#[cfg(target_os = "macos")]
static FONT_FAMILY_CACHE: std::sync::OnceLock<Vec<FontFamily>> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn load_font_families() -> Vec<FontFamily> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSArray, NSString};

    let raw = unsafe { CTFontManagerCopyAvailableFontFamilyNames() };
    if raw.is_null() {
        return Vec::new();
    }
    // Copy 함수가 준 +1 소유권을 그대로 넘겨받는다(추가 retain 없음).
    let families: Retained<NSArray<NSString>> =
        match unsafe { Retained::from_raw(raw.cast()) } {
            Some(array) => array,
            None => return Vec::new(),
        };

    let mut out: Vec<FontFamily> = Vec::with_capacity(families.len());
    for family in families.iter() {
        let name = family.to_string();
        // 점으로 시작하는 이름은 시스템 내부용(.SF NS 등)이라 고르게 두지 않는다.
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let name_ptr: *const AnyObject = (&*family as *const NSString).cast();
        let font = unsafe { CTFontCreateWithName(name_ptr, 12.0, std::ptr::null()) };
        let monospaced = if font.is_null() {
            false
        } else {
            let traits = unsafe { CTFontGetSymbolicTraits(font) };
            unsafe { CFRelease(font) };
            traits & CT_FONT_TRAIT_MONO_SPACE != 0
        };
        out.push(FontFamily { name, monospaced });
    }
    out.sort_by_key(|family| family.name.to_lowercase());
    out
}

/// 설치된 글꼴 가족 목록.
///
/// async다 — 동기 커맨드는 macOS 메인 스레드에서 돌고, 그동안 app.emit이 막혀
/// 모든 창의 터미널 출력이 멈춘다. CoreText 조회는 스레드 안전하다.
/// 실패하면 빈 목록을 돌려주고 호출자는 기본 스택으로 되돌아간다.
#[tauri::command]
async fn system_font_families() -> Vec<FontFamily> {
    #[cfg(target_os = "macos")]
    {
        FONT_FAMILY_CACHE.get_or_init(load_font_families).clone()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// 자동화·로컬 네트워크는 상태를 조회할 API가 없다. 대신 그 권한을 실제로
/// 쓰는 최소 동작을 한 번 해서 macOS가 TCC 프롬프트를 띄우게 만든다 — 그래야
/// 사용자가 "수동 확인" 화면에서 벗어날 수 있다. 성공/실패가 곧 권한 여부는
/// 아니므로 상태는 여전히 알 수 없고, 반환값은 "요청을 시도했다"는 뜻이다.
///
/// async다 — 동기 커맨드는 메인 스레드를 잡아 모든 창의 터미널 출력을 멈춘다.
#[tauri::command]
async fn request_privacy_prompt(kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match kind.as_str() {
            // Apple 이벤트로 다른 앱을 건드리면 자동화 프롬프트가 뜬다.
            "automation" => {
                let child = std::process::Command::new("osascript")
                    .args(["-e", "tell application \"System Events\" to return 1"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                // 기다리거나 죽이지 않는다. osascript는 TCC 알림이 떠 있는 동안
                // 응답을 기다리므로, 시간을 끊고 kill하면 하필 "사용자가 지금
                // 읽고 있는" 경우에만 프롬프트를 걷어내게 된다. 결과도 필요 없다
                // (허용 여부는 어차피 조회할 수 없다). 좀비만 뒤에서 거둔다.
                std::thread::spawn(move || {
                    let mut child = child;
                    let _ = child.wait();
                });
                Ok(())
            }
            // mDNS 멀티캐스트로 한 발 보내면 로컬 네트워크 프롬프트가 뜬다.
            "local_network" => {
                let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
                socket
                    .set_write_timeout(Some(std::time::Duration::from_secs(1)))
                    .map_err(|e| e.to_string())?;
                // 실패해도 오류로 보지 않는다 — 권한이 없어서 막힌 것 자체가
                // 프롬프트를 띄우는 계기이고, 그게 이 호출의 목적이다.
                let _ = socket.send_to(&[0u8], "224.0.0.251:5353");
                Ok(())
            }
            other => Err(format!("unknown privacy prompt: {other}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("macOS privacy prompts are unavailable on this platform".to_string())
    }
}

/// 시스템 설정의 개인정보 보호 패널을 연다. pane은 허용목록으로 제한.
#[tauri::command]
fn open_privacy_pane(pane: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const ALLOWED: &[&str] = &[
            "Privacy_Microphone",
            "Privacy_Camera",
            "Privacy_ScreenCapture",
            "Privacy_Accessibility",
            "Privacy_AllFiles",
            "Privacy_Automation",
            "Privacy_LocalNetwork",
            "Privacy_Bluetooth",
        ];
        let url = if ALLOWED.contains(&pane.as_str()) {
            format!("x-apple.systempreferences:com.apple.preference.security?{pane}")
        } else {
            "x-apple.systempreferences:com.apple.preference.security".to_string()
        };
        std::process::Command::new("open")
            .arg(url)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        Err("macOS privacy settings are unavailable on this platform".to_string())
    }
}

/// List a repo's worktrees annotated with externally-created claude/codex
/// session evidence found on disk.
#[tauri::command(async)]
fn scan_worktrees(repo: String) -> Result<Vec<discover::DetectedWorktree>, String> {
    discover::scan_worktrees(&repo)
}

/// Shell script that runs the same worktree/session scan on a remote host
/// (executed by the frontend via ssh_exec_once).
#[tauri::command]
fn scan_worktrees_command(repo: String) -> String {
    discover::scan_command(&repo)
}

/// Parse the remote scan script's output into worktrees.
#[tauri::command]
fn parse_worktree_scan(output: String) -> Vec<discover::DetectedWorktree> {
    discover::parse_scan(&output)
}

/// Copy a claude session log to another worktree's project dir (fork).
#[tauri::command(async)]
fn copy_claude_session(from_cwd: String, to_cwd: String, conv_id: String) -> Result<(), String> {
    discover::copy_claude_session(&from_cwd, &to_cwd, &conv_id)
}

/// Same copy as a shell command, for remote (ssh) forks.
#[tauri::command]
fn copy_claude_session_command(from_cwd: String, to_cwd: String, conv_id: String) -> String {
    discover::copy_claude_session_command(&from_cwd, &to_cwd, &conv_id)
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        app_caps, create_account_dir, prepare_local_managed_create_launch, APP_FEATURES,
        APP_PROTOCOL_VERSION,
    };
    #[cfg(target_os = "macos")]
    use super::macos_permissions;

    struct ScopedAccountHome {
        home: Option<std::ffi::OsString>,
        dure_home: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl ScopedAccountHome {
        fn set(home: &std::path::Path, dure_home: &std::path::Path) -> Self {
            let guard = crate::app_home::ENVIRONMENT_TEST_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous_home = std::env::var_os("HOME");
            let previous_dure_home = std::env::var_os("DURE_HOME");
            std::env::set_var("HOME", home);
            std::env::set_var("DURE_HOME", dure_home);
            Self {
                home: previous_home,
                dure_home: previous_dure_home,
                _guard: guard,
            }
        }
    }

    impl Drop for ScopedAccountHome {
        fn drop(&mut self) {
            match self.home.take() {
                Some(previous) => std::env::set_var("HOME", previous),
                None => std::env::remove_var("HOME"),
            }
            match self.dure_home.take() {
                Some(previous) => std::env::set_var("DURE_HOME", previous),
                None => std::env::remove_var("DURE_HOME"),
            }
        }
    }

    #[test]
    fn account_profile_creation_honors_dure_home_override() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("home");
        let dure_home = temporary.path().join("portable-dure");
        std::fs::create_dir(&home).unwrap();
        let _environment = ScopedAccountHome::set(&home, &dure_home);

        let profile = create_account_dir("codex".into(), "work".into()).unwrap();

        assert_eq!(
            std::path::PathBuf::from(profile),
            std::fs::canonicalize(dure_home.join("accounts/codex-work")).unwrap(),
        );
        assert!(home.join(".codex").is_dir());
        assert!(!home.join(".dure").exists());
    }

    #[test]
    fn app_capabilities_advertise_the_required_contracts() {
        let caps = app_caps();
        let serialized = serde_json::to_value(&caps).expect("app caps must serialize");
        assert_eq!(caps.protocol_version, APP_PROTOCOL_VERSION);
        assert_eq!(caps.features, APP_FEATURES);
        assert!(caps.build_id.starts_with(env!("CARGO_PKG_VERSION")));
        assert!(caps.features.contains(&"app.runtime-fingerprint-v1"));
        assert_eq!(
            serialized
                .get("runtimeFingerprint")
                .and_then(serde_json::Value::as_str),
            caps.runtime_fingerprint
        );
        if let Some(fingerprint) = caps.runtime_fingerprint {
            assert!(fingerprint.starts_with("git-object-v1:"));
            let repository_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("src-tauri must live below the repository root");
            let output = std::process::Command::new("node")
                .arg(repository_root.join("scripts/lib/backend-runtime-fingerprint.mjs"))
                .arg("--root")
                .arg(repository_root)
                .output()
                .expect("fingerprint helper must run");
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout)
                    .expect("fingerprint output must be UTF-8")
                    .trim(),
                fingerprint
            );
        }
        assert!(caps
            .features
            .contains(&"hmux.standalone-terminal-surface-v1"));
        assert!(!caps
            .features
            .contains(&"hmux.standalone-controller-canary-v1"));
        assert!(!caps.features.contains(&"hmux.remote-controller-v1"));
        assert!(caps.features.contains(&"hmux.remote-catalog-v1"));
        assert!(caps.features.contains(&"hmux.remote-pane-departure-v1"));
        assert!(caps.features.contains(&"hmux.remote-exact-input-v1"));
        assert!(caps
            .features
            .contains(&"hmux.remote-initial-agent-prompt-v1"));
        assert!(caps.features.contains(&"hmux.remote-known-host-trust-v1"));
        assert!(caps.features.contains(&"hmux.remote-create-v1"));
        assert!(caps.features.contains(&"hmux.remote-managed-create-v1"));
        assert!(caps.features.contains(&"hmux.remote-managed-create-advance-v1"));
        assert!(
            caps.features
                .contains(&"hmux.remote-managed-create-chain-stop-v1")
        );
        assert!(
            caps.features
                .contains(&"hmux.remote-managed-create-chain-stop-v2")
        );
        assert!(caps.features.contains(&"hmux.remote-managed-rehost-v1"));
        assert!(caps.features.contains(&"hmux.remote-managed-stop-v1"));
        assert!(caps.features.contains(&"provider-history.remote-v1"));
        assert!(caps.features.contains(&"hmux.managed-stop-v1"));
        assert!(caps.features.contains(&"hmux.initial-agent-prompt-v1"));
        assert!(caps.features.contains(&"hmux.managed-create-v1"));
        assert!(caps.features.contains(&"hmux.managed-create-advance-v1"));
        assert!(caps.features.contains(&"hmux.managed-launch-prompt-v1"));
        assert!(caps.features.contains(&"hmux.managed-create-chain-stop-v1"));
        assert!(caps.features.contains(&"hmux.managed-create-chain-stop-v2"));
    }

    #[test]
    fn exact_resume_falls_back_before_a_stale_credential_can_reject_launch() {
        let launch = prepare_local_managed_create_launch(
            super::managed_create_resolution::ManagedCreateCommandPayload {
                replace_current: true,
                idempotency_key: "resume-source-create".into(),
                session_id: "resume-source-session".into(),
                workspace_id: "resume-workspace".into(),
                provider_id: "fixture".into(),
                conversation_id: Some("resume-conversation".into()),
                permission_mode: hmux_client::PermissionMode::Default,
                credential_id: Some("stale-account".into()),
                credential_directory: None,
                credential_generation: Some(9),
                cwd: "/tmp".into(),
                command: "fixture".into(),
                initial_prompt: None,
                rows: 24,
                columns: 80,
                terminal_env: None,
                terminal_default_colors: Default::default(),
            },
        )
        .expect("replace-current must fall back to provider default");

        assert!(launch.credential_id.is_none());
        assert!(launch.credential_generation.is_none());
        assert!(launch.provider_state_environment.values().is_empty());
    }

    #[test]
    fn initial_prompt_stays_separate_from_managed_command_preparation() {
        let payload = |command: &str| {
            super::managed_create_resolution::ManagedCreateCommandPayload {
                replace_current: false,
                idempotency_key: "create-prompt".into(),
                session_id: "prompt-session".into(),
                workspace_id: "prompt-workspace".into(),
                provider_id: "codex".into(),
                conversation_id: None,
                permission_mode: hmux_client::PermissionMode::Default,
                credential_id: None,
                credential_directory: None,
                credential_generation: None,
                cwd: "/tmp".into(),
                command: command.into(),
                initial_prompt: Some("ship 'it'".into()),
                rows: 24,
                columns: 80,
                terminal_env: None,
                terminal_default_colors: Default::default(),
            }
        };

        let launch = prepare_local_managed_create_launch(payload(
            "codex -c check_for_update_on_startup=false",
        ))
        .unwrap();
        assert_eq!(
            launch.command,
            "codex -c check_for_update_on_startup=false"
        );
        assert_eq!(launch.initial_prompt.as_deref(), Some("ship 'it'"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_permission_status_keeps_full_disk_access_manual() {
        assert_eq!(macos_permissions().full_disk, None);
    }

    /// CoreText 열거가 실제로 이 기기의 글꼴을 돌려주는지 — 구현을 NSFontManager
    /// (AppKit, 메인 스레드 전용)에서 CoreText로 바꾼 뒤 실측이 필요했다.
    /// 이름만 세는 게 아니라 고정폭 판정까지 확인한다: 트레이트 비트를 잘못
    /// 읽으면 목록은 그럴듯한데 분류만 전부 틀린 채로 지나간다.
    #[cfg(target_os = "macos")]
    #[test]
    fn core_text_enumerates_installed_font_families() {
        let families = super::load_font_families();
        assert!(!families.is_empty(), "설치된 글꼴이 하나도 안 잡혔다");
        assert!(
            families.iter().any(|f| f.monospaced),
            "고정폭 글꼴이 하나도 없다 — kCTFontTraitMonoSpace 판정이 깨졌을 가능성",
        );
        assert!(
            families.iter().any(|f| !f.monospaced),
            "전부 고정폭으로 잡혔다 — 트레이트 비트를 잘못 읽고 있다",
        );
        // 내부용 이름(.SF NS 등)은 고르게 두지 않는다.
        assert!(!families.iter().any(|f| f.name.starts_with('.')));
        // 정렬은 대소문자 무시 오름차순이어야 한다.
        let mut sorted = families.clone();
        sorted.sort_by_key(|f| f.name.to_lowercase());
        assert_eq!(
            families.iter().map(|f| &f.name).collect::<Vec<_>>(),
            sorted.iter().map(|f| &f.name).collect::<Vec<_>>(),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn authorization_status_maps_not_determined_to_unknown() {
        use super::authorization_to_option;
        // 아직 물어보지 않은 상태(0)를 false로 접으면, 실제로는 허용 가능한
        // 권한이 "허용 안 됨"으로 보인다 — 모름은 모름으로 남긴다.
        assert_eq!(authorization_to_option(0), None);
        assert_eq!(authorization_to_option(1), Some(false)); // restricted
        assert_eq!(authorization_to_option(2), Some(false)); // denied
        assert_eq!(authorization_to_option(3), Some(true)); // authorized
        assert_eq!(authorization_to_option(99), None);
    }
}

#[tauri::command(async)]
fn ssh_prepare_account_overlay(
    opts: ssh::SshOptions,
    provider: String,
    remote_dir: String,
    require_credential: bool,
) -> Result<remote_accounts::RemoteAccountOverlayReceipt, String> {
    remote_accounts::prepare(&opts, &provider, &remote_dir, require_credential)
}

/// Copy only the backend-reviewed credential artifact into a prepared remote
/// profile. The renderer cannot select arbitrary local or remote filenames.
#[tauri::command(async)]
fn ssh_copy_account(
    opts: ssh::SshOptions,
    provider: String,
    local_dir: String,
    remote_dir: String,
) -> Result<Vec<String>, String> {
    remote_accounts::copy_account(&opts, &provider, &local_dir, &remote_dir)
}

/// 외부 `dure` CLI가 읽는 에이전트 레지스트리를 ~/.dure/agents.json에
/// 기록한다. 프론트엔드가 store(agents/projects/hosts)를 이 형식으로 직렬화해
/// 넘긴다. 앱이 꺼져 있어도 같은 앱 채널의 CLI가 이 파일만으로 세션에 닿는다.
#[tauri::command(async)]
fn write_agent_registry(json: String) -> Result<(), String> {
    let channel = app_channel::current().map_err(|e| e.to_string())?;
    agent_registry::publish(&channel.control_dir.join("agents.json"), &json)
}

/// 현재 앱 채널 제어 디렉터리 안의 파일명을 안전하게 해석(경로 탈출 방지 — basename만).
pub(crate) fn hebbian_file(name: &str) -> Result<std::path::PathBuf, String> {
    let base = std::path::Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid name")?;
    if base.is_empty() || base.starts_with('.') && base.len() == 1 {
        return Err("invalid name".into());
    }
    let channel = app_channel::current().map_err(|e| e.to_string())?;
    Ok(channel.control_dir.join(base))
}

/// Reads a file from the current app channel, returning an empty string when absent.
#[tauri::command(async)]
fn hebbian_read(name: String) -> Result<String, String> {
    let p = hebbian_file(&name)?;
    Ok(std::fs::read_to_string(p).unwrap_or_default())
}

/// 현재 앱 채널의 <name> 쓰기.
#[tauri::command(async)]
fn hebbian_write(name: String, content: String) -> Result<(), String> {
    let p = hebbian_file(&name)?;
    std::fs::write(p, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 2026-07-28 identifier 전환(com.kattpish.agent-ide → io.hebbian.ade) 1회 이행.
/// 새 identifier의 저장소가 아직 없으면 이전 경로를 복사해 데스크탑·레이아웃·
/// 설정(WebKit localStorage 포함)을 보존한다. 실패 시 반쯤 복사된 디렉토리를
/// 지우고 새 상태로 기동한다 — 마이그레이션은 최선 노력이며 기동을 막지 않는다.
#[cfg(target_os = "macos")]
fn migrate_legacy_app_identity_data() {
    const OLD_ID: &str = "com.kattpish.agent-ide";
    const NEW_ID: &str = "io.hebbian.ade";

    if !app_channel::current().is_ok_and(|channel| channel.name == "stable") {
        return;
    }

    fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let target = dst.join(entry.file_name());
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                copy_dir_recursive(&entry.path(), &target)?;
            } else if file_type.is_file() {
                std::fs::copy(entry.path(), &target)?;
            }
            // symlink 등은 건너뛴다 — 앱 데이터에는 정상적으로 존재하지 않는다
        }
        Ok(())
    }

    let Some(home) = dirs::home_dir() else { return };
    for base in ["Library/Application Support", "Library/WebKit"] {
        let old = home.join(base).join(OLD_ID);
        let new = home.join(base).join(NEW_ID);
        if new.exists() || !old.exists() {
            continue;
        }
        if let Err(error) = copy_dir_recursive(&old, &new) {
            eprintln!("[identity-migration] Could not copy {base}; starting with fresh state: {error}");
            let _ = std::fs::remove_dir_all(&new);
        }
    }
}

pub fn run() {
    let mut context = tauri::generate_context!();
    worktree_release::apply(&mut context).expect("invalid worktree release profile");
    #[cfg(target_os = "macos")]
    macos_dev_bundle::reexec_if_needed(
        context.config().product_name.as_deref().unwrap_or("Dure"),
        &context.config().identifier,
        context
            .config()
            .bundle
            .external_bin
            .as_deref()
            .unwrap_or_default(),
    )
    .expect("failed to launch the macOS development app from Dure.app");
    #[cfg(target_os = "macos")]
    migrate_legacy_app_identity_data();
    #[cfg(target_os = "macos")]
    if let Err(error) = macos_notification_center::install_delegate() {
        eprintln!("[notification] click delegate install failed: {error}");
    }
    let cli_request_broker = std::sync::Arc::new(server::CliRequestBroker::default());
    let plugin_state = app_home::app_root_resolution()
        .map(|(app_root, _)| plugin_catalog::DurePluginState::from_app_root(&app_root))
        .unwrap_or_else(|error| {
            eprintln!("[plugin-catalog] Could not resolve the app home; using only the bundled catalog: {error}");
            plugin_catalog::DurePluginState::default()
        });
    let backend_coordinator = dure_backend_coordinator::DureBackendCoordinator::new();
    let backend_transport = dure_backend_transport::DureBackendTransportState::with_recovery(
        backend_coordinator.handle(),
    );
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    let builder = if worktree_release::profile().expect("invalid worktree release profile").is_none() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    // Anonymous usage telemetry: one process, one `app_opened`, offered
    // before any window exists and dropped unless the install already
    // accepted. The runtime is inert without a compiled-in key.
    let telemetry_runtime = telemetry::TelemetryRuntime::for_this_process();
    telemetry_runtime.offer(telemetry::event::TelemetryEvent::AppOpened);
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(telemetry_runtime)
        .manage(AppState::default())
        .manage(backend_transport)
        .manage(backend_coordinator)
        .manage(provider_extension::DureAgentProviderState::default())
        .manage(diff_review_store::ReviewStoreState::default())
        .manage(codex_usage_collector::CodexUsageCollector::default())
        .manage(usage_recent_runtime::UsageRecentRuntime::default())
        .manage(plugin_state)
        .manage(plugin_permission_commands::DurePluginPermissionRuntime::default())
        .manage(plugin_issue_tracker::DureIssueTrackerState::default())
        .manage(mobile_pairing::PairingProcess::default())
        .manage(hub::commands::HubState::default())
        .manage(cli_request_broker.clone());
    #[cfg(target_os = "macos")]
    let builder = builder
        .manage(durable_window_exit::NativeQuitState::default())
        .menu(durable_window_exit::macos_menu)
        .on_menu_event(durable_window_exit::macos_menu_event);
    #[cfg(debug_assertions)]
    let builder = builder
        .manage(qa::WindowFocusQa::default())
        .plugin(qa::plugin());
    let builder = hmux::configure_observer_webview_lifecycle(builder);
    let builder = dure_backend_transport::subscription::configure_window_lifecycle(builder);
    let builder = mobile_simulator::live::configure_window_lifecycle(builder);
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        mobile_simulator::live::close_window(webview.label());
        let retired_plugin_subscribers = webview
            .app_handle()
            .state::<plugin_issue_tracker::DureIssueTrackerState>()
            .retire_window(webview.label());
        let retired_hmux_observers = webview
            .app_handle()
            .state::<AppState>()
            .hmux
            .forget_observer_webview(webview.label())
            .unwrap_or_default();
        let retired_backend_subscriptions = webview
            .app_handle()
            .state::<dure_backend_transport::DureBackendTransportState>()
            .cancel_window_subscriptions(webview.label());
        eprintln!(
            "[webview-recovery] WebContent terminated: label={} retired_plugin_subscribers={retired_plugin_subscribers} retired_hmux_observers={retired_hmux_observers} retired_backend_subscriptions={retired_backend_subscriptions}",
            webview.label()
        );
        if let Err(error) = webview.reload() {
            eprintln!(
                "[webview-recovery] reload failed: label={} error={error}",
                webview.label()
            );
        }
    });
    webview_storage::apply_dev(&mut context).expect("invalid dev WebView data-store identity");
    let app = builder
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            macos_notification_center::register_app_handle(app.handle());
            let notification_click_qa = notification_click_qa::bootstrap(app.handle())?;
            #[cfg(debug_assertions)]
            qa::configure_activation_policy(app.handle())?;
            app.state::<dure_backend_coordinator::DureBackendCoordinator>()
                .start(app.path().resource_dir()?)?;
            if !notification_click_qa {
                server::start(app.handle().clone(), cli_request_broker.clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_simulator::live::mobile_simulator_live_start,
            mobile_simulator::live::mobile_simulator_live_frame,
            mobile_simulator::live::mobile_simulator_live_stop,
            mobile_simulator::workflows::mobile_simulator_run,
            mobile_simulator::workflows::mobile_simulator_report,
            mobile_simulator::mobile_simulator_list,
            mobile_simulator::mobile_simulator_capture,
            mobile_simulator::mobile_simulator_act,
            #[cfg(target_os = "macos")]
            durable_window_exit::set_app_quit_confirmation_copy,
            mobile_pairing::mobile_pairing_start,
            mobile_pairing::mobile_pairing_stop,
            mobile_pairing::mobile_pairing_networks,
            mobile_pairing::mobile_pairing_qr,
            hub::commands::hub_start,
            hub::commands::hub_resume,
            hub::commands::hub_stop,
            hub::commands::hub_status,
            hub::commands::hub_devices,
            hub::commands::hub_device_register,
            hub::commands::hub_device_revoke,
            hub::push::hub_push_agent_notification,
            hub::commands::hub_pairing_offer,
            hub::commands::hub_relay_start,
            hub::commands::hub_relay_stop,
            hub::commands::hub_relay_status,
            hub::commands::hub_set_sidebar_layout,
            hub::commands::hub_git_status_result,
            hub::commands::hub_file_diff_result,
            hub::session_file::hub_session_file_result,
            hub::commands::hub_remote_file_diff,
            hub::commands::hub_sidebar_layout,
            remote_login::remote_login_posture,
            remote_login::open_sharing_settings,
            server::cli_request_claim,
            server::cli_request_begin_decision,
            server::cli_request_complete,
            spawn::spawn_saga_create,
            spawn::spawn_journal_append,
            spawn::spawn_receipt_get,
            spawn::spawn_receipt_find,
            spawn::spawn_receipts_list_running,
            hmux_standalone_terminate,
            hmux_session_terminate_exact,
            hmux_managed_stop,
            hmux_exact_termination::hmux_managed_stop_completed,
            hmux_exact_termination::hmux_managed_session_retirement,
            hmux_managed_create_chain_stop_v1,
            hmux_managed_create_chain_stop_v2,
            hmux_convert_session,
            hmux_report_agent_state,
            app_caps,
            webview_storage::webview_storage_options,
            dure_checkpoint_backend::dure_checkpoint_observe,
            dure_backend_transport::dure_backend_profiles,
            dure_backend_transport::dure_backend_request,
            dure_backend_transport::dure_backend_route_assert,
            dure_backend_transport::subscription::dure_backend_subscribe,
            dure_backend_transport::subscription::dure_backend_unsubscribe,
            dure_client_view_identity::dure_client_view_local_identity,
            hardware_profile::system_hardware_profile,
            provider_preflight,
            hmux_list_sessions,
            hmux_inspect_sessions_exact,
            hmux_local_state_gc,
            list_existing_worktrees,
            inspect_existing_worktree,
            resolve_existing_worktree,
            recover_existing_worktree_ownership,
            external_workspace::external_workspace_targets,
            external_workspace::open_external_workspace,
            hmux_resolve_managed_rehost,
            app_home_info,
            hmux_resolve_named_session,
            hmux_managed_conversation_identity,
            hmux_existing_managed_writer,
            hmux_control_plane_census,
            hmux_activate_installed_build,
            hmux_rollback_current_build,
            hmux_plan_recovery,
            hmux_retire_exited_sessions,
            hmux_cleanup_stale_sessions,
            hmux_execute_recovery,
            hmux_reconcile_managed_recovery,
            hmux_upgrade_standalone,
            hmux::structured_terminal::hmux_structured_terminal_attach,
            hmux::structured_terminal::hmux_structured_terminal_next,
            hmux::structured_terminal::hmux_structured_terminal_detach,
            hmux::structured_terminal::hmux_structured_terminal_upstream,
            hmux::command_input::hmux_command_input,
            hmux::command_input::hmux_initial_agent_prompt,
            hmux_standalone_create,
            hmux_standalone_abandon_unpresented,
            hmux_pane_depart_gracefully,
            hmux_pane_attachment_status,
            hmux_managed_create,
            hmux_managed_create_advance_v1,
            hmux_managed_shell_create,
            hmux_promote_app_standalone_shell,
            hmux_sweep_app_standalone_shell,
            remote_hmux::remote_hmux_catalog,
            remote_hmux::remote_hmux_provision,
            remote_hmux::remote_hmux_managed_create,
            remote_hmux::remote_hmux_managed_create_advance_v1,
            session_checkout::session_checkout_register_agent_v1,
            session_checkout::session_checkout_close_agent_registration_v1,
            session_checkout::session_checkout_reconcile_managed_close_v1,
            remote_hmux::remote_hmux_managed_create_chain_stop_v1,
            remote_hmux::remote_hmux_managed_create_chain_stop_v2,
            remote_hmux::remote_hmux_managed_rehost,
            remote_hmux::remote_hmux_managed_rehost_reconcile,
            remote_hmux::remote_hmux_managed_stop,
            remote_hmux::remote_hmux_standalone_create,
            remote_hmux::remote_hmux_standalone_abandon_unpresented,
            remote_hmux::remote_hmux_known_host_fingerprints,
            remote_hmux::remote_hmux_structured_terminal_attach,
            remote_hmux::remote_hmux_command_input,
            remote_hmux::remote_hmux_initial_agent_prompt,
            hub::commands::hub_remote_git_status,
            hub::commands::hub_publish_launch_offer,
            hub::commands::hub_start_agent_result,
            remote_hmux::remote_hmux_pane_depart_gracefully,
            session_hmux,
            ssh_secret_set,
            ssh_secret_copy,
            ssh_credential_claim_stage,
            ssh_credential_claim_activate,
            ssh_credential_claim_retire,
            ssh_credential_claim_reconcile,
            ssh_exec_once,
            ssh_directory_commands::ssh_browse_directory,
            ssh_directory_commands::ssh_project_directory,
            ssh_prepare_account_overlay,
            sshconfig::ssh_config_hosts,
            git_status,
            git_availability::git_availability,
            git_exec,
            git_exec_bounded,
            dure_cli_install::dure_cli_install_status,
            dure_cli_install::install_dure_cli,
            run_shell,
            write_text_file,
            create_worktree,
            provision_worktree,
            provision_worktree_command,
            list_branches,
            list_branches_command,
            gh_exec,
            parse_branches,
            git_checkout_instance::capture_git_checkout_instance,
            git_checkout_instance::locate_git_checkout_paths,
            git_checkout_instance::remove_git_checkout_instance,
            remote_git_checkout_helper::prepare_remote_git_checkout_helper,
            worktree_command,
            local_directories::list_dir,
            files::inspect_local_directory,
            local_directories::search_local_directories,
            system_resources,
            scan_worktrees,
            scan_worktrees_command,
            parse_worktree_scan,
            copy_claude_session,
            copy_claude_session_command,
            home_dir,
            ssh_copy_account,
            read_clipboard_image,
            save_temp_image,
            dropped_files::save_temp_file,
            dropped_files::save_temp_files,
            dropped_files::save_files_to_directory,
            dropped_files::ssh_upload_files_to_directory,
            dropped_files::ssh_upload_files_to_temp_directory,
            dropped_files::route_session_files,
            dropped_files::save_quick_dispatch_attachments,
            dropped_files::save_chat_attachments,
            dropped_files::read_chat_attachment,
            desktop_notification::notification_status,
            desktop_notification::notification_request_authorization,
            desktop_notification::notification_dispatch,
            desktop_notification::notification_activation_take,
            desktop_notification::notification_open_settings,
            notification_click_qa::notification_click_qa_context,
            notification_click_qa::notification_click_qa_target_ready,
            notification_click_qa::notification_click_qa_target_is_ready,
            notification_click_qa::notification_click_qa_begin,
            notification_click_qa::notification_click_qa_authorize,
            notification_click_qa::notification_click_qa_arm,
            notification_click_qa::notification_click_qa_complete,
            notification_click_qa::notification_click_qa_fail,
            notification_click_qa::notification_click_qa_exit,
            usage_stats,
            macos_permissions,
            share::share_file,
            native_title_bar::set_native_title_bar_colors,
            shell_corner::set_shell_glass,
            traffic_lights::set_traffic_light_drop,
            window_resize::toggle_window_maximize_atomic,
            window_resize::observe_current_window_live_resize,
            open_privacy_pane,
            request_privacy_prompt,
            system_font_families,
            usage_recent,
            usage_recent_snapshot,
            codex_usage_collector::codex_usage_profiles_sync,
            agent_naming::agent_name_suggestion,
            session_credentials::credential_session_bindings,
            claude_collector::claude_collector_status,
            codex_trust::codex_trust_workspace,
            design_mode::design_mode_open_browser,
            design_mode::design_mode_screenshot,
            design_mode::design_mode_close_browser,
            feedback_capture::feedback_capture_main_window,
            feedback_capture::feedback_environment,
            telemetry::telemetry_state,
            telemetry::telemetry_set_choice,
            telemetry::telemetry_track,
            claude_collector::claude_collector_install,
            claude_collector::claude_collector_uninstall,
            login_identity::account_login_identity,
            create_account_dir,
            provider_wiring::provider_wiring_status,
            provider_wiring::provider_wiring_file,
            read_file,
            ssh_read_file,
            write_file,
            ssh_write_file,
            ssh_delete_file,
            find_file_candidates,
            ssh_find_file_candidates,
            list_conversations,
            list_provider_conversations,
            provider_conversation_metadata,
            read_provider_conversation_transcript,
            conv::provider_conversation_details,
            list_remote_provider_conversations,
            conv::remote_provider_conversation_details,
            ssh_list_conversations,
            ssh_provider_conversation_metadata,
            write_agent_registry,
            hebbian_read,
            worktree_release::read_worktree_presentation,
            worktree_release::complete_worktree_presentation,
            hebbian_write,
            hmux_diagnostics::append_hmux_connection_diagnostic,
            hmux_diagnostics::append_hmux_connection_diagnostics,
            error_report::save_error_report_bundle,
            agent_pull_request,
            agent_pull_request_create,
            agent_commits,
            agent_diff_stat,
            agent_diff,
            agent_diff_review,
            agent_file_diff,
            agent_commit_detail,
            agent_reviewer_candidates,
            agent_set_reviewers,
            agent_scm_write,
            agent_branches,
            diff_review_store::diff_review_target_create,
            diff_review_store::diff_review_targets_reconcile,
            diff_review_store::diff_review_snapshot,
            plugin_catalog::dure_plugin_catalog,
            plugin_catalog::dure_plugin_catalog_v2,
            plugin_catalog::dure_plugin_settings_get,
            plugin_catalog::dure_plugin_settings_update,
            plugin_permission_commands::dure_plugin_permission_get,
            plugin_permission_commands::dure_plugin_permission_decide,
            plugin_permission_commands::dure_plugin_permission_enable,
            plugin_permission_commands::dure_plugin_permission_disable,
            plugin_issue_tracker::dure_issue_tracker_activation_get,
            plugin_issue_tracker::dure_issue_tracker_activate,
            plugin_issue_tracker::dure_issue_tracker_query,
            plugin_issue_tracker::dure_issue_tracker_watch_subscribe,
            plugin_issue_tracker::dure_issue_tracker_watch_unsubscribe,
        ])
        .build(context)
        .expect("error while building tauri application");
    let mut durable_exit = durable_window_exit::DurableWindowExitCoordinator::default();
    app.run(move |app, event| {
        // Every window is already closed at `Exit`; a bounded final flush
        // blocks no UI and the worker cannot keep the process alive.
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<telemetry::TelemetryRuntime>().shutdown();
        }
        durable_exit.handle(app, event)
    });
}
