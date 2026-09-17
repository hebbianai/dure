use dure_app::AgentProviderLaunchPlanV1;
use hmux_client::PermissionMode;
use std::path::PathBuf;

#[cfg(windows)]
use hmux_client::TerminalEnvironment;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedWindowsCommand {
    pub(crate) command_path: PathBuf,
    #[cfg(windows)]
    pub(crate) resolved_path: PathBuf,
}

#[cfg(windows)]
pub(crate) fn resolve_windows_command(
    command: &str,
    cwd: &Path,
    terminal_environment: &TerminalEnvironment,
) -> Result<Option<ResolvedWindowsCommand>, crate::provider_preflight::CommandFailure> {
    let where_executable = std::env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32/where.exe");
    let mut lookup = Command::new(where_executable);
    lookup.arg(command).current_dir(cwd);
    apply_terminal_environment(&mut lookup, terminal_environment);
    let output =
        crate::provider_preflight::run_command(&mut lookup, Duration::from_secs(3), 8 * 1024)?;
    if !output.status.success() {
        return Ok(None);
    }
    let command_path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file());
    let Some(command_path) = command_path else {
        return Ok(None);
    };
    let resolved_path = command_path.canonicalize().map_err(|error| {
        crate::provider_preflight::CommandFailure::Failed(format!(
            "resolve Windows provider executable failed: {error}"
        ))
    })?;
    Ok(Some(ResolvedWindowsCommand {
        command_path,
        resolved_path,
    }))
}

#[cfg(windows)]
pub(crate) fn apply_terminal_environment(command: &mut Command, environment: &TerminalEnvironment) {
    for (key, value) in environment.values() {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
}

pub(crate) fn native_managed_command(
    plan: &AgentProviderLaunchPlanV1,
    resolved: &ResolvedWindowsCommand,
) -> Option<Vec<String>> {
    let is_native_executable = resolved
        .command_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
    if !is_native_executable {
        return None;
    }
    let executable = resolved.command_path.to_str()?.to_string();
    let mut command = Vec::with_capacity(plan.arguments.len() + 1);
    command.push(executable);
    command.extend(plan.arguments.iter().cloned());
    Some(command)
}

#[cfg(windows)]
pub(crate) fn windows_command_line(command_line: &str) -> Vec<String> {
    windows_command_line_with(
        std::env::var_os("COMSPEC")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe")),
        command_line,
    )
}

fn windows_command_line_with(command_processor: PathBuf, command_line: &str) -> Vec<String> {
    vec![
        command_processor.to_string_lossy().into_owned(),
        "/D".to_string(),
        "/Q".to_string(),
        "/C".to_string(),
        command_line.to_string(),
    ]
}

#[cfg(windows)]
pub(crate) fn prepare_windows_managed_provider_command(
    provider_id: &str,
    permission_mode: PermissionMode,
    conversation_id: Option<&str>,
    requested_command: &str,
    initial_prompt: Option<&str>,
    cwd: &Path,
    terminal_environment: &TerminalEnvironment,
) -> Result<(Vec<String>, bool), String> {
    let Some((plan, initial_prompt_accepted)) =
        crate::managed_provider_launch::reviewed_create_plan(
            provider_id,
            permission_mode,
            conversation_id,
            requested_command,
            initial_prompt,
        )
    else {
        return Ok((windows_command_line(requested_command), false));
    };
    let resolved = match resolve_windows_command(&plan.executable, cwd, terminal_environment) {
        Ok(Some(command)) => command,
        Ok(None) => {
            return Err(format!(
                "managed provider executable is unavailable: {}",
                plan.executable
            ));
        }
        Err(crate::provider_preflight::CommandFailure::Timeout) => {
            return Err(format!(
                "managed provider executable lookup timed out: {}",
                plan.executable
            ));
        }
        Err(crate::provider_preflight::CommandFailure::Failed(message)) => {
            return Err(format!(
                "managed provider executable lookup failed for {}: {message}",
                plan.executable
            ));
        }
    };
    if provider_id == "codex" {
        let home = dirs::home_dir().ok_or_else(|| {
            "codex_workspace_trust_unavailable: home directory is unavailable".to_string()
        })?;
        match crate::codex_trust::ensure_workspace_trusted(&home, cwd)? {
            crate::codex_trust::CodexWorkspaceTrust::Added
            | crate::codex_trust::CodexWorkspaceTrust::AlreadyTrusted => {}
            crate::codex_trust::CodexWorkspaceTrust::ExistingUntrusted => {
                return Err(
                    "codex_workspace_explicitly_untrusted: trust the workspace before starting Codex Chat"
                        .to_string(),
                );
            }
        }
    }
    Ok(match native_managed_command(&plan, &resolved) {
        Some(command) => (command, initial_prompt_accepted),
        None => (windows_command_line(requested_command), false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(path: &str) -> ResolvedWindowsCommand {
        ResolvedWindowsCommand {
            command_path: PathBuf::from(path),
            #[cfg(windows)]
            resolved_path: PathBuf::from(path),
        }
    }

    #[test]
    fn native_executable_preserves_fresh_and_exact_codex_argv() {
        let fresh_command = crate::managed_provider_launch::fresh_command(
            "codex",
            PermissionMode::BypassApprovals,
        )
        .unwrap();
        let fresh = crate::managed_provider_launch::reviewed_plan_matching_command(
            "codex",
            PermissionMode::BypassApprovals,
            None,
            &fresh_command,
        )
        .unwrap();
        let executable = resolved(r"C:\tools\CoDeX.EXE");
        assert_eq!(
            native_managed_command(&fresh, &executable).unwrap(),
            [
                r"C:\tools\CoDeX.EXE",
                "--dangerously-bypass-approvals-and-sandbox",
                "-c",
                "check_for_update_on_startup=false",
            ]
        );

        let exact_command = crate::managed_provider_launch::exact_command(
            "codex",
            PermissionMode::Default,
            "conversation-1",
        )
        .unwrap();
        let exact = crate::managed_provider_launch::reviewed_plan_matching_command(
            "codex",
            PermissionMode::Default,
            Some("conversation-1"),
            &exact_command,
        )
        .unwrap();
        assert_eq!(
            native_managed_command(&exact, &executable).unwrap(),
            [
                r"C:\tools\CoDeX.EXE",
                "-c",
                "check_for_update_on_startup=false",
                "resume",
                "conversation-1",
            ]
        );
    }

    #[test]
    fn every_reviewed_provider_can_use_a_matching_native_executable() {
        let plan = crate::managed_provider_launch::reviewed_plan_matching_command(
            "claude",
            PermissionMode::BypassApprovals,
            Some("conversation-1"),
            "claude --dangerously-skip-permissions --resume conversation-1",
        )
        .unwrap();
        assert_eq!(
            native_managed_command(&plan, &resolved(r"C:\tools\Claude.exe")).unwrap(),
            [
                r"C:\tools\Claude.exe",
                "--dangerously-skip-permissions",
                "--resume",
                "conversation-1"
            ]
        );
    }

    #[test]
    fn command_shims_are_left_to_the_existing_shell_path() {
        let fresh_command =
            crate::managed_provider_launch::fresh_command("codex", PermissionMode::Default)
                .unwrap();
        let plan = crate::managed_provider_launch::reviewed_plan_matching_command(
            "codex",
            PermissionMode::Default,
            None,
            &fresh_command,
        )
        .unwrap();
        assert!(native_managed_command(&plan, &resolved(r"C:\tools\codex.cmd")).is_none());
    }

    #[test]
    fn shell_command_line_has_one_exact_command_payload() {
        assert_eq!(
            windows_command_line_with(
                PathBuf::from(r"C:\Windows\System32\cmd.exe"),
                "codex resume conversation-1",
            ),
            [
                r"C:\Windows\System32\cmd.exe",
                "/D",
                "/Q",
                "/C",
                "codex resume conversation-1"
            ]
        );
    }
}
