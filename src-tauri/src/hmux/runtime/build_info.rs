use super::{
    bounded_process, command_failure::bundled_runtime_failure, is_executable_file, safe_build_id,
    validate_protocol, CommandSpec, InstallProtocol, InstalledBuild, BUILD_INFO_LIMIT,
    BUILD_INFO_SUBCOMMAND,
};
use serde::Deserialize;
use std::{path::Path, time::Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuildInfo {
    schema_version: u16,
    pub(super) build_id: String,
    pub(super) protocol: InstallProtocol,
    #[serde(default)]
    pub(super) capabilities: Vec<String>,
}

impl BuildInfo {
    pub(super) fn supports_app_sessions(&self) -> bool {
        super::install_protocol_contains(&self.protocol, (1, 0))
            && [
                hmux_client::MANAGED_CREATE_CAPABILITY,
                // A new provider must be able to report the lifecycle events
                // emitted by this app, not merely accept its create request.
                hmux_client::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
                // Windows explicitly refuses standalone recovery identities.
                #[cfg(unix)]
                hmux_client::STANDALONE_REQUEST_BOUND_CREATE_CAPABILITY,
            ]
            .iter()
            .all(|required| self.capabilities.iter().any(|value| value == required))
    }

    pub(super) fn require_app_sessions(&self) -> Result<(), String> {
        if self.supports_app_sessions() {
            Ok(())
        } else {
            Err(format!(
                "hmux_create_runtime_incompatible: build {} does not support this app's session contract",
                self.build_id,
            ))
        }
    }
}

pub(super) fn installed_supports_app_sessions(
    installed: &InstalledBuild,
    timeout: Duration,
) -> Result<bool, String> {
    let info = inspect_runtime_at(&installed.runtime, timeout)?;
    if info.build_id != installed.build_id {
        return Err("hmux_runtime_identity_mismatch: executable does not match installed build".into());
    }
    Ok(info.supports_app_sessions())
}

pub(super) fn inspect_runtime_at(source: &Path, timeout: Duration) -> Result<BuildInfo, String> {
    if !is_executable_file(source) {
        return Err("hmux_bundled_runtime_invalid: source is not executable".to_string());
    }
    let mut command = CommandSpec::new(source);
    command.arg(BUILD_INFO_SUBCOMMAND);
    let output = bounded_process::run(&command, timeout, BUILD_INFO_LIMIT)
        .map_err(bundled_runtime_failure)?;
    if !output.status.success() {
        return Err("hmux_bundled_runtime_invalid: build info probe failed".to_string());
    }
    if output.exceeded_limit {
        return Err("hmux_bundled_runtime_invalid: build info is too large".to_string());
    }
    let info: BuildInfo = serde_json::from_slice(&output.stdout)
        .map_err(|_| "hmux_bundled_runtime_invalid: build info is malformed".to_string())?;
    if info.schema_version != 1 || !safe_build_id(&info.build_id) {
        return Err("hmux_bundled_runtime_invalid: build identity is invalid".to_string());
    }
    validate_protocol(&info.protocol)?;
    Ok(info)
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn selected_executable_capabilities_are_observed_without_install_metadata_or_cache() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("runtime");
        let selected = super::super::InstalledBuild {
            build_id: "test-build".into(),
            runtime: executable.clone(),
        };
        for capabilities in [
            None,
            Some(vec!["first"]),
            Some(vec!["second"]),
            Some(vec![]),
        ] {
            let mut info = serde_json::json!({
                "schemaVersion": 1, "buildId": "test-build",
                "protocol": {"minimum": "1.0", "maximum": "1.0"},
            });
            if let Some(capabilities) = &capabilities {
                info["capabilities"] = serde_json::json!(capabilities);
            }
            std::fs::write(
                &executable,
                format!(
                    "#!/bin/sh\n[ \"$1\" = hmux-build-info ] || exit 1\nprintf '%s' '{}'\n",
                    info,
                ),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(
                selected.capabilities().unwrap(),
                capabilities.unwrap_or_default()
            );
        }
    }

    #[test]
    fn background_capability_observation_uses_the_existing_capability_probe_budget() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("slow-runtime");
        std::fs::write(
            &executable,
            concat!(
                "#!/bin/sh\n/bin/sleep 2.25\n",
                "printf '%s' '{\"schemaVersion\":1,\"buildId\":\"slow-build\",",
                "\"protocol\":{\"minimum\":\"1.0\",\"maximum\":\"1.0\"},",
                "\"capabilities\":[\"slow-capability\"]}'\n",
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let selected = super::super::InstalledBuild {
            build_id: "slow-build".into(),
            runtime: executable,
        };
        assert_eq!(selected.capabilities().unwrap(), vec!["slow-capability"]);
    }
}
