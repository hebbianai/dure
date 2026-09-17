use hmux_client::{interactive_terminal_environment_policy, TerminalEnvironment};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::login_shell::resolve_login_shell;

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const ENVIRONMENT_TIMEOUT: Duration = Duration::from_secs(3);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_ENVIRONMENT_OUTPUT: usize = 256 * 1024;
const MAX_VERSION_OUTPUT: usize = 8 * 1024;
const MAX_SYMLINK_DEPTH: usize = 40;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreflight {
    provider: String,
    command: String,
    ready: bool,
    status: &'static str,
    message: String,
    shell: String,
    cwd: String,
    environment_source: &'static str,
    path: Option<String>,
    command_path: Option<String>,
    resolved_path: Option<String>,
    symlink_chain: Vec<String>,
    executable: bool,
    version: Option<String>,
    version_timeout_ms: u64,
    inherited_no_color: Option<String>,
    effective_no_color: Option<String>,
    recovery_requires_user_approval: bool,
    suggested_recovery: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedLoginCommandEnvironment {
    pub executable: PathBuf,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug)]
pub(crate) enum LoginCommandEnvironmentError {
    Unavailable(String),
    Failed(String),
}

impl From<String> for LoginCommandEnvironmentError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<LoginCommandEnvironmentError> for String {
    fn from(error: LoginCommandEnvironmentError) -> Self {
        match error {
            LoginCommandEnvironmentError::Unavailable(message)
            | LoginCommandEnvironmentError::Failed(message) => message,
        }
    }
}

pub(crate) fn resolve_login_command_environment(
    command_name: &str,
    cwd: &Path,
    terminal_environment: TerminalEnvironment,
) -> Result<ResolvedLoginCommandEnvironment, LoginCommandEnvironmentError> {
    resolve_login_command_environment_with_shell(
        command_name,
        cwd,
        terminal_environment,
        &resolve_login_shell(),
        ENVIRONMENT_TIMEOUT,
    )
}

fn resolve_login_command_environment_with_shell(
    command_name: &str,
    cwd: &Path,
    terminal_environment: TerminalEnvironment,
    shell: &Path,
    timeout: Duration,
) -> Result<ResolvedLoginCommandEnvironment, LoginCommandEnvironmentError> {
    validate_command_name(command_name)?;
    terminal_environment
        .validate()
        .map_err(|error| error.to_string())?;
    let cwd = fs::canonicalize(cwd)
        .map_err(|error| format!("resolve login command cwd failed: {error}"))?;
    if !cwd.is_dir() {
        return Err("login command cwd must be a directory".to_string().into());
    }
    let environment = capture_login_environment(shell, &cwd, &terminal_environment, timeout)
        .map_err(|failure| match failure {
            CommandFailure::Timeout => "login shell environment resolution timed out".to_string(),
            CommandFailure::Failed(message) => message,
        })?;
    resolve_login_command_from_environment(command_name, &cwd, environment)
}

fn resolve_login_command_from_environment(
    command_name: &str,
    cwd: &Path,
    environment: BTreeMap<String, String>,
) -> Result<ResolvedLoginCommandEnvironment, LoginCommandEnvironmentError> {
    let path = environment.get("PATH").map(String::as_str).unwrap_or("");
    let PathResolution::Ready {
        resolved_path: executable,
        ..
    } = resolve_from_path(command_name, path, cwd)
    else {
        return Err(LoginCommandEnvironmentError::Unavailable(format!(
            "{command_name} was not a runnable file in the login-shell PATH"
        )));
    };
    Ok(ResolvedLoginCommandEnvironment {
        executable,
        environment,
    })
}

impl ProviderPreflight {
    fn base(
        provider: &str,
        command: &str,
        shell: &Path,
        cwd: &Path,
        inherited_no_color: Option<String>,
    ) -> Self {
        Self {
            provider: provider.to_string(),
            command: command.to_string(),
            ready: false,
            status: "environment_failed",
            message: "provider environment preflight did not complete".to_string(),
            shell: shell.to_string_lossy().into_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
            environment_source: "login_shell",
            path: None,
            command_path: None,
            resolved_path: None,
            symlink_chain: Vec::new(),
            executable: false,
            version: None,
            version_timeout_ms: VERSION_TIMEOUT.as_millis() as u64,
            inherited_no_color,
            effective_no_color: None,
            recovery_requires_user_approval: true,
            suggested_recovery: Vec::new(),
        }
    }
}

pub fn run(
    provider: &str,
    command_name: &str,
    cwd: &Path,
    terminal_environment: TerminalEnvironment,
    include_version: bool,
) -> Result<ProviderPreflight, String> {
    validate_command_name(command_name)?;
    terminal_environment
        .validate()
        .map_err(|error| error.to_string())?;
    let cwd = fs::canonicalize(cwd)
        .map_err(|error| format!("resolve provider preflight cwd failed: {error}"))?;
    if !cwd.is_dir() {
        return Err("provider preflight cwd must be a directory".to_string());
    }
    let shell = resolve_login_shell();
    let inherited_no_color = std::env::var("NO_COLOR").ok();
    let mut result =
        ProviderPreflight::base(provider, command_name, &shell, &cwd, inherited_no_color);

    let environment =
        match capture_login_environment(&shell, &cwd, &terminal_environment, ENVIRONMENT_TIMEOUT) {
            Ok(environment) => environment,
            Err(CommandFailure::Timeout) => {
                result.status = "environment_timeout";
                result.message = format!(
                    "login shell environment did not resolve within {} ms",
                    ENVIRONMENT_TIMEOUT.as_millis()
                );
                result.suggested_recovery = vec![
                    "Review slow or blocking login-shell startup files, then retry.".to_string(),
                ];
                return Ok(result);
            }
            Err(CommandFailure::Failed(message)) => {
                result.message = message;
                result.suggested_recovery = vec![
                    "Review the configured SHELL and its login startup files, then retry."
                        .to_string(),
                ];
                return Ok(result);
            }
        };

    Ok(inspect_command(result, &cwd, &environment, include_version))
}

fn inspect_command(
    mut result: ProviderPreflight,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    include_version: bool,
) -> ProviderPreflight {
    let command_name = result.command.as_str();
    let provider = result.provider.as_str();
    result.path = environment.get("PATH").cloned();
    result.effective_no_color = environment.get("NO_COLOR").cloned();
    let path = environment.get("PATH").map(String::as_str).unwrap_or("");
    match resolve_from_path(command_name, path, cwd) {
        PathResolution::Ready {
            command_path,
            resolved_path,
            symlink_chain,
        } => {
            result.command_path = Some(command_path.to_string_lossy().into_owned());
            result.resolved_path = Some(resolved_path.to_string_lossy().into_owned());
            result.symlink_chain = display_paths(&symlink_chain);
            result.executable = true;

            if !include_version {
                result.ready = true;
                result.status = "ready";
                result.message = format!("{provider} executable is available");
                result.recovery_requires_user_approval = false;
                return result;
            }

            match run_version(&resolved_path, cwd, environment, VERSION_TIMEOUT) {
                Ok(version) => {
                    result.ready = true;
                    result.status = "ready";
                    result.message = format!("{provider} provider is ready");
                    result.version = Some(version);
                    result.recovery_requires_user_approval = false;
                }
                Err(CommandFailure::Timeout) => {
                    result.status = "version_timeout";
                    result.message = format!(
                        "{} --version exceeded the {} ms timeout",
                        resolved_path.display(),
                        VERSION_TIMEOUT.as_millis()
                    );
                    result.suggested_recovery = vec![
                        "Run the reported executable's --version command manually and inspect why it blocks."
                            .to_string(),
                    ];
                }
                Err(CommandFailure::Failed(message)) => {
                    result.status = "version_failed";
                    result.message = message;
                    result.suggested_recovery = vec![
                        "Inspect or reinstall the reported executable only after user approval."
                            .to_string(),
                    ];
                }
            }
        }
        PathResolution::BrokenSymlink {
            command_path,
            symlink_chain,
            missing_target,
        } => {
            result.status = "broken_symlink";
            result.command_path = Some(command_path.to_string_lossy().into_owned());
            result.symlink_chain = display_paths(&symlink_chain);
            result.message = format!(
                "{} resolves through a broken symlink; missing target: {}",
                command_path.display(),
                missing_target.display()
            );
            result.suggested_recovery = vec![
                "Repair or reinstall the provider only after explicit user approval.".to_string(),
                "Select another verified provider executable path for this session.".to_string(),
            ];
        }
        PathResolution::NotExecutable { command_path } => {
            result.status = "not_executable";
            result.command_path = Some(command_path.to_string_lossy().into_owned());
            result.resolved_path = fs::canonicalize(&command_path)
                .ok()
                .map(|path| path.to_string_lossy().into_owned());
            result.message = format!(
                "{} exists in the spawn PATH but is not executable",
                command_path.display()
            );
            result.suggested_recovery = vec![
                "Review the file permissions or select another executable after user approval."
                    .to_string(),
            ];
        }
        PathResolution::NotFound => {
            if let Some(discovered) = discover_in_parent_path(command_name, path, cwd) {
                result.status = "path_missing";
                result.message = format!(
                    "{command_name} is absent from the login-shell spawn PATH but exists at {}",
                    discovered.display()
                );
                result.suggested_recovery = vec![
                    "Update the login-shell PATH or select the discovered executable after user approval."
                        .to_string(),
                ];
            } else {
                result.status = "not_found";
                result.message =
                    format!("{command_name} was not found in the login-shell spawn PATH");
                result.suggested_recovery = vec![
                    "Install the provider or configure its PATH only after explicit user approval."
                        .to_string(),
                ];
            }
        }
    }
    result
}

fn validate_command_name(command_name: &str) -> Result<(), String> {
    if command_name.is_empty()
        || command_name == "."
        || command_name == ".."
        || command_name.contains(['/', '\\'])
        || command_name.chars().any(char::is_whitespace)
    {
        return Err("provider preflight command must be a single executable basename".to_string());
    }
    Ok(())
}

fn apply_terminal_environment(command: &mut Command, environment: &TerminalEnvironment) {
    let policy = interactive_terminal_environment_policy(environment);
    for key in policy.remove() {
        command.env_remove(key);
    }
    for (key, value) in policy.set() {
        command.env(key, value);
    }
}

fn capture_login_environment(
    shell: &Path,
    cwd: &Path,
    terminal_environment: &TerminalEnvironment,
    timeout: Duration,
) -> Result<BTreeMap<String, String>, CommandFailure> {
    let mut command = Command::new(shell);
    command
        .args(["-lc", "env -0"])
        .current_dir(cwd)
        .stdin(Stdio::null());
    apply_terminal_environment(&mut command, terminal_environment);
    let output = run_command(&mut command, timeout, MAX_ENVIRONMENT_OUTPUT)?;
    if !output.status.success() {
        return Err(CommandFailure::Failed(format!(
            "login shell environment exited with {}: {}",
            output.status,
            first_line(&output.stderr)
        )));
    }
    let mut environment = BTreeMap::new();
    for entry in output.stdout.split(|byte| *byte == 0) {
        let Some(separator) = entry.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let key = String::from_utf8_lossy(&entry[..separator]).into_owned();
        let value = String::from_utf8_lossy(&entry[separator + 1..]).into_owned();
        environment.insert(key, value);
    }
    Ok(environment)
}

fn run_version(
    executable: &Path,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    timeout: Duration,
) -> Result<String, CommandFailure> {
    let mut command = Command::new(executable);
    command
        .arg("--version")
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null());
    let output = run_command(&mut command, timeout, MAX_VERSION_OUTPUT)?;
    let version = first_nonempty_line(&output.stdout)
        .or_else(|| first_nonempty_line(&output.stderr))
        .unwrap_or_default();
    if output.status.success() {
        Ok(version)
    } else {
        Err(CommandFailure::Failed(format!(
            "{} --version exited with {}{}",
            executable.display(),
            output.status,
            if version.is_empty() {
                String::new()
            } else {
                format!(": {version}")
            }
        )))
    }
}

#[derive(Debug)]
enum PathResolution {
    Ready {
        command_path: PathBuf,
        resolved_path: PathBuf,
        symlink_chain: Vec<PathBuf>,
    },
    BrokenSymlink {
        command_path: PathBuf,
        symlink_chain: Vec<PathBuf>,
        missing_target: PathBuf,
    },
    NotExecutable {
        command_path: PathBuf,
    },
    NotFound,
}

fn resolve_from_path(command_name: &str, path: &str, cwd: &Path) -> PathResolution {
    let mut broken = None;
    let mut not_executable = None;
    for directory in std::env::split_paths(path) {
        let directory = if directory.as_os_str().is_empty() {
            cwd.to_path_buf()
        } else if directory.is_relative() {
            cwd.join(directory)
        } else {
            directory
        };
        let candidate = directory.join(command_name);
        if fs::symlink_metadata(&candidate).is_err() {
            continue;
        }
        match resolve_symlink_chain(&candidate) {
            Ok((resolved_path, symlink_chain)) if is_executable_file(&resolved_path) => {
                return PathResolution::Ready {
                    command_path: candidate,
                    resolved_path,
                    symlink_chain,
                };
            }
            Ok(_) => {
                not_executable.get_or_insert(candidate);
            }
            Err((symlink_chain, missing_target)) => {
                broken.get_or_insert((candidate, symlink_chain, missing_target));
            }
        }
    }
    if let Some((command_path, symlink_chain, missing_target)) = broken {
        PathResolution::BrokenSymlink {
            command_path,
            symlink_chain,
            missing_target,
        }
    } else if let Some(command_path) = not_executable {
        PathResolution::NotExecutable { command_path }
    } else {
        PathResolution::NotFound
    }
}

fn resolve_symlink_chain(path: &Path) -> Result<(PathBuf, Vec<PathBuf>), (Vec<PathBuf>, PathBuf)> {
    let mut current = path.to_path_buf();
    let mut chain = Vec::new();
    let mut visited = HashSet::new();
    for _ in 0..MAX_SYMLINK_DEPTH {
        if !visited.insert(current.clone()) {
            chain.push(current.clone());
            return Err((chain, current));
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(_) => return Err((chain, current)),
        };
        if !metadata.file_type().is_symlink() {
            return match fs::canonicalize(&current) {
                Ok(resolved) => Ok((resolved, chain)),
                Err(_) => Err((chain, current)),
            };
        }
        chain.push(current.clone());
        let target = fs::read_link(&current).map_err(|_| (chain.clone(), current.clone()))?;
        current = if target.is_absolute() {
            target
        } else {
            current
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(target)
        };
    }
    Err((chain, current))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn discover_in_parent_path(command_name: &str, spawn_path: &str, cwd: &Path) -> Option<PathBuf> {
    let parent_path = std::env::var("PATH").ok()?;
    if parent_path == spawn_path {
        return None;
    }
    match resolve_from_path(command_name, &parent_path, cwd) {
        PathResolution::Ready { command_path, .. } => Some(command_path),
        _ => None,
    }
}

fn display_paths(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[derive(Debug)]
pub(crate) enum CommandFailure {
    Timeout,
    Failed(String),
}

pub(crate) struct CommandOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

pub(crate) fn run_command(
    command: &mut Command,
    timeout: Duration,
    output_limit: usize,
) -> Result<CommandOutput, CommandFailure> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| CommandFailure::Failed(format!("could not start command: {error}")))?;
    let process_group = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandFailure::Failed("command stdout was unavailable".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CommandFailure::Failed("command stderr was unavailable".to_string()))?;
    let (stdout_sender, stdout_receiver) = mpsc::sync_channel(1);
    let (stderr_sender, stderr_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = stdout_sender.send(read_capped(stdout, output_limit));
    });
    thread::spawn(move || {
        let _ = stderr_sender.send(read_capped(stderr, output_limit));
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(PROCESS_POLL_INTERVAL),
            Ok(None) => {
                terminate_command(&mut child, process_group);
                return Err(CommandFailure::Timeout);
            }
            Err(error) => {
                terminate_command(&mut child, process_group);
                return Err(CommandFailure::Failed(format!(
                    "could not inspect command: {error}"
                )));
            }
        }
    };
    let stdout = match receive_output(stdout_receiver, deadline, "stdout") {
        Ok(stdout) => stdout,
        Err(error) => {
            terminate_command(&mut child, process_group);
            return Err(error);
        }
    };
    let stderr = match receive_output(stderr_receiver, deadline, "stderr") {
        Ok(stderr) => stderr,
        Err(error) => {
            terminate_command(&mut child, process_group);
            return Err(error);
        }
    };
    Ok(CommandOutput {
        status,
        stdout,
        stderr,
    })
}

fn terminate_command(child: &mut Child, process_group: u32) {
    #[cfg(unix)]
    if let Ok(process_group) = i32::try_from(process_group) {
        // The diagnostic command owns this fresh process group, so timeout
        // cleanup cannot signal the app or an existing provider session.
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = process_group;
    let _ = child.kill();
    let _ = child.wait();
}

fn receive_output(
    receiver: mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
    stream: &str,
) -> Result<Vec<u8>, CommandFailure> {
    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(output) => Ok(output),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(CommandFailure::Timeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CommandFailure::Failed(format!(
            "command {stream} reader stopped unexpectedly"
        ))),
    }
}

fn read_capped(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(length) => {
                let remaining = limit.saturating_sub(captured.len());
                captured.extend_from_slice(&buffer[..length.min(remaining)]);
            }
        }
    }
    captured
}

fn first_line(bytes: &[u8]) -> String {
    first_nonempty_line(bytes).unwrap_or_else(|| "no diagnostic output".to_string())
}

fn first_nonempty_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[cfg(unix)]
    #[test]
    fn executable_only_preflight_never_invokes_the_provider() {
        let directory = tempfile::tempdir().unwrap();
        let command = directory.path().join("codex");
        fs::write(
            &command,
            "#!/bin/sh\nprintf invoked > version-invoked\nexit 7\n",
        )
        .unwrap();
        fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
        let environment = BTreeMap::from([(
            "PATH".to_string(),
            directory.path().to_string_lossy().into_owned(),
        )]);
        let preflight = || {
            ProviderPreflight::base("codex", "codex", Path::new("/bin/sh"), directory.path(), None)
        };

        let result = inspect_command(preflight(), directory.path(), &environment, false);
        assert!(
            !directory.path().join("version-invoked").exists(),
            "executable resolution must not run --version"
        );
        assert!(result.ready && result.executable);
        assert_eq!(result.status, "ready");
        assert!(result.version.is_none());
        assert_eq!(
            result.resolved_path,
            Some(fs::canonicalize(&command).unwrap().to_string_lossy().into_owned())
        );

        let diagnostic = inspect_command(preflight(), directory.path(), &environment, true);
        assert!(directory.path().join("version-invoked").exists());
        assert!(!diagnostic.ready && diagnostic.executable);
        assert_eq!(diagnostic.status, "version_failed");
    }

    #[cfg(unix)]
    #[test]
    fn requested_version_diagnostics_keep_the_provider_version() {
        let directory = tempfile::tempdir().unwrap();
        let command = directory.path().join("claude");
        fs::write(&command, "#!/bin/sh\nprintf '2.1.212 (Claude Code)\\n'\n").unwrap();
        fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
        let result = inspect_command(
            ProviderPreflight::base("claude", "claude", Path::new("/bin/sh"), directory.path(), None),
            directory.path(),
            &BTreeMap::from([(
                "PATH".to_string(),
                directory.path().to_string_lossy().into_owned(),
            )]),
            true,
        );
        assert!(result.ready && result.executable);
        assert_eq!(result.version.as_deref(), Some("2.1.212 (Claude Code)"));
    }

    #[cfg(unix)]
    #[test]
    fn executable_only_preflight_still_rejects_an_unrunnable_file() {
        let directory = tempfile::tempdir().unwrap();
        let command = directory.path().join("codex");
        fs::write(&command, "not executable").unwrap();
        fs::set_permissions(&command, fs::Permissions::from_mode(0o600)).unwrap();
        let result = inspect_command(
            ProviderPreflight::base("codex", "codex", Path::new("/bin/sh"), directory.path(), None),
            directory.path(),
            &BTreeMap::from([(
                "PATH".to_string(),
                directory.path().to_string_lossy().into_owned(),
            )]),
            false,
        );
        assert!(!result.ready && !result.executable);
        assert_eq!(result.status, "not_executable");
    }

    #[cfg(unix)]
    #[test]
    fn path_resolution_reports_a_broken_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let command = directory.path().join("claude");
        symlink("missing-provider", &command).unwrap();

        let resolution = resolve_from_path(
            "claude",
            directory.path().to_string_lossy().as_ref(),
            directory.path(),
        );

        match resolution {
            PathResolution::BrokenSymlink {
                command_path,
                symlink_chain,
                missing_target,
            } => {
                assert_eq!(command_path, command);
                assert_eq!(symlink_chain, [command]);
                assert_eq!(missing_target, directory.path().join("missing-provider"));
            }
            other => panic!("expected broken symlink, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn path_resolution_follows_a_relative_symlink_to_an_executable() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("provider-real");
        fs::write(&target, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&target, permissions).unwrap();
        let command = directory.path().join("codex");
        symlink("provider-real", &command).unwrap();

        let resolution = resolve_from_path(
            "codex",
            directory.path().to_string_lossy().as_ref(),
            directory.path(),
        );

        match resolution {
            PathResolution::Ready {
                command_path,
                resolved_path,
                symlink_chain,
            } => {
                assert_eq!(command_path, command);
                assert_eq!(resolved_path, fs::canonicalize(target).unwrap());
                assert_eq!(symlink_chain, [command]);
            }
            other => panic!("expected ready executable, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn empty_path_entry_resolves_from_the_spawn_cwd() {
        let directory = tempfile::tempdir().unwrap();
        let command = directory.path().join("kimi");
        fs::write(&command, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&command).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&command, permissions).unwrap();

        let resolution = resolve_from_path("kimi", "", directory.path());

        assert!(matches!(
            resolution,
            PathResolution::Ready { command_path, .. } if command_path == command
        ));
    }

    #[cfg(unix)]
    #[test]
    fn relative_path_entry_resolves_from_the_spawn_cwd() {
        let directory = tempfile::tempdir().unwrap();
        let tools = directory.path().join("tools");
        fs::create_dir(&tools).unwrap();
        let command = tools.join("codex");
        fs::write(&command, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&command).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&command, permissions).unwrap();

        let resolution = resolve_from_path("codex", "tools", directory.path());

        assert!(matches!(
            resolution,
            PathResolution::Ready { command_path, .. } if command_path == command
        ));
    }

    #[test]
    fn login_environment_preserves_explicit_session_override() {
        let environment = TerminalEnvironment::new(BTreeMap::from([
            ("NO_COLOR".to_string(), Some("session-explicit".to_string())),
            ("COLORTERM".to_string(), None),
        ]))
        .unwrap();

        let captured = capture_login_environment(
            Path::new("/bin/sh"),
            Path::new("/tmp"),
            &environment,
            Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(
            captured.get("NO_COLOR").map(String::as_str),
            Some("session-explicit")
        );
        assert!(!captured.contains_key("COLORTERM"));
    }

    #[cfg(unix)]
    #[test]
    fn login_command_resolution_uses_the_captured_path() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = fixture.path().join("workspace");
        let tools = fixture.path().join("login-tools");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&tools).unwrap();
        let executable = tools.join("bd");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let resolved = resolve_login_command_from_environment(
            "bd",
            &workspace,
            BTreeMap::from([("PATH".to_string(), tools.to_string_lossy().into_owned())]),
        )
        .unwrap();

        assert_eq!(resolved.executable, fs::canonicalize(executable).unwrap());
        assert_eq!(
            resolved.environment.get("PATH").map(String::as_str),
            Some(tools.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn command_name_must_be_a_single_executable_basename() {
        assert!(validate_command_name("cursor-agent").is_ok());
        assert!(validate_command_name("goose session").is_err());
        assert!(validate_command_name("../codex").is_err());
        assert!(validate_command_name("/opt/bin/claude").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn version_probe_allows_a_loaded_provider_to_finish_within_the_policy_budget() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("codex");
        fs::write(
            &executable,
            "#!/bin/sh\n/bin/sleep 4\nprintf 'codex-cli 0.146.0\\n'\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();

        let result = run_version(
            &executable,
            directory.path(),
            &BTreeMap::new(),
            VERSION_TIMEOUT,
        );

        assert!(matches!(result.as_deref(), Ok("codex-cli 0.146.0")));
    }

    #[cfg(unix)]
    #[test]
    fn version_probe_has_a_hard_timeout() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 2"]);

        let started = Instant::now();
        let result = run_command(&mut command, Duration::from_millis(50), 1024);

        assert!(matches!(result, Err(CommandFailure::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn inherited_output_pipe_cannot_extend_the_hard_timeout() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 2 & exit 0"]);

        let started = Instant::now();
        let result = run_command(&mut command, Duration::from_millis(50), 1024);

        assert!(matches!(result, Err(CommandFailure::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
