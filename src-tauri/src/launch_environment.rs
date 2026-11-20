//! The app's own process environment, cleaned once at startup.
//!
//! The Hub, Hosts, agents, helper processes and the updater's relaunch all
//! inherit this process's environment. A launch from inside a Dure terminal or
//! an agent's tool shell (`open -a Dure`) carries variables that describe that
//! terminal, not the app. Removing them before anything else runs makes such a
//! launch behave like one from the Dock, and an update relaunch starts clean.

use dure_app::provider_credential_state_roots_v1;
use hmux_client::MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV;
use hmux_runtime_contract::{
    is_launching_client_session_env_key, HMUX_CHANNEL_EPOCH_ENV, HMUX_ENV,
    HMUX_HOST_INSTANCE_ID_ENV, HMUX_RUNNER_INSTANCE_ENV, HMUX_RUNNER_PRINCIPAL_ENV,
    HMUX_SESSION_ID_ENV, HMUX_SESSION_NAME_ENV, HMUX_TERMINAL_EPOCH_ENV, HMUX_WORKSPACE_ID_ENV,
};

/// What a Host gives each terminal it spawns. The app is never a terminal, so
/// these always describe the terminal it was started from. Configuration such
/// as `HMUX_DISCOVERY_ROOT` is not identity and stays.
const TERMINAL_IDENTITY_KEYS: &[&str] = &[
    HMUX_ENV,
    HMUX_SESSION_ID_ENV,
    HMUX_SESSION_NAME_ENV,
    HMUX_WORKSPACE_ID_ENV,
    HMUX_RUNNER_PRINCIPAL_ENV,
    HMUX_RUNNER_INSTANCE_ENV,
    HMUX_CHANNEL_EPOCH_ENV,
    HMUX_HOST_INSTANCE_ID_ENV,
    HMUX_TERMINAL_EPOCH_ENV,
    MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV,
];

/// An agent tool shell sets these for its own output (`FORCE_COLOR=0`).
const COLOR_SWITCH_KEYS: &[&str] = &["FORCE_COLOR", "NO_COLOR"];

/// Select the inherited keys to remove, keeping each key's spelling.
///
/// Terminal identity and agent session markers always go. Either one means the
/// app was started from a terminal, so that terminal's provider state roots
/// (its account) and color switches go too. A launch from the Dock or Finder
/// carries no marker and keeps user-level values of those keys.
pub(crate) fn terminal_scoped_keys<I, S>(present_keys: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let keys = present_keys
        .into_iter()
        .map(|key| key.as_ref().to_owned())
        .collect::<Vec<_>>();
    let marker = |key: &str| {
        is_one_of(key, TERMINAL_IDENTITY_KEYS.iter().copied())
            || is_launching_client_session_env_key(key)
    };
    let launched_from_terminal = keys.iter().any(|key| marker(key));
    keys.into_iter()
        .filter(|key| {
            marker(key)
                || (launched_from_terminal
                    && (is_one_of(key, COLOR_SWITCH_KEYS.iter().copied())
                        || is_one_of(key, provider_credential_state_roots_v1())))
        })
        .collect()
}

/// Remove the terminal-scoped variables this process inherited. Call first in
/// the app's entry point, before any thread reads the environment.
pub(crate) fn remove_terminal_scoped_variables() {
    let keys =
        terminal_scoped_keys(std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()));
    if keys.is_empty() {
        return;
    }
    for key in &keys {
        std::env::remove_var(key);
    }
    // Names only: values can hold account locations.
    eprintln!(
        "[app-startup] launch_environment_cleaned: {}",
        keys.join(",")
    );
}

fn is_one_of<'a>(key: &str, candidates: impl IntoIterator<Item = &'a str>) -> bool {
    candidates.into_iter().any(|candidate| {
        if cfg!(windows) {
            key.eq_ignore_ascii_case(candidate)
        } else {
            key == candidate
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANE: &[&str] = &[
        "HMUX",
        "HMUX_SESSION_ID",
        "HMUX_SESSION_NAME",
        "HMUX_WORKSPACE_ID",
        "HMUX_RUNNER_PRINCIPAL",
        "HMUX_RUNNER_INSTANCE",
        "HMUX_CHANNEL_EPOCH",
        "HMUX_HOST_INSTANCE_ID",
        "HMUX_TERMINAL_EPOCH",
        "HMUX_MANAGED_REHOST_SOURCE_DISCOVERY_ROOT",
    ];
    const AGENT_SHELL: &[&str] = &[
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CODEX_THREAD_ID",
    ];
    const ACCOUNT_AND_COLOR: &[&str] = &[
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_CONFIG_DIR",
        "CODEX_HOME",
        "CODEX_SQLITE_HOME",
        "KIMI_CODE_HOME",
        "FORCE_COLOR",
        "NO_COLOR",
    ];
    /// App configuration that QA runners and users set on purpose.
    const KEPT: &[&str] = &[
        "HOME",
        "PATH",
        "DURE_HOME",
        "DURE_APP_CHANNEL",
        "HMUX_DISCOVERY_ROOT",
        "TERM",
        "COLORTERM",
        "CLICOLOR",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "OPENAI_API_KEY",
    ];

    fn environment(groups: &[&[&str]]) -> Vec<String> {
        groups.concat().into_iter().map(String::from).collect()
    }

    #[test]
    fn a_launch_from_a_dure_terminal_drops_that_terminal_s_variables() {
        let removed =
            terminal_scoped_keys(environment(&[KEPT, PANE, AGENT_SHELL, ACCOUNT_AND_COLOR]));
        assert_eq!(
            removed,
            environment(&[PANE, AGENT_SHELL, ACCOUNT_AND_COLOR])
        );
    }

    #[test]
    fn pane_identity_alone_marks_a_terminal_launch() {
        let removed = terminal_scoped_keys(environment(&[KEPT, PANE, ACCOUNT_AND_COLOR]));
        assert_eq!(removed, environment(&[PANE, ACCOUNT_AND_COLOR]));
    }

    #[test]
    fn an_agent_tool_shell_outside_dure_marks_a_terminal_launch() {
        let removed = terminal_scoped_keys(environment(&[KEPT, AGENT_SHELL, ACCOUNT_AND_COLOR]));
        assert_eq!(removed, environment(&[AGENT_SHELL, ACCOUNT_AND_COLOR]));
    }

    #[test]
    fn a_dock_launch_keeps_user_level_account_and_color_settings() {
        assert!(terminal_scoped_keys(environment(&[KEPT, ACCOUNT_AND_COLOR])).is_empty());
    }

    #[test]
    fn keys_follow_the_platform_case_rules_and_keep_their_spelling() {
        let removed = terminal_scoped_keys(["hmux_session_id", "claude_config_dir", "PATH"]);
        if cfg!(windows) {
            assert_eq!(removed, ["hmux_session_id", "claude_config_dir"]);
        } else {
            assert!(removed.is_empty());
        }
    }

    const PROBE_OUTPUT: &str = "DURE_TEST_LAUNCH_ENVIRONMENT_PROBE_OUTPUT";

    /// Runs as the stand-in app process: clean, then record what a process it
    /// starts receives.
    #[cfg(unix)]
    #[test]
    fn launch_environment_probe() {
        let Some(output) = std::env::var_os(PROBE_OUTPUT) else {
            return;
        };
        remove_terminal_scoped_variables();
        let started = std::process::Command::new("/usr/bin/env").output().unwrap();
        assert!(started.status.success());
        std::fs::write(output, started.stdout).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn processes_the_app_starts_no_longer_inherit_the_launching_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("started-environment");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "launch_environment::tests::launch_environment_probe",
                "--test-threads=1",
            ])
            .env_clear()
            .envs([
                ("PATH", "/usr/bin:/bin"),
                ("HOME", "/fixture/home"),
                ("HMUX_DISCOVERY_ROOT", "/fixture/discovery"),
                ("HMUX", "1"),
                ("HMUX_SESSION_ID", "fixture-pane"),
                ("CLAUDECODE", "1"),
                ("CLAUDE_CONFIG_DIR", "/fixture/accounts/claude-pane"),
                ("FORCE_COLOR", "0"),
            ])
            .env(PROBE_OUTPUT, &output)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());

        let started = std::fs::read_to_string(output).unwrap();
        let keys = started
            .lines()
            .filter_map(|line| line.split_once('=').map(|(key, _)| key))
            .collect::<std::collections::BTreeSet<_>>();
        for removed in [
            "HMUX",
            "HMUX_SESSION_ID",
            "CLAUDECODE",
            "CLAUDE_CONFIG_DIR",
            "FORCE_COLOR",
        ] {
            assert!(
                !keys.contains(removed),
                "{removed} reached a started process"
            );
        }
        for kept in ["PATH", "HOME", "HMUX_DISCOVERY_ROOT"] {
            assert!(keys.contains(kept), "{kept} was lost");
        }
    }
}
