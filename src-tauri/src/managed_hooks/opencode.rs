use super::{shell_quote, write_owner_only_file};
use dure_app::ProviderRuntimeIntegrationV1;
use serde_json::json;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const PLUGIN: &str = include_str!("../../resources/managed-opencode-plugin.mjs");
const RUNTIME_PLACEHOLDER: &str = "\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"";
const PLUGIN_FILE: &str = "managed-opencode-plugin.mjs";
const LAUNCHER_FILE: &str = "managed-opencode-launch.sh";

/// OpenCode merges `OPENCODE_CONFIG_CONTENT` over the person's configuration,
/// so each launch loads the channel's reporter plugin without any provider
/// configuration being written. A value the person set stays theirs: that
/// launch runs without activity reporting rather than losing their settings.
pub(super) fn publish(
    control_dir: &Path,
    runtime: &Path,
) -> std::io::Result<ProviderRuntimeIntegrationV1> {
    if !runtime.is_absolute() {
        return Err(std::io::Error::other(
            "managed OpenCode runtime must be absolute",
        ));
    }
    let plugin = control_dir.join(PLUGIN_FILE);
    let runtime = serde_json::to_string(runtime).map_err(std::io::Error::other)?;
    let contents = PLUGIN.replacen(RUNTIME_PLACEHOLDER, &runtime, 1);
    write_owner_only_file(control_dir, &plugin, contents.as_bytes(), 0o600)?;
    for (name, bytes) in [
        (
            "managed-opencode-state.mjs",
            include_bytes!("../../resources/managed-opencode-state.mjs").as_slice(),
        ),
        (
            "managed-hook-report.mjs",
            include_bytes!("../../resources/managed-hook-report.mjs").as_slice(),
        ),
    ] {
        write_owner_only_file(control_dir, &control_dir.join(name), bytes, 0o600)?;
    }
    let configuration = json!({ "plugin": [file_url(&plugin)] }).to_string();
    let launcher = control_dir.join(LAUNCHER_FILE);
    let script = format!(
        "#!/bin/sh\nset -eu\nprovider=$1\nshift\nif [ -z \"${{OPENCODE_CONFIG_CONTENT:-}}\" ]; then\n  OPENCODE_CONFIG_CONTENT={}\n  export OPENCODE_CONFIG_CONTENT\nfi\nunset DURE_OPENCODE_REPORTER_PID\nexec \"$provider\" \"$@\"\n",
        shell_quote(&configuration),
    );
    write_owner_only_file(control_dir, &launcher, script.as_bytes(), 0o700)?;
    Ok(ProviderRuntimeIntegrationV1::CommandWrapper {
        path: launcher.to_string_lossy().into_owned(),
    })
}

fn file_url(path: &Path) -> String {
    let mut url = String::from("file://");
    for byte in path.as_os_str().as_bytes() {
        match byte {
            b'/' | b'-' | b'_' | b'.' | b'~' | b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' => {
                url.push(char::from(*byte));
            }
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    fn published() -> (tempfile::TempDir, std::path::PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let control = temporary.path().join("channel with 'spaces");
        std::fs::create_dir(&control).unwrap();
        std::fs::set_permissions(&control, std::fs::Permissions::from_mode(0o700)).unwrap();
        publish(&control, Path::new("/fixture/runtime")).unwrap();
        (temporary, control)
    }

    /// Runs the launcher around a provider that prints what it was given.
    fn launch(
        control: &Path,
        configure: impl FnOnce(&mut Command),
    ) -> (Vec<String>, String, String) {
        let provider = control.join("provider probe");
        write_owner_only_file(
            control,
            &provider,
            b"#!/bin/sh\nprintf '%s\\n' \"${OPENCODE_CONFIG_CONTENT:-}\" \"${DURE_OPENCODE_REPORTER_PID:-}\"\nprintf '%s\\n' \"$@\"\n",
            0o700,
        )
        .unwrap();
        let mut command = Command::new(control.join(LAUNCHER_FILE));
        command
            .arg(&provider)
            .args(["--session", "ses_fixture", "--prompt", "'quoted' 한글"])
            .env_remove("OPENCODE_CONFIG_CONTENT")
            .env_remove("DURE_OPENCODE_REPORTER_PID");
        configure(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let mut lines = stdout.lines().map(str::to_string);
        let configuration = lines.next().unwrap();
        let owner = lines.next().unwrap();
        (lines.collect(), configuration, owner)
    }

    #[test]
    fn published_files_are_private_and_the_plugin_targets_this_runtime() {
        let (_temporary, control) = published();
        let plugin = std::fs::read_to_string(control.join(PLUGIN_FILE)).unwrap();
        assert!(plugin.contains("const runtime = \"/fixture/runtime\";"));
        assert!(!plugin.contains(RUNTIME_PLACEHOLDER));
        for (file, mode) in [
            (PLUGIN_FILE, 0o600),
            ("managed-opencode-state.mjs", 0o600),
            ("managed-hook-report.mjs", 0o600),
            (LAUNCHER_FILE, 0o700),
        ] {
            let metadata = std::fs::metadata(control.join(file)).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o777, mode, "{file}");
        }
    }

    #[test]
    fn launch_adds_only_the_channel_plugin_and_forgets_an_inherited_reporter() {
        let (_temporary, control) = published();
        let (arguments, configuration, owner) = launch(&control, |command| {
            command.env("DURE_OPENCODE_REPORTER_PID", "1");
        });
        assert_eq!(
            arguments,
            ["--session", "ses_fixture", "--prompt", "'quoted' 한글"]
        );
        assert_eq!(owner, "");
        let configuration: Value = serde_json::from_str(&configuration).unwrap();
        let expected = format!(
            "file://{}/channel%20with%20%27spaces/{PLUGIN_FILE}",
            control.parent().unwrap().display()
        );
        assert_eq!(configuration, json!({ "plugin": [expected] }));
    }

    #[test]
    fn launch_leaves_a_configuration_the_person_set() {
        let (_temporary, control) = published();
        let (_, configuration, _) = launch(&control, |command| {
            command.env("OPENCODE_CONFIG_CONTENT", "{\"model\":\"mine\"}");
        });
        assert_eq!(configuration, "{\"model\":\"mine\"}");
    }
}
