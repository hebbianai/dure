use super::{shell_quote, write_owner_only_file};
use dure_app::ProviderRuntimeIntegrationV1;
use std::path::Path;

const EXTENSION: &str = include_str!("../../resources/managed-pi-extension.mjs");
const RUNTIME_PLACEHOLDER: &str = "\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"";

pub(super) fn publish(
    control_dir: &Path,
    runtime: &Path,
) -> std::io::Result<ProviderRuntimeIntegrationV1> {
    if !runtime.is_absolute() {
        return Err(std::io::Error::other("managed Pi runtime must be absolute"));
    }
    let extension = control_dir.join("managed-pi-extension.mjs");
    let launcher = control_dir.join("managed-pi-launch.sh");
    let runtime = serde_json::to_string(runtime).map_err(std::io::Error::other)?;
    let contents = EXTENSION.replacen(RUNTIME_PLACEHOLDER, &runtime, 1);
    write_owner_only_file(control_dir, &extension, contents.as_bytes(), 0o600)?;
    let wrapper = format!(
        "#!/bin/sh\nset -eu\nprovider=$1\nshift\nexec \"$provider\" --extension {} \"$@\"\n",
        shell_quote(&extension.to_string_lossy()),
    );
    write_owner_only_file(control_dir, &launcher, wrapper.as_bytes(), 0o700)?;
    Ok(ProviderRuntimeIntegrationV1::CommandWrapper {
        path: launcher.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::integrations::inject_command_wrapper;
    use super::*;
    use dure_app::{ProviderIdV1, PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn published_pi_launch_preserves_argv_and_shares_the_channel_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let control = temporary.path().join("channel with spaces");
        std::fs::create_dir(&control).unwrap();
        std::fs::set_permissions(&control, std::fs::Permissions::from_mode(0o700)).unwrap();
        let integration = publish(&control, Path::new("/fixture/runtime")).unwrap();
        let document = super::super::integrations::provider_runtime_integrations_document(
            "qa-pi",
            None,
            None,
            std::collections::BTreeMap::from([(
                ProviderIdV1::new("pi").unwrap(),
                integration.clone(),
            )]),
        )
        .unwrap();
        let contract = control.join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1);
        write_owner_only_file(
            &control,
            &contract,
            &serde_json::to_vec(&document).unwrap(),
            0o600,
        )
        .unwrap();
        let channel = crate::app_channel::AppChannel {
            name: "qa-pi".into(),
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
        let command = format!(
            "{} --model 'fixture/model b' --session exact-id --extension '/user/extension.ts'",
            shell_quote(&probe.to_string_lossy())
        );
        let injected = inject_command_wrapper("pi", &command, &channel).unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &injected])
            .output()
            .unwrap();
        assert!(output.status.success());
        let arguments: Vec<_> = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8(arg.to_vec()).unwrap())
            .collect();
        assert_eq!(
            arguments,
            [
                "--extension",
                control.join("managed-pi-extension.mjs").to_str().unwrap(),
                "--model",
                "fixture/model b",
                "--session",
                "exact-id",
                "--extension",
                "/user/extension.ts",
            ]
        );
        let mut plan = dure_app::AgentProviderLaunchPlanV1 {
            executable: probe.to_string_lossy().into_owned(),
            arguments: vec!["--model".into(), "fixture/model b".into()],
        };
        dure_provider_adapter::apply_provider_runtime_integration(
            &ProviderIdV1::new("pi").unwrap(),
            &integration,
            &mut plan,
        )
        .unwrap();
        let output = std::process::Command::new(plan.executable)
            .args(plan.arguments)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            output.stdout,
            arguments[..4]
                .join("\0")
                .into_bytes()
                .into_iter()
                .chain([0])
                .collect::<Vec<_>>()
        );

        let wrong_channel = crate::app_channel::AppChannel {
            name: "qa-other".into(),
            ..channel
        };
        assert!(inject_command_wrapper("pi", &command, &wrong_channel).is_err());
    }
}
