use super::{shell_quote, write_owner_only_file};
use dure_app::ProviderRuntimeIntegrationV1;
use serde_json::json;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const PLUGIN: &str = include_str!("../../resources/managed-opencode-plugin.mjs");
const RUNTIME_PLACEHOLDER: &str = "\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"";
const PLUGIN_FILE: &str = "managed-opencode-plugin.mjs";

/// A provider that loads the channel's OpenCode reporter plugin through its
/// own inline configuration variable.
pub(super) struct InlineConfigurationLaunch {
    variable: &'static str,
    launcher: &'static str,
}

pub(super) const OPENCODE: InlineConfigurationLaunch = InlineConfigurationLaunch {
    variable: "OPENCODE_CONFIG_CONTENT",
    launcher: "managed-opencode-launch.sh",
};

/// Kilo Code is built on OpenCode and keeps its plugin events and inline
/// configuration under its own variable.
pub(super) const KILO: InlineConfigurationLaunch = InlineConfigurationLaunch {
    variable: "KILO_CONFIG_CONTENT",
    launcher: "managed-kilo-launch.sh",
};

/// The provider merges its inline configuration over the person's, so each
/// launch loads the channel's reporter plugin without any provider
/// configuration being written. A value the person set stays theirs: that
/// launch runs without activity reporting rather than losing their settings.
pub(super) fn publish(
    control_dir: &Path,
    runtime: &Path,
    launch: &InlineConfigurationLaunch,
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
    let launcher = control_dir.join(launch.launcher);
    let script = format!(
        "#!/bin/sh\nset -eu\nprovider=$1\nshift\nif [ -z \"${{{variable}:-}}\" ]; then\n  {variable}={}\n  export {variable}\nfi\nunset DURE_OPENCODE_REPORTER_PID\nexec \"$provider\" \"$@\"\n",
        shell_quote(&configuration),
        variable = launch.variable,
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
    use super::super::integrations::inject_command_wrapper;
    use super::*;
    use dure_app::{ProviderIdV1, PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1};
    use serde_json::Value;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    const LAUNCHES: [&InlineConfigurationLaunch; 2] = [&OPENCODE, &KILO];

    /// Publishes both launchers into one channel, as the app does.
    fn published() -> (tempfile::TempDir, std::path::PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let control = temporary.path().join("channel with 'spaces");
        std::fs::create_dir(&control).unwrap();
        std::fs::set_permissions(&control, std::fs::Permissions::from_mode(0o700)).unwrap();
        for launch in LAUNCHES {
            publish(&control, Path::new("/fixture/runtime"), launch).unwrap();
        }
        (temporary, control)
    }

    struct Launched {
        arguments: Vec<String>,
        configuration: String,
        other_configuration: String,
        owner: String,
    }

    /// Runs a launcher around a provider that prints what it was given.
    fn launch(
        control: &Path,
        launch: &InlineConfigurationLaunch,
        configure: impl FnOnce(&mut Command),
    ) -> Launched {
        let provider = control.join("provider probe");
        write_owner_only_file(
            control,
            &provider,
            b"#!/bin/sh\nprintf '%s\\n' \"${OPENCODE_CONFIG_CONTENT:-}\" \"${KILO_CONFIG_CONTENT:-}\" \"${DURE_OPENCODE_REPORTER_PID:-}\"\nprintf '%s\\n' \"$@\"\n",
            0o700,
        )
        .unwrap();
        let mut command = Command::new(control.join(launch.launcher));
        command
            .arg(&provider)
            .args(["--session", "ses_fixture", "--prompt", "'quoted' 한글"])
            .env_remove("DURE_OPENCODE_REPORTER_PID");
        for other in LAUNCHES {
            command.env_remove(other.variable);
        }
        configure(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let mut lines = stdout.lines().map(str::to_string);
        let opencode = lines.next().unwrap();
        let kilo = lines.next().unwrap();
        let owner = lines.next().unwrap();
        let (configuration, other_configuration) = if launch.variable == KILO.variable {
            (kilo, opencode)
        } else {
            (opencode, kilo)
        };
        Launched {
            arguments: lines.collect(),
            configuration,
            other_configuration,
            owner,
        }
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
            (OPENCODE.launcher, 0o700),
            (KILO.launcher, 0o700),
        ] {
            let metadata = std::fs::metadata(control.join(file)).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o777, mode, "{file}");
        }
    }

    #[test]
    fn launch_adds_only_the_channel_plugin_and_forgets_an_inherited_reporter() {
        let (_temporary, control) = published();
        let expected = format!(
            "file://{}/channel%20with%20%27spaces/{PLUGIN_FILE}",
            control.parent().unwrap().display()
        );
        for provider in LAUNCHES {
            let launched = launch(&control, provider, |command| {
                command.env("DURE_OPENCODE_REPORTER_PID", "1");
            });
            assert_eq!(
                launched.arguments,
                ["--session", "ses_fixture", "--prompt", "'quoted' 한글"],
                "{}",
                provider.launcher
            );
            assert_eq!(launched.owner, "", "{}", provider.launcher);
            let configuration: Value = serde_json::from_str(&launched.configuration).unwrap();
            assert_eq!(configuration, json!({ "plugin": [expected] }));
            // Each launcher configures only its own provider.
            assert_eq!(launched.other_configuration, "", "{}", provider.launcher);
        }
    }

    #[test]
    fn kilo_launches_carry_the_reporter_on_both_launch_paths() {
        let (temporary, control) = published();
        let integration = publish(&control, Path::new("/fixture/runtime"), &KILO).unwrap();
        let provider = ProviderIdV1::new("kilocode").unwrap();
        let document = super::super::integrations::provider_runtime_integrations_document(
            "qa-kilo",
            None,
            None,
            std::collections::BTreeMap::from([(provider.clone(), integration.clone())]),
        )
        .unwrap();
        write_owner_only_file(
            &control,
            &control.join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1),
            &serde_json::to_vec(&document).unwrap(),
            0o600,
        )
        .unwrap();
        let channel = crate::app_channel::AppChannel {
            name: "qa-kilo".into(),
            app_root: temporary.path().into(),
            control_dir: control.clone(),
        };
        let probe = control.join("provider probe");
        write_owner_only_file(
            &control,
            &probe,
            b"#!/bin/sh\nprintf '%s\\0' \"${KILO_CONFIG_CONTENT:-}\" \"$@\"\n",
            0o700,
        )
        .unwrap();
        let original = ["--session", "ses_fixture", "--model", "fixture/model b"];
        let command = format!(
            "{} {}",
            shell_quote(&probe.to_string_lossy()),
            original.map(shell_quote).join(" ")
        );
        // Desktop panes wrap the rendered command; `dure run` and rehost wrap
        // the launch plan.
        let injected = inject_command_wrapper("kilocode", &command, &channel).unwrap();
        let mut plan = dure_app::AgentProviderLaunchPlanV1 {
            executable: probe.to_string_lossy().into_owned(),
            arguments: original.map(str::to_string).to_vec(),
        };
        dure_provider_adapter::apply_provider_runtime_integration(
            &provider,
            &integration,
            &mut plan,
        )
        .unwrap();
        let expected = json!({ "plugin": [file_url(&control.join(PLUGIN_FILE))] }).to_string();
        for mut command in [
            {
                let mut shell = Command::new("/bin/sh");
                shell.args(["-c", &injected]);
                shell
            },
            {
                let mut direct = Command::new(&plan.executable);
                direct.args(&plan.arguments);
                direct
            },
        ] {
            let output = command.env_remove(KILO.variable).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let values: Vec<_> = output
                .stdout
                .split(|byte| *byte == 0)
                .filter(|value| !value.is_empty())
                .map(|value| String::from_utf8(value.to_vec()).unwrap())
                .collect();
            assert_eq!(values[0], expected);
            assert_eq!(values[1..], original);
        }
        assert!(inject_command_wrapper("opencode", &command, &channel).is_err());
    }

    #[test]
    fn launch_leaves_a_configuration_the_person_set() {
        let (_temporary, control) = published();
        for provider in LAUNCHES {
            let launched = launch(&control, provider, |command| {
                command.env(provider.variable, "{\"model\":\"mine\"}");
            });
            assert_eq!(launched.configuration, "{\"model\":\"mine\"}");
        }
    }
}
