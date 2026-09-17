use crate::CliError;
use serde::Deserialize;
use std::{path::Path, process::Command};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeBuildInfo {
    pub build_id: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

pub(super) fn inspect(runtime: &Path) -> Result<RuntimeBuildInfo, CliError> {
    let output = Command::new(runtime)
        .args(["--no-autostart", "hmux-build-info"])
        .output()
        .map_err(|error| {
            CliError(format!(
                "inspect Hmux runtime {} failed: {error}",
                runtime.display()
            ))
        })?;
    if !output.status.success() {
        return Err(CliError(format!(
            "inspect Hmux runtime {} failed with {}",
            runtime.display(),
            output.status
        )));
    }
    let info: RuntimeBuildInfo = serde_json::from_slice(&output.stdout)
        .map_err(|_| CliError("Hmux runtime build info is malformed".into()))?;
    if info.build_id.is_empty() {
        return Err(CliError("Hmux runtime build info has no buildId".into()));
    }
    Ok(info)
}

pub(super) fn runtime_build_id(runtime: &Path) -> Result<String, CliError> {
    inspect(runtime).map(|info| info.build_id)
}
