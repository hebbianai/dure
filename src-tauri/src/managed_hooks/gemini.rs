use super::{shell_quote, write_owner_only_file};
use dure_app::ProviderRuntimeIntegrationV1;
use std::path::Path;

const HOOK: &str = include_str!("../../resources/managed-gemini-hook.mjs");
const EXTENSION: &str = include_str!("../../resources/managed-gemini-extension.mjs");

pub(super) fn publish(
    control_dir: &Path,
    runtime: &Path,
) -> std::io::Result<ProviderRuntimeIntegrationV1> {
    if !runtime.is_absolute() {
        return Err(std::io::Error::other(
            "managed Gemini runtime must be absolute",
        ));
    }
    let hook = HOOK.replacen(
        "\"__DURE_HMUX_RUNTIME_EXECUTABLE__\"",
        &serde_json::to_string(runtime).map_err(std::io::Error::other)?,
        1,
    );
    write_owner_only_file(
        control_dir,
        &control_dir.join("managed-gemini-hook.mjs"),
        hook.as_bytes(),
        0o600,
    )?;
    write_owner_only_file(
        control_dir,
        &control_dir.join("managed-hook-extension.mjs"),
        include_bytes!("../../resources/managed-hook-extension.mjs"),
        0o600,
    )?;
    write_owner_only_file(
        control_dir,
        &control_dir.join("managed-hook-report.mjs"),
        include_bytes!("../../resources/managed-hook-report.mjs"),
        0o600,
    )?;
    let extension = control_dir.join("managed-gemini-extension.mjs");
    write_owner_only_file(control_dir, &extension, EXTENSION.as_bytes(), 0o600)?;
    let launcher = control_dir.join("managed-gemini-launch.sh");
    let script = format!(
        "#!/bin/sh\nset -eu\nhook=$(node {})\nexport DURE_GEMINI_HOOK_PATH=\"$hook\"\nexec \"$@\"\n",
        shell_quote(&extension.to_string_lossy()),
    );
    write_owner_only_file(control_dir, &launcher, script.as_bytes(), 0o700)?;
    Ok(ProviderRuntimeIntegrationV1::CommandWrapper {
        path: launcher.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn published_gemini_launch_preserves_arguments_and_original_settings() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let integration = publish(root, Path::new("/fixture/runtime")).unwrap();
        let defaults = root.join("original-defaults.json");
        let source =
            b"// Administrator policy\n{\"security\":{\"folderTrust\":{\"enabled\":true}}}";
        std::fs::write(&defaults, source).unwrap();
        let probe = root.join("provider probe");
        write_owner_only_file(
            root,
            &probe,
            b"#!/bin/sh\nprintf '%s\\0' \"$GEMINI_CLI_SYSTEM_DEFAULTS_PATH\" \"$DURE_GEMINI_HOOK_PATH\" \"$@\"\n",
            0o700,
        )
        .unwrap();
        let original = vec![
            "--resume".into(),
            "exact-id".into(),
            "--prompt-interactive".into(),
            "Review 'quoted'\n한글".into(),
        ];
        let mut plan = dure_app::AgentProviderLaunchPlanV1 {
            executable: probe.to_string_lossy().into_owned(),
            arguments: original.clone(),
        };
        dure_provider_adapter::apply_provider_runtime_integration(
            &dure_app::ProviderIdV1::new("gemini").unwrap(),
            &integration,
            &mut plan,
        )
        .unwrap();
        let output = std::process::Command::new(plan.executable)
            .args(plan.arguments)
            .env("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", &defaults)
            .env("GEMINI_CLI_HOME", root.join("home"))
            .output()
            .unwrap();
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
        assert_eq!(arguments[2..], original);
        assert_eq!(Path::new(&arguments[0]), defaults);
        assert_eq!(
            std::fs::canonicalize(&arguments[1]).unwrap(),
            std::fs::canonicalize(root.join("managed-gemini-hook.mjs")).unwrap(),
        );
        assert!(root.join("home/.gemini/extensions/dure-lifecycle-v1/hooks/hooks.json").is_file());
        assert_eq!(std::fs::read(defaults).unwrap(), source);
    }
}
