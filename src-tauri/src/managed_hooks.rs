mod claude;
#[cfg(unix)]
mod gemini;
mod integrations;
#[cfg(unix)]
mod pi;
#[cfg(unix)]
mod qwen;
pub(crate) use integrations::{publish_native_runtimes, publish_provider_runtime_integrations};
#[cfg(test)]
use integrations::provider_runtime_integrations_document;
#[cfg(unix)]
mod codex_native;

#[cfg(unix)]
pub(crate) use codex_native::publish_codex_runtime;

pub(crate) use claude::{claude_settings_available, publish_claude_settings};
use claude::{claude_settings_path, published_claude_settings, validate_published_claude_settings};
#[cfg(test)]
use claude::{
    claude_hook_script_path, claude_settings, publish_claude_settings_from,
    PublishedClaudeSettings,
};

#[cfg(all(test, unix))]
use claude::native_hook_shim;

#[cfg(test)]
use crate::managed_hook_rendering::MANAGED_PROVIDER_HOOK_SCRIPT;
use dure_app::codex_lifecycle_hook_arguments_v1;
#[cfg(test)]
use dure_app::{ProviderIdV1, ProviderRuntimeIntegrationV1};
use hmux_client::ProviderStateEnvironment;
#[cfg(test)]
use serde_json::json;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const CODEX_NOTIFY_SCRIPT_FILE: &str = "managed-codex-notify.sh";
const CODEX_USER_NOTIFY_WRAPPER_PREFIX: &str = "managed-codex-user-notify-";

/// Publication state for the owner-only Codex lifecycle channel handoff. A
/// spawn may use the script only while its bytes match this process's write.
#[derive(Clone)]
struct PublishedCodexNotify {
    script_path: PathBuf,
    script_contents: Vec<u8>,
    #[cfg(unix)]
    launcher: Option<codex_native::PublishedLauncher>,
}

fn published_codex_notify() -> &'static Mutex<Option<PublishedCodexNotify>> {
    static PUBLISHED: OnceLock<Mutex<Option<PublishedCodexNotify>>> = OnceLock::new();
    PUBLISHED.get_or_init(|| Mutex::new(None))
}

fn codex_notify_script_path(control_dir: &Path) -> PathBuf {
    control_dir.join(CODEX_NOTIFY_SCRIPT_FILE)
}

/// owner-only 원자 발행 — Claude settings 쓰기와 같은 계약(create_new 임시
/// 파일, symlink 교체 거부, rename). `mode`는 unix 전용(스크립트는 0o700).
fn write_owner_only_file(
    control_dir: &Path,
    path: &Path,
    contents: &[u8],
    #[cfg_attr(windows, allow(unused_variables))] mode: u32,
) -> std::io::Result<()> {
    let temporary_path = control_dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "managed-hook-file".to_string()),
        crate::server::gen_token()?
    ));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        let mut file = options.open(&temporary_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            if path
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(std::io::Error::other(
                    "refusing to replace a symlinked managed hook file",
                ));
            }
            file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        #[cfg(windows)]
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        std::fs::rename(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary_path);
    }
    result
}

pub(crate) fn render_managed_provider_hook_script(
    runtime_executable: &Path,
) -> std::io::Result<Vec<u8>> {
    if !runtime_executable.is_absolute() {
        return Err(std::io::Error::other(
            "managed provider Hmux runtime path must be absolute",
        ));
    }
    let runtime_executable = runtime_executable.to_str().ok_or_else(|| {
        std::io::Error::other("managed provider Hmux runtime path must be valid UTF-8")
    })?;
    crate::managed_hook_rendering::render_managed_provider_hook_script(runtime_executable)
}

/// Publish the Codex lifecycle bridge into `control_dir` with the immutable
/// Hmux runtime selected by this app generation. The script reports directly
/// to the exact Host, so backend or app-server restarts are outside the state
/// path while existing provider processes pick up refreshed script bytes.
pub(crate) fn publish_codex_notify(
    control_dir: &Path,
    runtime_executable: &Path,
) -> std::io::Result<()> {
    let script_path = codex_notify_script_path(control_dir);
    // This path enters TOML verbatim. Reject unsupported characters at
    // publication even though the app owns and normally fixes `control_dir`.
    let text = script_path.to_string_lossy();
    if text.contains('"') || text.contains('\\') || text.contains('\n') {
        return Err(std::io::Error::other(
            "managed codex notify path contains unsupported characters",
        ));
    }
    *published_codex_notify()
        .lock()
        .map_err(|_| std::io::Error::other("managed codex notify registry poisoned"))? = None;
    let script_contents = render_managed_provider_hook_script(runtime_executable)?;
    write_owner_only_file(control_dir, &script_path, &script_contents, 0o700)?;
    *published_codex_notify()
        .lock()
        .map_err(|_| std::io::Error::other("managed codex notify registry poisoned"))? =
        Some(PublishedCodexNotify {
            script_path,
            script_contents,
            #[cfg(unix)]
            launcher: None,
        });
    Ok(())
}

fn validate_published_file(
    path: &Path,
    expected: &[u8],
    label: &str,
    failure_prefix: &str,
) -> Result<(), String> {
    validate_owner_only_regular_file(path, label, failure_prefix)?;
    let actual = std::fs::read(path).map_err(|error| format!("{failure_prefix}: {error}"))?;
    if actual != expected {
        return Err(format!(
            "{failure_prefix}: {label} changed after publication"
        ));
    }
    Ok(())
}

fn validate_owner_only_regular_file(
    path: &Path,
    label: &str,
    failure_prefix: &str,
) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("{failure_prefix}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{failure_prefix}: {label} must be a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(format!("{failure_prefix}: {label} is not owner-only"));
        }
    }
    Ok(())
}

/// spawn 직전 검증을 통과한 notify 스크립트 경로 — 없으면(서버 미가동·검증
/// 실패) None. 호출자는 주입을 건너뛰어 추론-전용으로 무해하게 강등한다.
pub(crate) fn codex_notify_command() -> Option<String> {
    let published = published_codex_notify().lock().ok()?.clone()?;
    validate_published_file(
        &published.script_path,
        &published.script_contents,
        "codex notify script",
        "managed_codex_notify_unavailable",
    )
    .ok()?;
    Some(published.script_path.to_string_lossy().into_owned())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn codex_notify_chain(config_root: &Path) -> Result<Vec<String>, String> {
    let path = config_root.join("config.toml");
    let current = match std::fs::read_to_string(&path) {
        Ok(current) => current,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "managed_codex_notify_config_unavailable: read {}: {error}",
                path.display()
            ));
        }
    };
    let document: toml::Table = toml::from_str(&current).map_err(|error| {
        format!(
            "managed_codex_notify_config_invalid: parse {}: {error}",
            path.display()
        )
    })?;
    match document.get("notify") {
        None => Ok(Vec::new()),
        Some(toml::Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_string).ok_or_else(|| {
                    "managed_codex_notify_config_invalid: notify must be a string array"
                        .to_string()
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|chain| {
                chain
                    .into_iter()
                    .filter(|entry| !entry.ends_with(CODEX_NOTIFY_SCRIPT_FILE))
                    .collect()
            }),
        Some(_) => Err(
            "managed_codex_notify_config_invalid: notify must be a string array".to_string(),
        ),
    }
}

fn effective_codex_config_root(
    provider_state_environment: &ProviderStateEnvironment,
) -> Result<PathBuf, String> {
    effective_codex_config_root_from(
        provider_state_environment,
        std::env::var_os("CODEX_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

fn effective_codex_config_root_from(
    provider_state_environment: &ProviderStateEnvironment,
    inherited_codex_home: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(root) = provider_state_environment.values().get("CODEX_HOME") {
        return Ok(PathBuf::from(root));
    }
    if !provider_state_environment.removals().contains("CODEX_HOME") {
        if let Some(root) = inherited_codex_home.filter(|value| !value.as_os_str().is_empty()) {
            return Ok(root);
        }
    }
    home.filter(|value| !value.as_os_str().is_empty())
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "managed_codex_notify_config_unavailable: HOME is not set".to_string())
}

/// User-owned Codex notify argv stays out of the managed launch command and
/// Host discovery records. The content-addressed owner-only wrapper receives
/// the original Codex JSON after the managed reporter and executes the exact
/// user vector. Different credential overlays therefore never race on one
/// mutable wrapper path.
fn publish_codex_user_notify_wrapper(
    control_dir: &Path,
    chain: &[String],
) -> Result<Option<PathBuf>, String> {
    if chain.is_empty() {
        return Ok(None);
    }
    let serialized = serde_json::to_vec(chain)
        .map_err(|error| format!("managed_codex_notify_wrapper_invalid: {error}"))?;
    let digest = format!("{:x}", Sha256::digest(&serialized));
    let path = control_dir.join(format!(
        "{CODEX_USER_NOTIFY_WRAPPER_PREFIX}{digest}.sh"
    ));
    let contents = crate::managed_hook_rendering::render_codex_user_notify_wrapper(chain);
    write_owner_only_file(control_dir, &path, contents.as_bytes(), 0o700)
        .map_err(|error| format!("managed_codex_notify_wrapper_unavailable: {error}"))?;
    validate_published_file(
        &path,
        contents.as_bytes(),
        "codex user notify wrapper",
        "managed_codex_notify_wrapper_unavailable",
    )?;
    Ok(Some(path))
}

fn inject_provider_settings_from(
    provider_id: &str,
    command: &str,
    control_dir: &Path,
    codex_user_notify: &[String],
    native_launcher: Option<&str>,
) -> Result<String, String> {
    match provider_id {
        "claude" => {
            let suffix = if command == "claude" {
                ""
            } else {
                command.strip_prefix("claude ").ok_or_else(|| {
                    "managed_hook_command_unsupported: Claude command must use the reviewed executable"
                        .to_string()
                })?
            };
            let path = claude_settings_path(control_dir);
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("managed_hook_settings_unavailable: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(
                    "managed_hook_settings_unavailable: Claude settings must be a regular file"
                        .to_string(),
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err(
                        "managed_hook_settings_unavailable: Claude settings are not owner-only"
                            .to_string(),
                    );
                }
            }
            let separator = if suffix.is_empty() { "" } else { " " };
            Ok(format!(
                "claude --settings {}{separator}{suffix}",
                shell_quote(&path.to_string_lossy())
            ))
        }
        "codex" => {
            let suffix = if command == "codex" {
                ""
            } else {
                command.strip_prefix("codex ").ok_or_else(|| {
                    "managed_hook_command_unsupported: Codex command must use the reviewed executable"
                        .to_string()
                })?
            };
            let mut notify = Vec::new();
            if native_launcher.is_none() {
                notify.push(
                    codex_notify_script_path(control_dir).to_string_lossy().into_owned(),
                );
            }
            if let Some(wrapper) =
                publish_codex_user_notify_wrapper(control_dir, codex_user_notify)?
            {
                notify.push(wrapper.to_string_lossy().into_owned());
            }
            let override_value = toml::Value::Array(
                notify.into_iter().map(toml::Value::String).collect(),
            );
            let terminal_title =
                toml::Value::Array(vec![toml::Value::String("thread".to_string())]);
            let mut arguments = vec![
                "-c".to_string(),
                format!("tui.terminal_title={terminal_title}"),
                "-c".to_string(),
                format!("notify={override_value}"),
            ];
            if native_launcher.is_none() {
                arguments.extend(
                    codex_lifecycle_hook_arguments_v1(
                        &codex_notify_script_path(control_dir).to_string_lossy(),
                    )
                    .map_err(|error| format!("managed_codex_lifecycle_unavailable: {error}"))?,
                );
            }
            let config_arguments = arguments
                .into_iter()
                .map(|argument| shell_quote(&argument))
                .collect::<Vec<_>>()
                .join(" ");
            let separator = if suffix.is_empty() { "" } else { " " };
            let prefix = native_launcher
                .map(|path| format!("{} ", shell_quote(path)))
                .unwrap_or_default();
            Ok(format!("{prefix}codex {config_arguments}{separator}{suffix}"))
        }
        _ => Ok(command.to_string()),
    }
}

pub(crate) fn inject_provider_settings(
    provider_id: &str,
    command: &str,
    provider_state_environment: &ProviderStateEnvironment,
) -> Result<String, String> {
    #[cfg(unix)]
    if (matches!(provider_id, "pi" | "gemini")
        && (command == provider_id || command.starts_with(&format!("{provider_id} "))))
        || (provider_id == "qwen-code" && (command == "qwen" || command.starts_with("qwen ")))
    {
        let channel = crate::app_channel::current()
            .map_err(|error| format!("managed_provider_integration_unavailable: {error}"))?;
        return integrations::inject_command_wrapper(provider_id, command, &channel);
    }
    if provider_id != "claude" && provider_id != "codex" {
        return Ok(command.to_string());
    }
    let channel = crate::app_channel::current()
        .map_err(|error| format!("managed_hook_settings_unavailable: {error}"))?;
    let codex_user_notify = if provider_id == "claude" {
        let path = claude_settings_path(&channel.control_dir);
        let published = published_claude_settings()
            .lock()
            .map_err(|_| {
                "managed_hook_settings_unavailable: settings registry poisoned".to_string()
            })?
            .clone()
            .ok_or_else(|| {
                "managed_hook_settings_unavailable: settings were not published by this app process"
                    .to_string()
            })?;
        validate_published_claude_settings(&path, &published)?;
        Vec::new()
    } else {
        let expected = codex_notify_script_path(&channel.control_dir);
        let published = codex_notify_command().ok_or_else(|| {
            "managed_codex_notify_unavailable: notify files were not published by this app process"
                .to_string()
        })?;
        if Path::new(&published) != expected {
            return Err(
                "managed_codex_notify_unavailable: notify script belongs to another app channel"
                    .to_string(),
            );
        }
        codex_notify_chain(&effective_codex_config_root(provider_state_environment)?)?
    };
    #[cfg(unix)]
    let native_launcher = if provider_id == "codex" {
        Some(codex_native::launcher_path()?.ok_or_else(|| {
            "managed_codex_launcher_unavailable: native launcher was not published".to_string()
        })?)
    } else {
        None
    };
    #[cfg(not(unix))]
    let native_launcher: Option<String> = None;
    inject_provider_settings_from(
        provider_id,
        command,
        &channel.control_dir,
        &codex_user_notify,
        native_launcher.as_deref(),
    )
}

fn inject_app_channel_from(command: &str, channel: &str) -> String {
    let prefix = dure_provider_adapter::managed_environment::unix_managed_environment_prefix(channel)
        .iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{prefix} {command}")
}

fn inject_dure_command_path_from(command: &str, directory: &Path) -> Result<String, String> {
    let directory = directory
        .to_str()
        .ok_or_else(|| "managed Dure CLI command directory is not UTF-8".to_string())?;
    Ok(format!(
        "PATH={}:\"${{PATH:-}}\" {command}",
        shell_quote(directory),
    ))
}

/// A complete shell command whose environment assignments precede `exec`.
/// Consumers pass it to the shell unchanged so they cannot reorder the launch.
#[derive(Clone)]
#[must_use]
pub(crate) struct PreparedManagedExec(String);

impl PreparedManagedExec {
    pub(crate) fn with_shell_argument(mut self, argument: &str) -> Self {
        self.0.push(' ');
        self.0.push_str(&shell_quote(argument));
        self
    }

    pub(crate) fn into_command_template(self, shell: &Path) -> Vec<String> {
        vec![
            shell.to_string_lossy().into_owned(),
            "-lc".to_string(),
            self.0,
        ]
    }
}

fn render_managed_exec_from(
    command: &str,
    channel: &str,
    dure_command_directory: &Path,
) -> Result<PreparedManagedExec, String> {
    let command = inject_app_channel_from(command, channel);
    let command = format!("exec {command}");
    inject_dure_command_path_from(&command, dure_command_directory).map(PreparedManagedExec)
}

/// Pin commands launched inside a managed provider to this exact app channel.
/// The Hmux runtime intentionally exposes only terminal-display overrides, so
/// adapter-owned routing state travels in the reviewed launch command instead
/// of widening the provider-neutral environment contract.
pub(crate) fn prepare_managed_exec(
    provider_id: &str,
    command: &str,
    provider_state_environment: &ProviderStateEnvironment,
) -> Result<PreparedManagedExec, String> {
    let command = inject_provider_settings(provider_id, command, provider_state_environment)?;
    let channel = crate::app_channel::current()
        .map_err(|error| format!("resolve Dure app channel for managed provider failed: {error}"))?;
    let home = dirs::home_dir()
        .ok_or_else(|| "resolve home for managed Dure CLI failed".to_string())?;
    let dure = crate::dure_cli_install::resolve_channel_dure_command(&channel.name, &home)?
        .ok_or_else(|| {
            format!(
                "managed Dure CLI is unavailable for app channel `{}`",
                channel.name
            )
        })?;
    render_managed_exec_from(&command, &channel.name, &dure.directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_default_codex_config_ignores_a_poisoned_inherited_selector() {
        let environment = ProviderStateEnvironment::from_mutations(
            BTreeMap::new(),
            std::collections::BTreeSet::from(["CODEX_HOME".into(), "CODEX_SQLITE_HOME".into()]),
        )
        .unwrap();

        assert_eq!(
            effective_codex_config_root_from(
                &environment,
                Some(PathBuf::from("/poisoned/codex-home")),
                Some(PathBuf::from("/canonical/home")),
            )
            .unwrap(),
            PathBuf::from("/canonical/home/.codex")
        );
    }

    #[test]
    fn settings_use_a_token_free_channel_handoff_command() {
        let settings = claude_settings(Path::new("/tmp/dure/managed-claude-hook-v1.py"));
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["type"],
            "command"
        );
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "/tmp/dure/managed-claude-hook-v1.py"
        );
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["args"],
            json!(["claude", "--managed-direct", "--terminal-events"])
        );
        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(!serialized.contains("Bearer"));
        assert!(!serialized.contains("127.0.0.1"));
        assert!(settings.get("permissions").is_none());
        assert!(settings.get("env").is_none());
    }

    #[test]
    fn non_claude_commands_are_unchanged() {
        assert_eq!(
            inject_provider_settings_from("kimi", "kimi", Path::new("/unused"), &[], None).unwrap(),
            "kimi"
        );
    }

    #[test]
    fn system_default_codex_launch_injects_the_managed_completion_reporter() {
        let fixture = std::env::temp_dir().join(format!(
            "dure-codex-launch-isolation-{}",
            crate::server::gen_token().unwrap()
        ));
        let home = fixture.join("home");
        let dure_home = fixture.join("dure-home");
        let discovery_root = fixture.join("hmux-discovery");
        let control = dure_home.join("channels/dev-completion-red-a1b2c3d4");
        for directory in [&home, &control, &discovery_root] {
            std::fs::create_dir_all(directory).unwrap();
        }

        let command = inject_provider_settings_from(
            "codex",
            "codex resume 0199aaaa-bbbb-7ac2-97b7-617afd8e0d27",
            &control,
            &[],
            None,
        )
        .unwrap();

        assert!(
            command.contains("managed-codex-notify.sh"),
            "system-default managed Codex launch had no semantic completion producer: {command}"
        );
        assert!(command.contains("notify="), "Codex notify override missing: {command}");
        assert!(
            command.contains("hooks.SessionStart=") && command.contains("startup|resume|clear"),
            "Codex startup identity hook missing: {command}"
        );
        assert!(command.contains("hooks.Interrupt="), "Codex interruption hook missing: {command}");
        assert!(
            !command.contains("hooks.Stop="),
            "Codex completion was installed twice: {command}"
        );
        assert!(
            command.contains("--dangerously-bypass-hook-trust"),
            "managed Codex hooks still require interactive trust: {command}"
        );
        assert!(
            !command.contains("hooks.state="),
            "managed Codex launch duplicated Codex's private hook trust state: {command}"
        );
        assert!(
            command.contains("tui.terminal_title") && command.contains("thread"),
            "managed Codex launch did not request the thread terminal title: {command}"
        );
        assert!(
            !command.contains("tui.alternate_screen="),
            "managed Codex launch unexpectedly overrode its inline-screen policy: {command}"
        );
        assert!(home.starts_with(&fixture));
        assert!(dure_home.starts_with(&fixture));
        assert!(discovery_root.starts_with(&fixture));
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn provider_runtime_contract_projects_both_thin_adapters_without_tokens() {
        let document = provider_runtime_integrations_document(
            "dev-completion-contract-a1b2c3d4",
            Some(PathBuf::from("/fixture/managed-claude-settings.json")),
            Some(ProviderRuntimeIntegrationV1::NotificationCommand {
                command: vec![
                    "/fixture/managed-codex-notify.sh".into(),
                    "/fixture/managed-codex-user-notify.sh".into(),
                ],
            }),
            BTreeMap::new(),
        )
        .unwrap();

        assert!(matches!(
            document
                .integration(&ProviderIdV1::new("claude").unwrap())
                .unwrap(),
            ProviderRuntimeIntegrationV1::SettingsFile { .. }
        ));
        assert!(matches!(
            document
                .integration(&ProviderIdV1::new("codex").unwrap())
                .unwrap(),
            ProviderRuntimeIntegrationV1::NotificationCommand { .. }
        ));
        let serialized = serde_json::to_string(&document).unwrap();
        assert!(!serialized.contains("Bearer"));
        assert!(!serialized.contains("report-secret"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_launch_keeps_user_notify_argv_private_and_chains_the_original_json() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = std::env::temp_dir().join(format!(
            "dure-codex-user-notify-isolation-{}",
            crate::server::gen_token().unwrap()
        ));
        let control = fixture.join("dure-home/channels/dev-completion-green-b2c3d4e5");
        std::fs::create_dir_all(&control).unwrap();
        let marker = fixture.join("user-notify-received");
        let user_script = fixture.join("user-notify.sh");
        std::fs::write(
            &user_script,
            format!(
                "#!/bin/sh\nprintf '%s\\n%s' \"$1\" \"$2\" > '{}'\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&user_script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let private_argument = "private-user-notify-argument";
        let chain = vec![
            user_script.to_string_lossy().into_owned(),
            private_argument.to_string(),
        ];

        let command = inject_provider_settings_from("codex", "codex", &control, &chain, None).unwrap();
        assert!(command.contains(CODEX_NOTIFY_SCRIPT_FILE));
        assert!(command.contains(CODEX_USER_NOTIFY_WRAPPER_PREFIX));
        assert!(
            !command.contains(private_argument),
            "user notify argv leaked into the launch command: {command}"
        );

        let wrapper = std::fs::read_dir(&control)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(CODEX_USER_NOTIFY_WRAPPER_PREFIX))
            })
            .expect("content-addressed user notify wrapper");
        assert_eq!(
            std::fs::symlink_metadata(&wrapper)
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );

        let payload = r#"{"type":"agent-turn-complete","turn-id":"0199cccc-dddd-7b80"}"#;
        let status = std::process::Command::new(&wrapper)
            .arg(payload)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            std::fs::read_to_string(marker).unwrap(),
            format!("{private_argument}\n{payload}")
        );

        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn managed_exec_pins_the_channel_launcher_after_shell_startup() {
        let command = render_managed_exec_from(
            "codex --resume conversation-1",
            "dev-feature-a1b2c3d4",
            Path::new("/verified channel/bin"),
        )
        .unwrap()
        .into_command_template(Path::new("/bin/sh"));
        assert_eq!(
            command[2],
            format!("PATH='/verified channel/bin':\"${{PATH:-}}\" exec {}", inject_app_channel_from("codex --resume conversation-1", "dev-feature-a1b2c3d4"))
        );
    }

    #[test]
    fn managed_exec_runs_after_shell_environment_assignments() {
        let command = render_managed_exec_from(
            "/usr/bin/printf managed-launch-ready",
            "dev-feature-a1b2c3d4",
            Path::new("/verified channel/bin"),
        )
        .unwrap()
        .into_command_template(Path::new("/bin/sh"));
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"managed-launch-ready");
    }

    #[cfg(unix)]
    #[test]
    fn published_owner_only_settings_leave_other_channels_untouched_and_inject_claude() {
        use std::os::unix::fs::PermissionsExt;

        let app_root = std::env::temp_dir().join(format!(
            "hebbian-managed-hooks-{}",
            crate::server::gen_token().unwrap()
        ));
        let channels = app_root.join("channels");
        let directory = channels.join("dev-current-a1b2c3d4");
        let previous = channels.join("dev-previous-a1b2c3d4");
        let unsafe_channel = channels.join("dev-unsafe-a1b2c3d4");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::create_dir(&previous).unwrap();
        std::fs::create_dir(&unsafe_channel).unwrap();
        for path in [&channels, &directory, &previous, &unsafe_channel] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let previous_settings = claude_settings_path(&previous);
        std::fs::write(&previous_settings, b"{\"legacy\":true}\n").unwrap();
        std::fs::set_permissions(&previous_settings, std::fs::Permissions::from_mode(0o600))
            .unwrap();
        let unsafe_settings = claude_settings_path(&unsafe_channel);
        let unsafe_contents = b"{\"notOwnerOnly\":true}\n";
        std::fs::write(&unsafe_settings, unsafe_contents).unwrap();
        std::fs::set_permissions(
            &unsafe_settings,
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let script_contents = native_hook_shim(Path::new("/fixture/bin/dure-control-plane")).unwrap();
        publish_claude_settings_from(&directory, script_contents).unwrap();

        let path = claude_settings_path(&directory);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let script_path = claude_hook_script_path(&directory);
        assert_eq!(
            std::fs::metadata(&script_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read(&previous_settings).unwrap(),
            b"{\"legacy\":true}\n"
        );
        assert!(!claude_hook_script_path(&previous).exists());
        assert_eq!(std::fs::read(&unsafe_settings).unwrap(), unsafe_contents);
        assert!(!claude_settings_path(&app_root).exists());
        let command =
            inject_provider_settings_from(
                "claude",
                "claude --resume conversation-1",
                &directory,
                &[],
                None,
            )
            .unwrap();
        assert!(command.starts_with("claude --settings '"));
        assert!(command.ends_with("' --resume conversation-1"));

        std::fs::remove_dir_all(app_root).unwrap();
    }

    #[test]
    fn claude_settings_register_every_lease_bearing_lifecycle_hook() {
        let settings = claude_settings(Path::new("/managed/hook.py"));
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "Stop",
            "Notification",
        ] {
            assert!(
                settings["hooks"][event][0]["hooks"][0]["command"].is_string(),
                "{event} hook missing"
            );
        }
    }

    #[test]
    fn changed_settings_or_script_fail_the_publication_generation_check() {
        let directory = std::env::temp_dir().join(format!(
            "hebbian-managed-hooks-stale-{}",
            crate::server::gen_token().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = claude_settings_path(&directory);
        let expected = b"{\"hooks\": {\"SessionStart\": []}}\n".to_vec();
        std::fs::write(&path, &expected).unwrap();
        let script_path = claude_hook_script_path(&directory);
        std::fs::write(&script_path, MANAGED_PROVIDER_HOOK_SCRIPT).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let published = PublishedClaudeSettings {
            path: path.clone(),
            contents: expected,
            script_path,
            script_contents: MANAGED_PROVIDER_HOOK_SCRIPT.to_vec(),
        };
        validate_published_claude_settings(&path, &published).unwrap();

        std::fs::write(&path, b"{\"hooks\": {}}\n").unwrap();
        assert!(validate_published_claude_settings(&path, &published)
            .unwrap_err()
            .contains("changed after publication"));

        std::fs::write(&path, &published.contents).unwrap();
        std::fs::write(&published.script_path, b"#!/usr/bin/env python3\n").unwrap();
        assert!(validate_published_claude_settings(&path, &published)
            .unwrap_err()
            .contains("Claude channel handoff script changed after publication"));

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn shell_quote_handles_apostrophes_without_exposing_a_shell_fragment() {
        assert_eq!(shell_quote("/tmp/a'b"), "'/tmp/a'\"'\"'b'");
    }

    #[test]
    fn codex_lifecycle_script_is_token_free_and_supports_native_boundaries() {
        let script = std::str::from_utf8(MANAGED_PROVIDER_HOOK_SCRIPT).unwrap();
        assert!(script.contains("internal-hmux-managed-agent-state-report"));
        assert!(script.contains("hmux-managed-agent-state-report-v1"));
        assert!(script.contains("agent-turn-complete"));
        assert!(script.contains("SessionStart"));
        assert!(script.contains("UserPromptSubmit"));
        assert!(script.contains("run_codex_user_notify"));
        assert!(!script.contains("/hooks/codex"));
        assert!(!script.contains("report-secret"));
    }

    #[cfg(unix)]
    #[test]
    fn tampered_codex_notify_files_fail_publication_validation() {
        let directory = std::env::temp_dir().join(format!(
            "hebbian-codex-notify-tamper-{}",
            crate::server::gen_token().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("script.sh");
        write_owner_only_file(&directory, &path, b"#!/bin/sh\nexit 0\n", 0o700).unwrap();
        validate_published_file(
            &path,
            b"#!/bin/sh\nexit 0\n",
            "script",
            "managed_codex_notify_unavailable",
        )
        .unwrap();
        std::fs::write(&path, b"#!/bin/sh\nexit 1\n").unwrap();
        assert!(validate_published_file(
            &path,
            b"#!/bin/sh\nexit 0\n",
            "script",
            "managed_codex_notify_unavailable",
        )
        .unwrap_err()
        .contains("changed after publication"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// The only test mutating the global publication registry covers publish,
    /// validation, and tamper rejection serially. The QA smoke covers both
    /// native Codex lifecycle boundaries through the direct Hmux handoff.
    #[cfg(unix)]
    #[test]
    fn published_codex_lifecycle_script_is_owner_only_and_tamper_evident() {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!(
            "hebbian-codex-notify-{}",
            crate::server::gen_token().unwrap()
        ));
        std::fs::create_dir(&directory).unwrap();
        let runtime = Path::new("/fixture/immutable/hmux-runtime");
        let rendered = render_managed_provider_hook_script(runtime).unwrap();
        publish_codex_notify(&directory, runtime).unwrap();
        let script = codex_notify_command().expect("published notify must verify");
        assert_eq!(script, codex_notify_script_path(&directory).to_string_lossy());
        assert_eq!(
            std::fs::metadata(&script).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(std::fs::read(&script).unwrap(), rendered);
        assert!(
            std::str::from_utf8(&rendered)
                .unwrap()
                .contains("/fixture/immutable/hmux-runtime")
        );

        // A post-publication mutation must make spawn injection fail closed.
        std::fs::write(codex_notify_script_path(&directory), "#!/bin/sh\nexit 0\n").unwrap();
        assert!(codex_notify_command().is_none());

        // Clear ambient publication state before another test can observe it.
        *published_codex_notify().lock().unwrap() = None;
        std::fs::remove_dir_all(directory).unwrap();
    }
}
