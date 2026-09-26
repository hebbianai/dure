// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod agent_registry;
#[cfg(windows)]
mod app_channel;
#[cfg(windows)]
mod worktree_release;
#[cfg(windows)]
mod app_home;
#[cfg(windows)]
mod codex_trust;
#[cfg(windows)]
mod dropped_files;
#[cfg(windows)]
mod durable_window_exit;
#[cfg(windows)]
mod files;
#[cfg(windows)]
mod ghx;
#[cfg(windows)]
mod git_checkout_instance;
#[cfg(windows)]
mod gitx;
#[cfg(windows)]
mod git_availability;
#[cfg(windows)]
mod git_repository;
#[cfg(windows)]
mod hardware_profile;
#[cfg(windows)]
mod hmux_exact_termination;
#[cfg(windows)]
mod hmux_input_contract;
#[cfg(windows)]
mod login_shell;
#[cfg(windows)]
mod managed_create_resolution;
#[cfg(windows)]
#[path = "hmux/managed_provider_launch.rs"]
mod managed_provider_launch;
#[cfg(windows)]
mod native_title_bar;
#[cfg(windows)]
#[path = "provider_preflight_windows.rs"]
mod provider_preflight;
#[cfg(windows)]
mod resources;
#[cfg(windows)]
mod random_token;
#[cfg(windows)]
mod remote_git_checkout_helper;
#[cfg(windows)]
mod remote_platform;
#[cfg(windows)]
mod remote_path;
#[cfg(windows)]
mod secrets;
#[cfg(windows)]
mod session_checkout;
#[cfg(windows)]
mod spawn;
#[cfg(windows)]
mod standalone_create_request;
#[cfg(windows)]
mod ssh_credential_registry;
#[cfg(windows)]
mod shell_corner;
#[cfg(windows)]
mod ssh;
#[cfg(windows)]
mod ssh_directory_commands;
#[cfg(windows)]
mod sshconfig;
#[cfg(windows)]
mod structured_terminal_access;
#[cfg(windows)]
mod traffic_lights;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_hmux;
#[cfg(windows)]
mod windows_managed_provider_launch;
#[cfg(windows)]
mod working_directory;

#[cfg(not(windows))]
fn main() {
    agent_ide_lib::run()
}

#[cfg(windows)]
fn main() {
    windows::run()
}
