//! Provider-owned discovery for launch menus, independent of conversation lifetime.
//! Initialization only: no thread, prompt, tools, MCP servers, or workspace hooks.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::{BackendDispatchError, resolve_provider_executable};

mod opencode;

const MAX_OUTPUT: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogRequest {
    schema_version: u16,
    provider_id: String,
    credential_profile: Option<CredentialProfile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialProfile {
    reference_id: String,
    profile_directory_name: String,
}

struct CatalogProcess(Child);

impl Drop for CatalogProcess {
    fn drop(&mut self) {
        if let Some(id) = self.0.id() {
            // This group was created by this request, never looked up by name.
            unsafe { libc::kill(-(id as i32), libc::SIGKILL) };
        }
    }
}

pub(crate) async fn read(body: Value) -> Result<Value, BackendDispatchError> {
    let request: CatalogRequest = serde_json::from_value(body)
        .map_err(|_| BackendDispatchError::from("provider_catalog_request_invalid"))?;
    if request.schema_version != 1 {
        return Err("provider_catalog_request_invalid".into());
    }
    if !matches!(
        request.provider_id.as_str(),
        "claude" | "codex" | "opencode"
    ) {
        return Ok(json!({"schemaVersion": 1, "models": []}));
    }
    let home = std::env::var("HOME").map_err(|_| "provider_catalog_home_unavailable")?;
    let directory = request
        .credential_profile
        .as_ref()
        .map(|profile| {
            let provider = dure_app::ProviderIdV1::new(&request.provider_id)
                .map_err(|_| "provider_catalog_request_invalid")?;
            dure_app::ProviderCredentialProfileDirectoryNameV1::new(
                &provider,
                profile.profile_directory_name.clone(),
            )
            .map_err(|_| "provider_catalog_credential_invalid")?;
            Ok::<_, &str>(
                Path::new(&home)
                    .join(".dure/accounts")
                    .join(&profile.profile_directory_name),
            )
        })
        .transpose()?;
    // Read-only resolution: never register, prepare, or copy credential state to probe it.
    let environment = dure_provider_profile::managed_provider_state_environment(
        &request.provider_id,
        &home,
        request
            .credential_profile
            .as_ref()
            .map(|profile| profile.reference_id.as_str()),
        directory.as_ref().and_then(|path| path.to_str()),
    )
    .map_err(|_| "provider_catalog_credential_invalid")?;
    let executable = resolve_provider_executable(&request.provider_id)?;
    let workspace = tempfile::tempdir().map_err(|_| "provider_catalog_workspace_unavailable")?;
    let mut command = Command::new(executable);
    command
        .current_dir(workspace.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name == "HMUX"
            || name.starts_with("HMUX_")
            || name.starts_with("DURE_")
            || crate::claude_structured_runtime::outer_claude_session_environment(&name)
        {
            command.env_remove(key);
        }
    }
    for key in environment.removals() {
        command.env_remove(key);
    }
    command.envs(environment.values());
    if request.provider_id == "codex" {
        command.arg("app-server");
    } else if request.provider_id == "opencode" {
        command.args(["models", "--verbose"]);
    } else {
        command.args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--settings",
            "{\"disableAllHooks\":true}",
        ]);
    }
    let mut process = CatalogProcess(
        command
            .spawn()
            .map_err(|_| "provider_catalog_spawn_failed")?,
    );
    let stdin = process
        .0
        .stdin
        .take()
        .ok_or("provider_catalog_pipe_unavailable")?;
    let stdout = process
        .0
        .stdout
        .take()
        .ok_or("provider_catalog_pipe_unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let models = discover(&request.provider_id, stdin, stdout).await?;
        if request.provider_id == "opencode"
            && !process
                .0
                .wait()
                .await
                .map_err(|_| "provider_catalog_process_failed")?
                .success()
        {
            return Err("provider_catalog_process_failed");
        }
        Ok(models)
    })
    .await
    .map_err(|_| "provider_catalog_timeout")
    .and_then(|result| result);
    // Close the exact owned process group on success, failure, and cancellation.
    if let Some(id) = process.0.id() {
        unsafe { libc::kill(-(id as i32), libc::SIGKILL) };
    }
    let _ = process.0.wait().await;
    result
        .map(|models| json!({"schemaVersion": 1, "models": models}))
        .map_err(Into::into)
}

async fn send(stdin: &mut ChildStdin, value: Value) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "provider_catalog_protocol_invalid")?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| "provider_catalog_write_failed")
}

async fn discover(
    provider: &str,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
) -> Result<Vec<Value>, &'static str> {
    if provider == "opencode" {
        drop(stdin);
        let mut bytes = Vec::new();
        stdout
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "provider_catalog_read_failed")?;
        if bytes.len() as u64 > MAX_OUTPUT {
            return Err("provider_catalog_output_limit");
        }
        return opencode::parse(&bytes);
    }
    let mut reader = BufReader::new(stdout.take(MAX_OUTPUT + 1));
    let mut remaining = MAX_OUTPUT;
    let mut models = Vec::new();
    let mut cursors = std::collections::BTreeSet::new();
    if provider == "codex" {
        send(
            &mut stdin,
            json!({"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "dure-model-discovery", "version": "1"},
                "capabilities": {"experimentalApi": true}
            }}),
        )
        .await?;
    } else {
        send(&mut stdin, json!({"type": "control_request", "request_id": "catalog", "request": {"subtype": "initialize"}})).await?;
    }
    loop {
        let mut line = Vec::new();
        let size = reader
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "provider_catalog_read_failed")?;
        if size == 0 {
            return Err("provider_catalog_closed");
        }
        remaining = remaining
            .checked_sub(size as u64)
            .ok_or("provider_catalog_output_limit")?;
        let response: Value =
            serde_json::from_slice(&line).map_err(|_| "provider_catalog_protocol_invalid")?;
        if provider == "claude" {
            if response["type"] != "control_response"
                || response["response"]["request_id"] != "catalog"
            {
                continue;
            }
            return response["response"]["response"]["models"]
                .as_array()
                .cloned()
                .ok_or("provider_catalog_unavailable");
        }
        if response["id"] == 1 {
            if response.get("error").is_some() {
                return Err("provider_catalog_initialize_failed");
            }
            send(&mut stdin, json!({"method": "initialized"})).await?;
            send(&mut stdin, json!({"id": 2, "method": "model/list", "params": {"includeHidden": false, "limit": 100}})).await?;
        } else if response["id"] == 2 {
            if response.get("error").is_some() {
                return Err("provider_catalog_unavailable");
            }
            let result = &response["result"];
            if !result["data"].is_array() {
                return Err("provider_catalog_protocol_invalid");
            }
            if let Some(catalog) =
                crate::codex_app_server_protocol::provider_catalog_from_model_list(result)
            {
                models.extend(catalog["models"].as_array().cloned().unwrap_or_default());
            }
            match result["nextCursor"]
                .as_str()
                .filter(|cursor| !cursor.is_empty())
            {
                Some(cursor) if cursors.insert(cursor.to_owned()) => {
                    send(&mut stdin, json!({"id": 2, "method": "model/list", "params": {"includeHidden": false, "limit": 100, "cursor": cursor}})).await?;
                }
                Some(_) => return Err("provider_catalog_cursor_repeated"),
                None => return Ok(models),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture(provider: &str, program: &str) -> Result<Vec<Value>, &'static str> {
        let mut child = Command::new("/bin/sh")
            .args(["-c", program])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            discover(
                provider,
                child.stdin.take().unwrap(),
                child.stdout.take().unwrap(),
            ),
        )
        .await
        .unwrap();
        let _ = child.kill().await;
        result
    }

    #[tokio::test]
    async fn discovers_future_models_and_follows_provider_pagination() {
        let result = fixture("codex", r#"
            read -r init
            case "$init" in *initialize*) ;; *) exit 1;; esac
            printf '%s\n' '{"id":1,"result":{}}'
            read -r notification
            read -r request
            case "$request" in *model/list*) ;; *) exit 2;; esac
            printf '%s\n' '{"id":2,"result":{"data":[{"model":"future-model","displayName":"Future","supportedReasoningEfforts":[{"reasoningEffort":"deeper"}]}],"nextCursor":"page-2"}}'
            read -r request
            case "$request" in *page-2*) ;; *) exit 3;; esac
            printf '%s\n' '{"id":2,"result":{"data":[{"model":"later-model"}],"nextCursor":null}}'
        "#).await.unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["value"], "future-model");
        assert_eq!(result[0]["supportedEffortLevels"], json!(["deeper"]));
        assert_eq!(result[1]["value"], "later-model");
    }

    #[tokio::test]
    async fn claude_initialization_is_sufficient_without_a_prompt() {
        let result = fixture("claude", r#"
            read -r request
            case "$request" in *initialize*) ;; *) exit 1;; esac
            printf '%s\n' '{"type":"control_response","response":{"request_id":"catalog","response":{"models":[{"value":"next[1m]","displayName":"Next","supportsEffort":true,"supportedEffortLevels":["deep"]}]}}}'
        "#).await.unwrap();
        assert_eq!(result[0]["value"], "next[1m]");
    }

    #[tokio::test]
    async fn opencode_catalog_preserves_namespaced_ids_without_starting_a_session() {
        let models = fixture("opencode", r#"
            printf '%s\n' 'fixture/model' '{' '  "id": "model",' '  "providerID": "fixture",' '  "name": "Fixture model",' '  "variants": {"high": {}}' '}'
        "#).await.unwrap();
        assert_eq!(
            models,
            vec![json!({
                "value": "fixture/model", "displayName": "Fixture model",
                "supportsEffort": false, "supportedEffortLevels": [],
            })]
        );
    }

    #[tokio::test]
    async fn provider_failure_never_returns_a_fallback_catalog() {
        let error = fixture(
            "codex",
            r#"
            read -r request
            printf '%s\n' '{"id":1,"error":{"message":"unavailable"}}'
        "#,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "provider_catalog_initialize_failed");
    }

    #[tokio::test]
    #[ignore = "requires an isolated HOME and OpenCode on PATH with a configured fixture provider"]
    async fn live_opencode_catalog() {
        let catalog = read(json!({"schemaVersion": 1, "providerId": "opencode"}))
            .await
            .unwrap();
        let models = catalog["models"].as_array().unwrap();
        assert!(!models.is_empty());
        for model in models {
            assert!(model["value"].as_str().unwrap().contains('/'));
            assert_eq!(model["supportsEffort"], false);
        }
        eprintln!("OpenCode native catalog: {catalog}");
    }

    #[tokio::test]
    #[ignore = "requires installed authenticated provider CLIs; initialization only, no prompts"]
    async fn live_provider_catalogs() {
        for provider in ["codex", "claude"] {
            let catalog = read(json!({"schemaVersion": 1, "providerId": provider}))
                .await
                .unwrap();
            let models = catalog["models"].as_array().unwrap();
            assert!(!models.is_empty(), "{provider}");
            eprintln!(
                "{provider} catalog: {}",
                serde_json::to_string(
                    &models
                        .iter()
                        .map(|model| model["value"].as_str().unwrap_or_default())
                        .collect::<Vec<_>>()
                )
                .unwrap()
            );
        }
    }
}
