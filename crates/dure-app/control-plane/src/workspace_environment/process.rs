use std::fs::File;
use std::os::fd::AsFd;
use std::time::Duration;

use hebbian_bounded_process::{
    CommandSpec, OutputLimitAction, UnixDirectoryAnchor, run_unix_bound_command_async,
};
use serde_json::json;

use super::recipe::label;
use super::store::{RecipeResult, Record, Status, Store};

pub(super) async fn execute(store: Store, mut record: Record, mode: String, lock: File) {
    let outcome = command(&store, &record, &mode, &lock)
        .await
        .and_then(|stdout| {
            if mode == "destroy" || mode == "suspend" {
                return Ok(None);
            }
            let result = parse_result(&stdout)?;
            if mode == "resume"
                && record.result.as_ref().is_some_and(|previous| {
                    previous.resource_id != result.resource_id
                        || previous.connection.project_root != result.connection.project_root
                        || previous.connection.host != result.connection.host
                        || previous.connection.port != result.connection.port
                        || previous.connection.user != result.connection.user
                        || previous.connection.key_path != result.connection.key_path
                })
            {
                return Err("environment_resume_identity_changed".into());
            }
            Ok(Some(result))
        });
    match outcome {
        Ok(result) => {
            if let Some(result) = result {
                record.result = Some(result);
            }
            record.status = match mode.as_str() {
                "destroy" => Status::Destroyed,
                "suspend" => Status::Suspended,
                _ => Status::Running,
            };
            record.error = None;
        }
        Err(error) => {
            record.error = Some(error);
            record.status = if mode == "destroy" {
                Status::CleanupFailed
            } else {
                Status::Failed
            };
            // Every recipe must address resources by the preallocated instance ID,
            // including when create never returned a result. No replay creates a
            // second resource, and malformed output still has a cleanup address.
            if mode == "create" {
                record.status = Status::Destroying;
                record.revision += 1;
                record.updated_at_ms = crate::now_ms().unwrap_or(record.updated_at_ms);
                if store.write(&record).is_err() {
                    return;
                }
                record.status = match command(&store, &record, "destroy", &lock).await {
                    Ok(_) => Status::Destroyed,
                    Err(cleanup) => {
                        record.error = Some(format!(
                            "{}; {cleanup}",
                            record
                                .error
                                .as_deref()
                                .unwrap_or("environment_create_failed")
                        ));
                        Status::CleanupFailed
                    }
                };
            }
        }
    }
    record.revision += 1;
    record.updated_at_ms = crate::now_ms().unwrap_or(record.updated_at_ms);
    // A failed durable write leaves the pending record. The next observer can
    // detect the released operation lock and surface interrupted cleanup.
    if let Err(error) = store.write(&record) {
        eprintln!("workspace environment {}: {error}", record.id);
    }
}

async fn command(
    store: &Store,
    record: &Record,
    mode: &str,
    lock: &File,
) -> Result<Vec<u8>, String> {
    let source = match mode {
        "create" => Some(record.recipe.create.as_str()),
        "destroy" => Some(record.recipe.destroy.as_str()),
        "suspend" => record.recipe.suspend.as_deref(),
        "resume" => record.recipe.resume.as_deref(),
        _ => None,
    }
    .ok_or("environment_action_unsupported")?;
    let mut command = CommandSpec::new("/bin/bash");
    command.clear_env();
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if !["DURE_", "HMUX_", "GIT_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            command.env(key, value);
        }
    }
    command.args(["-c", source])
        .capture_stderr(true).on_output_limit(OutputLimitAction::TerminateProcessTree)
        .env("DURE_ENVIRONMENT_ID", &record.id)
        .env("DURE_ENVIRONMENT_NAME", &record.name)
        .env("DURE_ENVIRONMENT_ACTION", mode)
        .env("DURE_ENVIRONMENT_SCHEMA_VERSION", "1")
        .env("DURE_PROJECT_PATH", &record.project_path)
        .input(serde_json::to_vec(&json!({
            "schemaVersion": 1, "action": mode, "instanceId": record.id,
            "name": record.name, "projectPath": record.project_path, "recipeResult": record.result,
        })).map_err(|_| "environment_request_invalid")?);
    let directory = store.workdir(&record.id)?;
    let anchor = UnixDirectoryAnchor::new(lock.as_fd(), &directory)
        .map_err(|failure| format!("environment_{mode}_{}", failure.stage()))?;
    let output = run_unix_bound_command_async(
        &command,
        &[anchor],
        Some(0),
        Duration::from_secs(1800),
        64 * 1024,
        tokio::time::sleep,
    )
    .await
    .map_err(|failure| format!("environment_{mode}_{}", failure.stage()))?;
    if !output.status.success() {
        // Provider stdout and stderr may contain credentials. Keep only an exit
        // status in public/durable diagnostics; scripts own private detailed logs.
        return Err(format!(
            "environment_{mode}_exit_{}",
            output
                .status
                .code()
                .map_or("signal".into(), |code| code.to_string())
        ));
    }
    if output.exceeded_limit {
        return Err("environment_output_limit".into());
    }
    Ok(output.stdout)
}

pub(super) fn parse_result(stdout: &[u8]) -> Result<RecipeResult, String> {
    let result: RecipeResult =
        serde_json::from_slice(stdout).map_err(|_| "environment_result_invalid")?;
    let connection = &result.connection;
    let address = |value: &str| {
        !value.is_empty()
            && value.len() <= 255
            && !value.starts_with('-')
            && !value.chars().any(|c| c.is_whitespace() || c.is_control())
    };
    if result.schema_version != 1
        || !label(&result.resource_id)
        || !address(&connection.host)
        || !address(&connection.user)
        || connection.port == 0
        || !connection.project_root.starts_with('/')
        || connection.project_root.len() > 4096
        || connection.project_root.chars().any(char::is_control)
        || connection.key_path.as_ref().is_some_and(|path| {
            !path.starts_with('/') || path.len() > 4096 || path.chars().any(char::is_control)
        })
        || !(result.user_data.is_null() || result.user_data.is_object())
    {
        return Err("environment_result_invalid".into());
    }
    Ok(result)
}
