use std::path::Path;
use std::sync::Arc;

use crate::agent_conversation::AgentConversationService;
use crate::codex_connection_driver_protocol::{
    THREAD_ATTACH_METHOD, supports_thread_attach, thread_attach_params,
};
use crate::codex_timeline_bridge::CodexTimelineBridge;
use crate::json_rpc_socket_client::JsonRpcSocketClient;
use crate::managed_provider_connection::{AttachedProviderConnection, ManagedProviderConnection};
use crate::managed_structured_runtime::{conflict, error, launch_failed, safe_token, unavailable};
use crate::provider_credential_profile::provider_state_directory;
use crate::provider_turn_settings::ProviderTurnSettings;
use crate::structured_provider_runtime::{
    StructuredProviderRuntimeErrorKindV1 as ErrorKind, StructuredProviderRuntimeErrorV1 as Error,
};
use dure_app::{AgentIdV1, AgentInteractionBindingV1, AgentTimelineStore};

#[derive(serde::Deserialize)]
struct InstructionConfiguration {
    config: DeveloperInstructions,
}

#[derive(serde::Deserialize)]
struct DeveloperInstructions {
    developer_instructions: Option<String>,
    #[serde(default)]
    mcp_servers: std::collections::BTreeMap<String, serde_json::Value>,
}

/// Per-thread configuration overrides. Codex passes its own process
/// environment to MCP servers and tool shells only through configuration, so
/// the Agent identity reaches tool shells through the shell environment
/// policy, and the orchestration home reaches the installed Dure MCP server.
fn thread_config(agent_id: &AgentIdV1, orchestration_home: Option<&Path>) -> serde_json::Value {
    let mut config = serde_json::Map::new();
    config.insert(
        format!(
            "shell_environment_policy.set.{}",
            crate::structured_provider_runtime::AGENT_ID_ENVIRONMENT_KEY
        ),
        serde_json::Value::String(agent_id.to_string()),
    );
    if let Some(home) = orchestration_home {
        config.insert(
            "mcp_servers.dure-orchestration.env.DURE_ORCHESTRATION_HOME".into(),
            serde_json::json!(home),
        );
    }
    serde_json::Value::Object(config)
}

pub(crate) async fn attach<S: AgentTimelineStore + 'static>(
    binding: &AgentInteractionBindingV1,
    endpoint: &Path,
    cwd: &Path,
    expected_codex_home: Option<&Path>,
    settings: &ProviderTurnSettings,
    conversation_service: Arc<AgentConversationService<S>>,
) -> Result<AttachedProviderConnection, Error> {
    let (client, incoming) = JsonRpcSocketClient::connect(endpoint)
        .await
        .map_err(|_| launch_failed())?;
    let initialized = client
        .initialize_codex()
        .await
        .map_err(|_| launch_failed())?;
    let driver_thread_attach = supports_thread_attach(&initialized);
    if expected_codex_home.as_ref().is_some_and(|expected| {
        initialized
            .get("codexHome")
            .and_then(serde_json::Value::as_str)
            .map(Path::new)
            != Some(*expected)
    }) {
        return Err(error(
            ErrorKind::CredentialStale,
            "codex_app_server_credential_stale",
        ));
    }
    let account = client
        .request("account/read", serde_json::json!({ "refreshToken": false }))
        .await
        .map_err(|_| launch_failed())?;
    if account
        .get("account")
        .is_none_or(serde_json::Value::is_null)
        && account
            .get("requiresOpenaiAuth")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true)
    {
        return Err(error(
            ErrorKind::CredentialUnavailable,
            "codex_app_server_credential_unavailable",
        ));
    }
    let configuration = client
        .request(
            "config/read",
            serde_json::json!({ "cwd": cwd, "includeLayers": false }),
        )
        .await
        .map_err(|_| launch_failed())?;
    let configuration: InstructionConfiguration =
        serde_json::from_value(configuration).map_err(|_| launch_failed())?;
    let context = crate::agent_goal::tool_instructions(&binding.agent_id);
    let instructions = match configuration.config.developer_instructions {
        Some(existing) => format!("{existing}\n\n{context}"),
        None => context,
    };
    let (thread_method, mut thread_params) = match binding.provider_conversation_ref.as_deref() {
        Some(thread_id) => (
            "thread/resume",
            settings.thread_resume_params(thread_id, cwd),
        ),
        None => ("thread/start", settings.thread_start_params(cwd)),
    };
    thread_params["developerInstructions"] = serde_json::Value::String(instructions);
    let orchestration_home = conversation_service.backend_home().filter(|_| {
        configuration
            .config
            .mcp_servers
            .get("dure-orchestration")
            .and_then(|server| server.get("command"))
            .and_then(serde_json::Value::as_str)
            .is_some()
    });
    thread_params["config"] = thread_config(&binding.agent_id, orchestration_home);
    let response = if driver_thread_attach {
        client
            .request(
                THREAD_ATTACH_METHOD,
                thread_attach_params(thread_method, thread_params),
            )
            .await
    } else {
        client.request(thread_method, thread_params).await
    }
    .map_err(|_| launch_failed())?;
    if response
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .map(Path::new)
        != Some(cwd)
    {
        return Err(conflict());
    }
    let thread_id = response
        .pointer("/thread/id")
        .and_then(serde_json::Value::as_str)
        .filter(|thread_id| safe_token(thread_id))
        .ok_or_else(launch_failed)?
        .to_owned();
    if binding
        .provider_conversation_ref
        .as_ref()
        .is_some_and(|expected| expected != &thread_id)
    {
        return Err(conflict());
    }
    // The backend pages this thread's older history from the same home: the
    // credential profile's, or the provider's default.
    let provider_home = expected_codex_home
        .map(Path::to_path_buf)
        .or_else(|| provider_state_directory(&binding.provider_id, None));
    let bridge = Arc::new(
        CodexTimelineBridge::new(
            binding.clone(),
            client,
            thread_id,
            provider_home,
            settings.clone(),
            Arc::clone(&conversation_service),
        )
        .await
        .map_err(|_| unavailable())?,
    );
    let history = bridge
        .reconcile_history(response)
        .await
        .map_err(|_| unavailable())?;
    bridge
        .hydrate_active_turn(history.newest_turn())
        .await
        .map_err(|_| unavailable())?;
    bridge
        .record_session_ready()
        .await
        .map_err(|_| unavailable())?;
    let binding = conversation_service
        .binding(&binding.interaction_session_id)
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
    Ok(AttachedProviderConnection {
        binding,
        connection: bridge.clone(),
        commands: bridge.clone(),
        handler: bridge.spawn(incoming),
    })
}

impl<S: AgentTimelineStore + 'static> ManagedProviderConnection for CodexTimelineBridge<S> {
    fn is_connected(&self) -> bool {
        self.is_connected()
    }
    fn begin_idle_drain(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(self.begin_idle_drain())
    }
    fn cancel_drain(&self) {
        self.cancel_drain();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_config_gives_tool_shells_the_agent_id_and_the_mcp_server_its_home() {
        let agent_id = AgentIdV1::new("agent-coordinator").unwrap();
        assert_eq!(
            thread_config(&agent_id, None),
            serde_json::json!({
                "shell_environment_policy.set.DURE_AGENT_ID": "agent-coordinator",
            })
        );
        assert_eq!(
            thread_config(&agent_id, Some(Path::new("/home/dure"))),
            serde_json::json!({
                "shell_environment_policy.set.DURE_AGENT_ID": "agent-coordinator",
                "mcp_servers.dure-orchestration.env.DURE_ORCHESTRATION_HOME": "/home/dure",
            })
        );
    }
}
