//! Render hook payloads after the caller has resolved execution-side paths.
//! Local and remote adapters own path semantics; rendering only serializes text.

use serde_json::{json, Value};

pub(crate) const MANAGED_PROVIDER_HOOK_SCRIPT: &[u8] =
    include_bytes!("../resources/managed-claude-hook.py");
const HMUX_RUNTIME_PLACEHOLDER: &str = "\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"";

pub(crate) const CODEX_USER_NOTIFY_WRAPPER_TEMPLATE: &str =
    "#!/bin/sh\n# Dure managed Codex user notify chain — content addressed\nexec __DURE_NOTIFY_ARGV__ \"$@\"\n";

pub(crate) fn render_codex_user_notify_wrapper(chain: &[String]) -> String {
    let argv = chain
        .iter()
        .map(|entry| crate::ssh::shell_quote(entry))
        .collect::<Vec<_>>()
        .join(" ");
    CODEX_USER_NOTIFY_WRAPPER_TEMPLATE.replacen("__DURE_NOTIFY_ARGV__", &argv, 1)
}

pub(crate) fn claude_settings(script_command: &str) -> Value {
    let hook_group = || json!([{ "hooks": [{
        "type": "command",
        "command": script_command,
        "args": ["claude", "--managed-direct", "--terminal-events"],
        "timeout": 3,
    }] }]);
    json!({
        "hooks": {
            "SessionStart": hook_group(),
            "UserPromptSubmit": hook_group(),
            "PreToolUse": hook_group(),
            "Stop": hook_group(),
            "Notification": hook_group(),
        },
    })
}

pub(crate) fn render_managed_provider_hook_script(
    runtime_executable: &str,
) -> std::io::Result<Vec<u8>> {
    let source =
        std::str::from_utf8(MANAGED_PROVIDER_HOOK_SCRIPT).map_err(std::io::Error::other)?;
    if source.matches(HMUX_RUNTIME_PLACEHOLDER).count() != 1 {
        return Err(std::io::Error::other(
            "managed provider hook runtime placeholder is invalid",
        ));
    }
    let runtime = serde_json::to_string(runtime_executable).map_err(std::io::Error::other)?;
    Ok(source
        .replacen(HMUX_RUNTIME_PLACEHOLDER, &runtime, 1)
        .into_bytes())
}
