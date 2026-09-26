use serde::Serialize;

const APP_PROTOCOL_VERSION: u32 = 1;
const WINDOWS_FEATURES: &[&str] = &[
    "app.runtime-fingerprint-v1",
    "windows.desktop-native-v1",
    "git.local-v1",
    "git.remote-checkout-helper-v1",
    "ssh.utility-v1",
    "hmux.terminal-state-binary-v1",
    "hmux.standalone-terminal-surface-v1",
    "hmux.standalone-command-v1",
    "hmux.managed-create-v1",
    "hmux.managed-create-advance-v1",
    "hmux.managed-create-chain-stop-v1",
    "hmux.managed-create-chain-stop-v2",
    "hmux.managed-shell-v1",
    "hmux.managed-stop-v1",
    "hmux.initial-agent-prompt-v1",
];

#[derive(Serialize)]
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
        name: "dure-backend-windows",
        package_version: env!("CARGO_PKG_VERSION"),
        protocol_version: APP_PROTOCOL_VERSION,
        build_id: env!("DURE_BUILD_ID"),
        runtime_fingerprint: embedded_runtime_fingerprint(),
        features: WINDOWS_FEATURES,
    }
}

#[tauri::command]
fn home_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\"))
        .to_string_lossy()
        .into_owned()
}

#[tauri::command(async)]
fn git_status(path: String) -> crate::gitx::GitStatus {
    crate::gitx::status(&path)
}

#[tauri::command(async)]
fn git_exec(path: String, args: Vec<String>) -> crate::gitx::ExecOut {
    crate::gitx::exec(&path, &args)
}

#[tauri::command(async)]
fn git_exec_bounded(path: String, args: Vec<String>, timeout_ms: u64) -> crate::gitx::ExecOut {
    crate::gitx::exec_bounded(&path, &args, timeout_ms)
}

#[tauri::command(async)]
fn create_worktree(
    repo: String,
    name: String,
    from: Option<String>,
) -> Result<crate::gitx::WorktreeInfo, String> {
    crate::gitx::create_worktree(&repo, &name, from.as_deref())
}

#[tauri::command(async)]
fn provision_worktree(
    plan: crate::gitx::WorktreeProvisionPlan,
) -> Result<crate::gitx::WorktreeInfo, String> {
    crate::gitx::provision_worktree(&plan)
}

#[tauri::command]
fn provision_worktree_command(plan: crate::gitx::WorktreeProvisionPlan) -> (String, String) {
    crate::gitx::provision_worktree_command(&plan)
}

#[tauri::command]
fn worktree_command(
    repo: String,
    name: String,
    from: Option<String>,
) -> (String, String, String) {
    crate::gitx::worktree_command(&repo, &name, from.as_deref())
}

#[tauri::command(async)]
fn list_branches(repo: String) -> Result<Vec<crate::gitx::BranchInfo>, String> {
    crate::gitx::list_branches(&repo)
}

#[tauri::command]
fn list_branches_command(repo: String) -> String {
    crate::gitx::list_branches_command(&repo)
}

#[tauri::command]
fn parse_branches(output: String) -> Vec<crate::gitx::BranchInfo> {
    crate::gitx::parse_branches(&output)
}

#[tauri::command(async)]
fn list_dir(
    path: String,
    include_hidden: Option<bool>,
    mark_ignored: Option<bool>,
) -> Result<Vec<crate::gitx::DirEntry>, String> {
    crate::gitx::list_dir(
        &path,
        include_hidden.unwrap_or(false),
        mark_ignored.unwrap_or(false),
    )
}

#[tauri::command(async)]
fn system_resources(path: Option<String>) -> crate::resources::SystemResources {
    crate::resources::sample(path.as_deref())
}

#[tauri::command(async)]
fn run_shell(command: String) -> crate::gitx::ExecOut {
    let output = crate::login_shell::run(&command);
    match output {
        Ok(output) => crate::gitx::ExecOut {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(-1),
        },
        Err(error) => crate::gitx::ExecOut {
            stdout: String::new(),
            stderr: format!("shell: {error}"),
            code: -1,
        },
    }
}

#[tauri::command(async)]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn read_file(path: String) -> Result<crate::files::FileContent, String> {
    crate::files::read_local(&path)
}

#[tauri::command(async)]
fn write_file(path: String, content: String) -> Result<u64, String> {
    crate::files::write_local(&path, &content)
}

#[tauri::command(async)]
fn find_file_candidates(path: String, limit: Option<usize>) -> Vec<String> {
    crate::files::find_local_candidates(&path, limit.unwrap_or(20).clamp(1, 100))
}

#[tauri::command(async)]
fn ssh_read_file(
    opts: Option<crate::ssh::SshOptions>,
    path: String,
) -> Result<crate::files::FileContent, String> {
    let opts = opts.ok_or_else(|| "SSH connection options are required".to_string())?;
    crate::files::read_remote(
        |command| crate::ssh::exec_once(&opts, command).map(|result| result.stdout),
        &path,
    )
}

#[tauri::command(async)]
fn ssh_write_file(
    opts: Option<crate::ssh::SshOptions>,
    path: String,
    content: String,
) -> Result<u64, String> {
    let opts = opts.ok_or_else(|| "SSH connection options are required".to_string())?;
    crate::files::write_remote(
        |command| crate::ssh::exec_once(&opts, command).map(|result| result.stdout),
        &path,
        &content,
    )
}

#[tauri::command(async)]
fn ssh_delete_file(
    opts: crate::ssh::SshOptions,
    root: String,
    path: String,
    is_directory: bool,
) -> Result<(), String> {
    crate::files::delete_remote(
        |command| crate::ssh::exec_once(&opts, command).map(|result| result.stdout),
        &root,
        &path,
        is_directory,
    )
}

#[tauri::command(async)]
fn ssh_find_file_candidates(
    opts: Option<crate::ssh::SshOptions>,
    path: String,
    limit: Option<usize>,
) -> Vec<String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let Some(opts) = opts else {
        return Vec::new();
    };
    crate::files::find_remote_candidates(
        |command| crate::ssh::exec_once(&opts, command).map(|result| result.stdout),
        &path,
        limit,
    )
}

#[tauri::command(async)]
fn ssh_exec_once(
    opts: crate::ssh::SshOptions,
    cmd: String,
    stdin: Option<String>,
) -> Result<crate::ssh::ExecResult, String> {
    crate::ssh::exec_once_with_stdin(&opts, &cmd, stdin.as_deref())
}

#[tauri::command(async)]
fn ssh_secret_set(id: String, value: String) -> Result<(), String> {
    crate::secrets::set_ssh_secret(&id, &value)
}

#[tauri::command(async)]
fn ssh_secret_copy(source: String, destination: String) -> Result<(), String> {
    crate::secrets::copy_ssh_secret(&source, &destination)
}

#[tauri::command(async)]
fn ssh_credential_claim_stage(
    claims: Vec<crate::ssh_credential_registry::SshCredentialClaimV1>,
) -> Result<(), String> {
    crate::ssh_credential_registry::stage(claims)
}

#[tauri::command(async)]
fn ssh_credential_claim_activate(
    claims: Vec<crate::ssh_credential_registry::SshCredentialClaimV1>,
) -> Result<(), String> {
    crate::ssh_credential_registry::activate(claims)
}

#[tauri::command(async)]
fn ssh_credential_claim_retire(
    claims: Vec<crate::ssh_credential_registry::SshCredentialClaimV1>,
) -> Result<(), String> {
    crate::ssh_credential_registry::retire(claims)
}

#[tauri::command(async)]
fn ssh_credential_claim_reconcile(
    live_claims: Vec<crate::ssh_credential_registry::SshCredentialClaimV1>,
    referenced_ids: Vec<String>,
) -> Result<crate::ssh_credential_registry::SshCredentialCleanupReport, String> {
    crate::ssh_credential_registry::reconcile(live_claims, referenced_ids)
}

#[tauri::command(async)]
fn gh_exec(
    repo: Option<String>,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> crate::ghx::GhExecOut {
    crate::ghx::exec(repo.as_deref(), &args, timeout_ms.unwrap_or(15_000))
}

fn control_file(name: &str) -> Result<std::path::PathBuf, String> {
    if name != "agents.json" {
        return Err("invalid control file name".to_string());
    }
    let channel = crate::app_channel::current().map_err(|error| error.to_string())?;
    Ok(channel.control_dir.join(name))
}

#[tauri::command(async)]
fn write_agent_registry(json: String) -> Result<(), String> {
    let channel = crate::app_channel::current().map_err(|error| error.to_string())?;
    crate::agent_registry::publish(&channel.control_dir.join("agents.json"), &json)
}

#[tauri::command(async)]
fn hebbian_read(name: String) -> Result<String, String> {
    Ok(std::fs::read_to_string(control_file(&name)?).unwrap_or_default())
}

pub fn run() {
    let mut context = tauri::generate_context!();
    crate::worktree_release::apply(&mut context).expect("invalid worktree release profile");
    let app = tauri::Builder::default()
        .manage(std::sync::Arc::new(
            crate::windows_hmux::WindowsHmuxState::default(),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            app_caps,
            home_dir,
            crate::spawn::spawn_saga_create,
            crate::spawn::spawn_journal_append,
            crate::spawn::spawn_receipt_get,
            crate::spawn::spawn_receipt_find,
            crate::spawn::spawn_receipts_list_running,
            crate::session_checkout::session_checkout_register_agent_v1,
            crate::session_checkout::session_checkout_close_agent_registration_v1,
            crate::session_checkout::session_checkout_reconcile_managed_close_v1,
            crate::codex_trust::codex_trust_workspace,
            crate::windows_hmux::provider_preflight,
            crate::windows_hmux::hmux_list_sessions,
            crate::windows_hmux::hmux_inspect_sessions_exact,
            crate::windows_hmux::hmux_standalone_create,
            crate::windows_hmux::hmux_standalone_abandon_unpresented,
            crate::windows_hmux::hmux_pane_depart_gracefully,
            crate::windows_hmux::hmux_pane_attachment_status,
            crate::windows_hmux::hmux_managed_create,
            crate::windows_hmux::hmux_managed_create_advance_v1,
            crate::windows_hmux::hmux_managed_shell_create,
            crate::windows_hmux::hmux_structured_terminal_attach,
            crate::windows_hmux::hmux_structured_terminal_next,
            crate::windows_hmux::hmux_structured_terminal_detach,
            crate::windows_hmux::hmux_structured_terminal_upstream,
            crate::windows_hmux::hmux_command_input,
            crate::windows_hmux::hmux_initial_agent_prompt,
            crate::windows_hmux::hmux_standalone_terminate,
            crate::windows_hmux::hmux_session_terminate_exact,
            crate::windows_hmux::hmux_managed_stop,
            crate::hmux_exact_termination::hmux_managed_stop_completed,
            crate::hmux_exact_termination::hmux_managed_session_retirement,
            crate::windows_hmux::hmux_managed_create_chain_stop_v1,
            crate::windows_hmux::hmux_managed_create_chain_stop_v2,
            crate::hardware_profile::system_hardware_profile,
            git_status,
            crate::git_availability::git_availability,
            crate::git_repository::local_repository_status,
            git_exec,
            git_exec_bounded,
            create_worktree,
            provision_worktree,
            provision_worktree_command,
            worktree_command,
            crate::git_checkout_instance::capture_git_checkout_instance,
            crate::git_checkout_instance::locate_git_checkout_paths,
            crate::git_checkout_instance::remove_git_checkout_instance,
            crate::remote_git_checkout_helper::prepare_remote_git_checkout_helper,
            list_branches,
            list_branches_command,
            parse_branches,
            list_dir,
            crate::files::inspect_local_directory,
            system_resources,
            run_shell,
            write_text_file,
            read_file,
            write_file,
            find_file_candidates,
            ssh_read_file,
            ssh_write_file,
            ssh_delete_file,
            ssh_find_file_candidates,
            ssh_exec_once,
            crate::ssh_directory_commands::ssh_browse_directory,
            crate::ssh_directory_commands::ssh_project_directory,
            ssh_secret_set,
            ssh_secret_copy,
            ssh_credential_claim_stage,
            ssh_credential_claim_activate,
            ssh_credential_claim_retire,
            ssh_credential_claim_reconcile,
            crate::sshconfig::ssh_config_hosts,
            gh_exec,
            write_agent_registry,
            hebbian_read,
            crate::worktree_release::read_worktree_presentation,
            crate::worktree_release::complete_worktree_presentation,
            crate::native_title_bar::set_native_title_bar_colors,
            crate::shell_corner::set_shell_glass,
            crate::traffic_lights::set_traffic_light_drop,
            crate::dropped_files::save_temp_file,
            crate::dropped_files::save_temp_files,
            crate::dropped_files::save_files_to_directory,
            crate::dropped_files::ssh_upload_files_to_directory,
            crate::dropped_files::ssh_upload_files_to_temp_directory,
            crate::dropped_files::route_session_files,
            crate::dropped_files::save_quick_dispatch_attachments,
            crate::dropped_files::save_chat_attachments,
            crate::dropped_files::read_chat_attachment,
        ])
        .build(context)
        .expect("failed to build the Dure Windows desktop app");
    let mut durable_exit = crate::durable_window_exit::DurableWindowExitCoordinator::default();
    app.run(move |app, event| durable_exit.handle(app, event));
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_capabilities_claim_the_implemented_local_hmux_surface() {
        assert!(super::WINDOWS_FEATURES.contains(&"windows.desktop-native-v1"));
        assert!(super::WINDOWS_FEATURES.contains(&"git.remote-checkout-helper-v1"));
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.terminal-state-binary-v1"));
        assert!(
            super::WINDOWS_FEATURES.contains(&"hmux.standalone-terminal-surface-v1")
        );
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.managed-create-v1"));
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.managed-create-advance-v1"));
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.managed-create-chain-stop-v1"));
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.managed-create-chain-stop-v2"));
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.managed-shell-v1"));
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.managed-stop-v1"));
        assert!(super::WINDOWS_FEATURES.contains(&"hmux.initial-agent-prompt-v1"));
    }
}
