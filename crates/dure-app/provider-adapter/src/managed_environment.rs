//! Dure-owned process routing, independent of the Hmux broker's environment.
//! Provider authentication, user tool configuration and isolation roots survive.

use std::path::Path;

/// Ambient launcher/build state must not select a different app or runtime in
/// the provider's descendants. The caller binds DURE_APP_CHANNEL explicitly.
pub const INHERITED_LAUNCH_KEYS: &[&str] = &[
    "DURE_APP_CHANNEL",
    "HEBBIAN_APP_CHANNEL",
    "DURE_HMUX_BIN",
    "HEBBIAN_HMUX_BIN",
    "DURE_HMUX_RUNTIME_BIN",
    "HMUX_RUNTIME",
    "HEBBIAN_HMUX_RUNTIME",
    "DURE_BUILD_ID",
    "DURE_DEV_LAUNCH_GENERATION",
    "DURE_BACKEND_RUNTIME_FINGERPRINT",
    "HMUX_INSTALL_DIR",
    "HMUX_INSTALL_ROOT",
    "HMUX_INSTALL_LOCK_WAIT_SECONDS",
    "TAURI_CONFIG",
    "INIT_CWD",
    "OUT_DIR",
    "CARGO_MANIFEST_DIR",
    "CARGO_MANIFEST_PATH",
    "CARGO_PKG_NAME",
    "CARGO_PKG_VERSION",
    "CARGO_PKG_VERSION_MAJOR",
    "CARGO_PKG_VERSION_MINOR",
    "CARGO_PKG_VERSION_PATCH",
    "CARGO_PKG_VERSION_PRE",
    "CARGO_CRATE_NAME",
    "CARGO_PRIMARY_PACKAGE",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_package_json",
    "npm_package_name",
    "npm_package_version",
    "npm_execpath",
    "npm_node_execpath",
];

/// `$0` of every Dure launch wrapper layer, which also names it in process lists.
const WRAPPER_NAME: &str = "dure-managed-environment";
/// Prepends the installed CLI version's agent command directory, when one is
/// given, to PATH.
const COMMAND_PATH_SCRIPT: &str =
    "if [ -n \"$1\" ]; then PATH=\"$1:${PATH:-}\"; export PATH; fi; shift; exec \"$@\"";
/// The fixed end of the environment layer. Its `unset` list grows between
/// releases, so a recorded launch is recognized by this tail alone.
const ENVIRONMENT_SCRIPT_TAIL: &str = "; export DURE_APP_CHANNEL=\"$1\"; shift; exec \"$@\"";

/// Unix desktop/control-plane adapters use the same argv prefix. No provider
/// credentials or caller-provided strings are interpolated into shell source.
pub fn unix_managed_environment_prefix(channel: &str) -> Vec<String> {
    wrapper_layer(
        format!(
            "unset {}{ENVIRONMENT_SCRIPT_TAIL}",
            INHERITED_LAUNCH_KEYS.join(" ")
        ),
        channel,
    )
}

/// The argv a Unix control-plane launch puts before its provider program: the
/// agent command PATH layer, then [`unix_managed_environment_prefix`].
pub fn unix_managed_launch_prefix(channel: &str, command_directory: Option<&Path>) -> Vec<String> {
    let directory = command_directory
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut prefix = wrapper_layer(COMMAND_PATH_SCRIPT.into(), &directory);
    prefix.extend(unix_managed_environment_prefix(channel));
    prefix
}

/// The program a recorded launch finally executes: argv[0] once the layers of
/// [`unix_managed_launch_prefix`] are removed. A command without those layers
/// executes its own argv[0].
pub fn unix_managed_launch_program(command: &[String]) -> Option<&str> {
    let mut command = command;
    if let Some(rest) = strip_wrapper_layer(command, |script| script == COMMAND_PATH_SCRIPT) {
        command = rest;
    }
    if let Some(rest) = strip_wrapper_layer(command, |script| {
        script.starts_with("unset ") && script.ends_with(ENVIRONMENT_SCRIPT_TAIL)
    }) {
        command = rest;
    }
    command.first().map(String::as_str)
}

fn wrapper_layer(script: String, argument: &str) -> Vec<String> {
    vec![
        "/bin/sh".into(),
        "-c".into(),
        script,
        WRAPPER_NAME.into(),
        argument.into(),
    ]
}

fn strip_wrapper_layer(command: &[String], script: impl Fn(&str) -> bool) -> Option<&[String]> {
    match command {
        [shell, flag, body, name, _argument, rest @ ..]
            if shell == "/bin/sh" && flag == "-c" && name == WRAPPER_NAME && script(body) =>
        {
            Some(rest)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn a_wrapped_launch_names_the_provider_program_after_its_layers() {
        let mut command =
            unix_managed_launch_prefix("stable", Some(Path::new("/cli/versions/0.2.70/commands")));
        command.extend(strings(&["/opt/homebrew/bin/claude", "--resume", "id"]));
        assert_eq!(
            unix_managed_launch_program(&command),
            Some("/opt/homebrew/bin/claude")
        );

        let mut without_directory = unix_managed_launch_prefix("stable", None);
        without_directory.push("/usr/local/bin/codex".into());
        assert_eq!(
            unix_managed_launch_program(&without_directory),
            Some("/usr/local/bin/codex")
        );
    }

    #[test]
    fn a_recorded_launch_with_an_older_unset_list_is_still_recognized() {
        // The shape of a rehost recipe recorded by 0.2.68, with a shorter
        // `unset` list than this release builds.
        let recorded = strings(&[
            "/bin/sh",
            "-c",
            "if [ -n \"$1\" ]; then PATH=\"$1:${PATH:-}\"; export PATH; fi; shift; exec \"$@\"",
            "dure-managed-environment",
            "/cli/versions/0.2.68/commands",
            "/bin/sh",
            "-c",
            "unset DURE_APP_CHANNEL HEBBIAN_APP_CHANNEL; export DURE_APP_CHANNEL=\"$1\"; shift; exec \"$@\"",
            "dure-managed-environment",
            "stable",
            "/opt/homebrew/Caskroom/claude-code@latest/2.1.325/claude",
            "--dangerously-skip-permissions",
            "--resume",
            "__HMUX_EXACT_CONVERSATION_ID__",
        ]);
        assert_eq!(
            unix_managed_launch_program(&recorded),
            Some("/opt/homebrew/Caskroom/claude-code@latest/2.1.325/claude")
        );
    }

    #[test]
    fn other_commands_execute_their_own_first_argument() {
        assert_eq!(
            unix_managed_launch_program(&strings(&["/usr/local/bin/codex", "resume"])),
            Some("/usr/local/bin/codex")
        );
        // A shell running some other script is not a Dure wrapper layer.
        let foreign = strings(&[
            "/bin/sh",
            "-c",
            "exec \"$@\"",
            "dure-managed-environment",
            "x",
            "/opt/provider",
        ]);
        assert_eq!(unix_managed_launch_program(&foreign), Some("/bin/sh"));
        assert_eq!(unix_managed_launch_program(&[]), None);
    }
}
