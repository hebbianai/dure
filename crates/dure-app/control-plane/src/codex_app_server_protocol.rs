use std::path::Path;

use dure_app::{AgentStartTurnIntentV1, ProviderPermissionModeV1};
use serde_json::{Map, Value, json};

/// Projects the provider-owned `model/list` response onto the small catalog
/// shape shared by Chat surfaces. Unknown fields stay provider-local, while
/// malformed entries simply do not become picker options.
pub(super) fn provider_catalog_from_model_list(response: &Value) -> Option<Value> {
    let models = response
        .get("data")?
        .as_array()?
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let value = entry
                .get("model")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    entry
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                })?;
            let display_name = entry
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(value);
            let supported_effort_levels = entry
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    effort
                        .get("reasoningEffort")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                })
                .collect::<Vec<_>>();
            Some(json!({
                "value": value,
                "displayName": display_name,
                "supportsEffort": !supported_effort_levels.is_empty(),
                "supportedEffortLevels": supported_effort_levels,
            }))
        })
        .collect::<Vec<_>>();
    (!models.is_empty()).then(|| json!({ "models": models }))
}

use crate::provider_turn_settings::ProviderTurnSettings;

impl ProviderTurnSettings {
    pub(super) fn thread_start_params(&self, cwd: &Path) -> Value {
        let mut params = Map::from_iter([(
            "cwd".into(),
            Value::String(cwd.to_string_lossy().into_owned()),
        )]);
        self.apply_thread_overrides(&mut params);
        Value::Object(params)
    }

    pub(super) fn thread_resume_params(&self, thread_id: &str, cwd: &Path) -> Value {
        let mut params = Map::from_iter([
            ("threadId".into(), Value::String(thread_id.into())),
            (
                "cwd".into(),
                Value::String(cwd.to_string_lossy().into_owned()),
            ),
        ]);
        self.apply_thread_overrides(&mut params);
        Value::Object(params)
    }

    fn apply_thread_overrides(&self, params: &mut Map<String, Value>) {
        if let Some(model) = &self.model {
            params.insert("model".into(), Value::String(model.as_str().into()));
        }
        match self.permission_mode {
            ProviderPermissionModeV1::Default => {}
            // Codex's full-auto shape: workspace edits run inside the
            // write sandbox and only an escape or failure asks.
            ProviderPermissionModeV1::AutoEdit => {
                params.insert("approvalPolicy".into(), Value::String("on-failure".into()));
                params.insert("sandbox".into(), Value::String("workspace-write".into()));
            }
            ProviderPermissionModeV1::SkipPermissions => {
                params.insert("approvalPolicy".into(), Value::String("never".into()));
                params.insert("sandbox".into(), Value::String("danger-full-access".into()));
            }
        }
    }

    pub(super) fn turn_start_params(
        &self,
        thread_id: &str,
        intent: &AgentStartTurnIntentV1,
    ) -> Value {
        let mut params = Map::from_iter([
            ("threadId".into(), Value::String(thread_id.into())),
            (
                "clientUserMessageId".into(),
                Value::String(intent.client_message_id.to_string()),
            ),
            (
                "input".into(),
                json!([{
                    "type": "text",
                    "text": intent.input,
                    "text_elements": [],
                }]),
            ),
        ]);
        if let Some(model) = &self.model {
            params.insert("model".into(), Value::String(model.as_str().into()));
        }
        if let Some(effort) = &self.effort {
            params.insert("effort".into(), Value::String(effort.as_str().into()));
        }
        match self.permission_mode {
            ProviderPermissionModeV1::Default => {}
            ProviderPermissionModeV1::AutoEdit => {
                params.insert("approvalPolicy".into(), Value::String("on-failure".into()));
                params.insert("sandboxPolicy".into(), json!({ "type": "workspaceWrite" }));
            }
            ProviderPermissionModeV1::SkipPermissions => {
                params.insert("approvalPolicy".into(), Value::String("never".into()));
                params.insert(
                    "sandboxPolicy".into(),
                    json!({ "type": "dangerFullAccess" }),
                );
            }
        }
        Value::Object(params)
    }
}

impl crate::json_rpc_socket_client::JsonRpcSocketClient {
    pub(crate) async fn initialize_codex(
        &self,
    ) -> Result<Value, crate::json_rpc_socket_client::JsonRpcSocketClientError> {
        let result = self
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "dure",
                        "title": "Dure",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": {
                        "experimentalApi": false,
                        "requestAttestation": false,
                    },
                }),
            )
            .await?;
        self.notify("initialized", json!({})).await?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_model_list_without_reinterpreting_provider_values() {
        assert_eq!(
            provider_catalog_from_model_list(&json!({
                "data": [
                    {
                        "id": "catalog-entry",
                        "model": "gpt-next",
                        "displayName": "GPT Next",
                        "supportedReasoningEfforts": [
                            { "reasoningEffort": "low", "description": "Fast" },
                            { "reasoningEffort": "ultra", "description": "Deep" },
                        ],
                        "defaultReasoningEffort": "low",
                        "isDefault": true,
                    },
                    { "id": "legacy-model", "displayName": "Legacy" },
                    { "displayName": "missing identity" },
                ],
            })),
            Some(json!({
                "models": [
                    {
                        "value": "gpt-next",
                        "displayName": "GPT Next",
                        "supportsEffort": true,
                        "supportedEffortLevels": ["low", "ultra"],
                    },
                    {
                        "value": "legacy-model",
                        "displayName": "Legacy",
                        "supportsEffort": false,
                        "supportedEffortLevels": [],
                    },
                ],
            })),
        );
        assert_eq!(
            provider_catalog_from_model_list(&json!({ "data": [] })),
            None
        );
    }
    use dure_app::{
        AgentClientMessageIdV1, AgentProviderRuntimeFenceV1, AgentSpawnEffortSelectionV1,
        AgentSpawnModelSelectionV1, AgentTurnIdV1,
    };

    fn start_intent() -> AgentStartTurnIntentV1 {
        AgentStartTurnIntentV1 {
            schema_version: 1,
            interaction_session_id: dure_app::AgentInteractionSessionIdV1::new("interaction-1")
                .unwrap(),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-1".into(),
                provider_epoch: "provider-1".into(),
            },
            client_message_id: AgentClientMessageIdV1::new("message-1").unwrap(),
            turn_id: AgentTurnIdV1::new("turn-1").unwrap(),
            input: "Inspect the workspace".into(),
            requested_at_ms: 1,
        }
    }

    #[test]
    fn applies_saved_settings_with_exact_thread_and_turn_wire_shapes() {
        let settings = ProviderTurnSettings::new(
            ProviderPermissionModeV1::SkipPermissions,
            Some(AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
            Some(AgentSpawnEffortSelectionV1::parse("ultra").unwrap()),
        );
        assert_eq!(
            settings.thread_resume_params("thread-1", Path::new("/workspace")),
            json!({
                "threadId": "thread-1",
                "cwd": "/workspace",
                "model": "gpt-5.6-sol",
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
            })
        );
        assert_eq!(
            settings.turn_start_params("thread-1", &start_intent()),
            json!({
                "threadId": "thread-1",
                "clientUserMessageId": "message-1",
                "input": [{
                    "type": "text",
                    "text": "Inspect the workspace",
                    "text_elements": [],
                }],
                "model": "gpt-5.6-sol",
                "effort": "ultra",
                "approvalPolicy": "never",
                "sandboxPolicy": { "type": "dangerFullAccess" },
            })
        );
    }

    #[test]
    fn auto_edit_stays_inside_the_workspace_write_sandbox() {
        let settings = ProviderTurnSettings::new(ProviderPermissionModeV1::AutoEdit, None, None);
        assert_eq!(
            settings.thread_start_params(Path::new("/workspace")),
            json!({
                "cwd": "/workspace",
                "approvalPolicy": "on-failure",
                "sandbox": "workspace-write",
            })
        );
        assert_eq!(
            settings.turn_start_params("thread-1", &start_intent()),
            json!({
                "threadId": "thread-1",
                "clientUserMessageId": "message-1",
                "input": [{
                    "type": "text",
                    "text": "Inspect the workspace",
                    "text_elements": [],
                }],
                "approvalPolicy": "on-failure",
                "sandboxPolicy": { "type": "workspaceWrite" },
            })
        );
    }

    #[test]
    fn provider_default_preserves_codex_configuration() {
        let settings = ProviderTurnSettings::new(ProviderPermissionModeV1::Default, None, None);
        assert_eq!(
            settings.thread_start_params(Path::new("/workspace")),
            json!({ "cwd": "/workspace" })
        );
        assert_eq!(
            settings.turn_start_params("thread-1", &start_intent()),
            json!({
                "threadId": "thread-1",
                "clientUserMessageId": "message-1",
                "input": [{
                    "type": "text",
                    "text": "Inspect the workspace",
                    "text_elements": [],
                }],
            })
        );
    }
}
