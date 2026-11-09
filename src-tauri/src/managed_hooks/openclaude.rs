use super::{shell_quote, write_owner_only_file};
use dure_app::ProviderRuntimeIntegrationV1;
use serde_json::{json, Map, Value};
use std::path::Path;

const HOOK: &str = include_str!("../../resources/managed-openclaude-hook.mjs");
const RUNTIME_PLACEHOLDER: &str = "\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"";
const HOOK_FILE: &str = "managed-openclaude-hook.mjs";
const SETTINGS_FILE: &str = "managed-openclaude-settings.json";
const LAUNCHER_FILE: &str = "managed-openclaude-launch.sh";
/// The Claude-compatible lifecycle events that move an agent between
/// working, waiting for the person and idle.
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

/// OpenClaude reads hooks from an extra `--settings` file and merges them with
/// the person's own settings, so each launch gets the channel's reporter
/// without any provider configuration being rewritten.
pub(super) fn publish(
    control_dir: &Path,
    runtime: &Path,
) -> std::io::Result<ProviderRuntimeIntegrationV1> {
    if !runtime.is_absolute() {
        return Err(std::io::Error::other(
            "managed OpenClaude runtime must be absolute",
        ));
    }
    let hook = control_dir.join(HOOK_FILE);
    let runtime = serde_json::to_string(runtime).map_err(std::io::Error::other)?;
    let contents = HOOK.replacen(RUNTIME_PLACEHOLDER, &runtime, 1);
    write_owner_only_file(control_dir, &hook, contents.as_bytes(), 0o600)?;
    write_owner_only_file(
        control_dir,
        &control_dir.join("managed-hook-report.mjs"),
        include_bytes!("../../resources/managed-hook-report.mjs"),
        0o600,
    )?;
    let settings = control_dir.join(SETTINGS_FILE);
    write_owner_only_file(control_dir, &settings, &settings_document(&hook)?, 0o600)?;
    let launcher = control_dir.join(LAUNCHER_FILE);
    let script = format!(
        "#!/bin/sh\nset -eu\nprovider=$1\nshift\nexec \"$provider\" --settings {} \"$@\"\n",
        shell_quote(&settings.to_string_lossy()),
    );
    write_owner_only_file(control_dir, &launcher, script.as_bytes(), 0o700)?;
    Ok(ProviderRuntimeIntegrationV1::CommandWrapper {
        path: launcher.to_string_lossy().into_owned(),
    })
}

fn settings_document(hook: &Path) -> std::io::Result<Vec<u8>> {
    let command = format!("node {}", shell_quote(&hook.to_string_lossy()));
    let hooks: Map<String, Value> = EVENTS
        .iter()
        .map(|event| {
            (
                (*event).to_string(),
                json!([{ "hooks": [{ "type": "command", "command": command, "timeout": 3 }] }]),
            )
        })
        .collect();
    let mut contents =
        serde_json::to_vec_pretty(&json!({ "hooks": hooks })).map_err(std::io::Error::other)?;
    contents.push(b'\n');
    Ok(contents)
}

#[cfg(test)]
mod tests {
    use super::super::integrations::inject_command_wrapper;
    use super::*;
    use dure_app::{ProviderIdV1, PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn published_openclaude_launch_adds_only_the_channel_settings() {
        let temporary = tempfile::tempdir().unwrap();
        let control = temporary.path().join("channel with 'spaces");
        std::fs::create_dir(&control).unwrap();
        std::fs::set_permissions(&control, std::fs::Permissions::from_mode(0o700)).unwrap();
        let integration = publish(&control, Path::new("/fixture/runtime")).unwrap();

        let hook = std::fs::read_to_string(control.join(HOOK_FILE)).unwrap();
        assert!(hook.contains("const runtime = \"/fixture/runtime\";"));
        assert!(!hook.contains(RUNTIME_PLACEHOLDER));
        let settings: Value =
            serde_json::from_slice(&std::fs::read(control.join(SETTINGS_FILE)).unwrap()).unwrap();
        let hooks = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), EVENTS.len());
        for event in EVENTS {
            let command = hooks[*event][0]["hooks"][0]["command"].as_str().unwrap();
            let quoted = shell_quote(&control.join(HOOK_FILE).to_string_lossy());
            assert_eq!(command, format!("node {quoted}"));
        }
        for (file, mode) in [
            (HOOK_FILE, 0o600),
            (SETTINGS_FILE, 0o600),
            ("managed-hook-report.mjs", 0o600),
            (LAUNCHER_FILE, 0o700),
        ] {
            let metadata = std::fs::metadata(control.join(file)).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o777, mode, "{file}");
        }

        let document = super::super::integrations::provider_runtime_integrations_document(
            "qa-openclaude",
            None,
            None,
            std::collections::BTreeMap::from([(
                ProviderIdV1::new("openclaude").unwrap(),
                integration.clone(),
            )]),
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
            name: "qa-openclaude".into(),
            app_root: temporary.path().into(),
            control_dir: control.clone(),
        };
        let probe = control.join("provider probe");
        write_owner_only_file(
            &control,
            &probe,
            b"#!/bin/sh\nprintf '%s\\0' \"$@\"\n",
            0o700,
        )
        .unwrap();
        let original = [
            "--resume".to_string(),
            "exact-id".to_string(),
            "--".to_string(),
            "\nReview 'quoted'\n한글".to_string(),
        ];
        let command = format!(
            "{} {}",
            shell_quote(&probe.to_string_lossy()),
            original
                .iter()
                .map(|argument| shell_quote(argument))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let injected = inject_command_wrapper("openclaude", &command, &channel).unwrap();
        let mut plan = dure_app::AgentProviderLaunchPlanV1 {
            executable: probe.to_string_lossy().into_owned(),
            arguments: original.to_vec(),
        };
        dure_provider_adapter::apply_provider_runtime_integration(
            &ProviderIdV1::new("openclaude").unwrap(),
            &integration,
            &mut plan,
        )
        .unwrap();
        let settings_path = control.join(SETTINGS_FILE).to_string_lossy().into_owned();
        let expected: Vec<String> = ["--settings".to_string(), settings_path]
            .into_iter()
            .chain(original.iter().cloned())
            .collect();
        for output in [
            std::process::Command::new("/bin/sh")
                .args(["-c", &injected])
                .output()
                .unwrap(),
            std::process::Command::new(&plan.executable)
                .args(&plan.arguments)
                .output()
                .unwrap(),
        ] {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let arguments: Vec<_> = output
                .stdout
                .split(|byte| *byte == 0)
                .filter(|value| !value.is_empty())
                .map(|value| String::from_utf8(value.to_vec()).unwrap())
                .collect();
            assert_eq!(arguments, expected);
        }
    }
}
