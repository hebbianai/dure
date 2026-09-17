//! Bounded one-shot headless naming call for quick-dispatch worktrees.
//!
//! This is the only headless provider execution in production: no tools
//! (codex `--sandbox read-only`, claude `--tools ""`), a 6s timeout, a 4KiB
//! output cap, and the prompt truncated to 2000 chars. The frontend
//! orchestrator (`suggestQuickDispatchName`) treats any failure here as
//! non-fatal and falls back to a deterministic name.

use hmux_client::TerminalEnvironment;
use std::path::Path;
use std::time::Duration;

const NAMING_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_NAMING_OUTPUT: usize = 4 * 1024;
const MAX_NAMING_PROMPT_CHARS: usize = 2000;
const NAMING_INSTRUCTION: &str = "Output only a 3-4 word kebab-case name (lowercase ascii letters, digits, hyphens) for this coding task. One line, no explanation, no quotes.\n\nTask:\n";

/// Headless one-shot argv per provider. Naming is the only headless provider
/// execution in production; it is deliberately narrow (no tools, bounded).
///
/// Both bundled providers are pinned to a real read-only/no-tool bound
/// (verified against `codex exec --help` / `claude --help`), not merely the
/// bounded timeout + process-group kill the frontend orchestrator already
/// enforces:
/// - codex: `exec --sandbox read-only` — the documented codex sandbox policy.
/// - claude: `--tools ""` — the documented "disable all tools" value for
///   `--tools` (`claude --help`: `Use "" to disable all tools`); `-p` already
///   makes the call non-interactive/print-mode.
pub(crate) fn naming_command(provider_id: &str, prompt: &str) -> Option<(String, Vec<String>)> {
    let truncated: String = prompt.chars().take(MAX_NAMING_PROMPT_CHARS).collect();
    let instruction = format!("{NAMING_INSTRUCTION}{truncated}");
    match provider_id {
        "claude" => Some((
            "claude".to_string(),
            vec![
                "-p".to_string(),
                "--tools".to_string(),
                String::new(),
                instruction,
            ],
        )),
        "codex" => Some((
            "codex".to_string(),
            vec![
                "exec".to_string(),
                "--sandbox".to_string(),
                "read-only".to_string(),
                instruction,
            ],
        )),
        _ => None,
    }
}

#[tauri::command]
pub(crate) async fn agent_name_suggestion(
    provider_id: String,
    prompt: String,
    cwd: String,
) -> Result<String, String> {
    let (program, arguments) =
        naming_command(&provider_id, &prompt).ok_or("agent_naming_provider_unsupported")?;
    tauri::async_runtime::spawn_blocking(move || {
        // Mirror codex_usage_collector.rs: resolve the login-shell environment,
        // then run env-cleared with the resolved PATH/environment.
        let resolved = crate::provider_preflight::resolve_login_command_environment(
            &program,
            Path::new(&cwd),
            TerminalEnvironment::default(),
        )?;
        let mut command = std::process::Command::new(&resolved.executable);
        command
            .args(&arguments)
            .current_dir(&cwd)
            .env_clear()
            .envs(&resolved.environment);
        let output = crate::provider_preflight::run_command(
            &mut command,
            NAMING_TIMEOUT,
            MAX_NAMING_OUTPUT,
        )
        .map_err(|failure| format!("agent_naming_failed: {failure:?}"))?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|error| format!("agent naming task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::naming_command;

    #[test]
    fn maps_bundled_providers_and_rejects_others() {
        let (program, args) = naming_command("claude", "fix it").unwrap();
        assert_eq!(program, "claude");
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "--tools");
        assert_eq!(args[2], "", "empty --tools value disables all tools");
        let (program, args) = naming_command("codex", "fix it").unwrap();
        assert_eq!(program, "codex");
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "--sandbox");
        assert_eq!(args[2], "read-only");
        assert!(naming_command("gemini", "fix it").is_none());
    }

    #[test]
    fn truncates_oversized_prompts() {
        let long = "x".repeat(10_000);
        let (_, args) = naming_command("claude", &long).unwrap();
        assert!(args.last().unwrap().chars().count() < 2200);
        let (_, args) = naming_command("codex", &long).unwrap();
        assert!(args.last().unwrap().chars().count() < 2200);
    }
}
