//! Native input and final responses use the selected runtime, independently of a GUI.
use super::*;
use agent_runtime_projection::{AgentRuntimeObservedV1, read_locked};
use dure_app::{AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1};
use dure_provider_profile::transcript;
use hmux_client::{
    LocalSessionCatalog, ProviderConversationIdentitySeed, SessionFence, TerminalSurfaceAttachment,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u16,
    agent_id: AgentIdV1,
    expected_selection_revision: i64,
    expected_terminal_epoch: String,
    #[serde(default)]
    after: Option<Value>,
    #[serde(default)]
    text: Option<String>,
}

pub(super) async fn dispatch(
    state: &ServiceState,
    request: &BackendRequest,
) -> Result<Value, BackendDispatchError> {
    let body: Request = serde_json::from_value(request.body.clone())
        .map_err(|_| "agent_runtime_native_request_invalid")?;
    let input = request.operation == "agent_runtime.native.input";
    if body.schema_version != 1
        || body.expected_selection_revision < 1
        || !valid_token(&body.expected_terminal_epoch)
        || (input
            && (body.after.is_some()
                || body.text.as_ref().is_none_or(|text| {
                    text.is_empty() || text.len() > 64 * 1024 || text.contains('\0')
                })))
        || (!input && body.text.is_some())
    {
        return Err("agent_runtime_native_request_invalid".into());
    }
    let _guard = state.agent_operations.acquire(&body.agent_id).await;
    let AgentRuntimeObservedV1::Stable {
        selection,
        authority,
    } = read_locked(state, &body.agent_id).await?
    else {
        return Err("agent_runtime_native_changed".into());
    };
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = *authority else {
        return Err("agent_runtime_native_changed".into());
    };
    if selection.revision != body.expected_selection_revision
        || authority.terminal_epoch != body.expected_terminal_epoch
        || authority.binding.agent_id != body.agent_id
    {
        return Err("agent_runtime_native_changed".into());
    }
    if input {
        return send(state, &selection, &authority, body.text.as_deref().unwrap()).await;
    }
    read(state, &selection, &authority, body.after.as_ref()).await
}

async fn send(
    state: &ServiceState,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
    text: &str,
) -> Result<Value, BackendDispatchError> {
    let fence = SessionFence {
        workspace_id: authority.runtime_workspace_id.clone(),
        session_id: authority.binding.session_id.clone(),
        runner_principal: authority.runner_principal.clone(),
        runner_instance: authority.runner_instance.clone(),
        channel_epoch: authority
            .channel_epoch
            .parse()
            .map_err(|_| "agent_runtime_native_changed")?,
        host_instance_id: authority.host_instance_id.clone(),
        terminal_epoch: authority.terminal_epoch.clone(),
    };
    let expected = ProviderConversationIdentitySeed::new(
        selection.provider_id.as_str(),
        authority
            .binding
            .provider_conversation_id
            .as_deref()
            .ok_or("agent_runtime_native_conversation_missing")?,
    )
    .map_err(|_| "agent_runtime_native_conversation_missing")?;
    let root = state.hmux_identity.discovery_root.clone();
    let text = text.to_owned();
    tokio::task::spawn_blocking(move || {
        let catalog = LocalSessionCatalog::new(root);
        let mut surface = TerminalSurfaceAttachment::connect_local_agent_prompt(&catalog, &fence)
            .map_err(|error| BackendDispatchError::from(error.code()))?;
        // Host admission and the single body+submit write share one transaction.
        // Raw PTY writes can be lost while a provider initializes its terminal.
        let delivery = surface.send_existing_idle_agent_prompt_confirmed(
            text,
            &expected,
            std::time::Duration::from_secs(30),
        );
        let result = delivery
            .map_err(|error| BackendDispatchError::from(error.code()))
            .map(|receipt| {
                json!({ "schemaVersion": 1, "receipt": {
                "terminalEpoch": receipt.terminal_epoch(),
                "state": "written_to_pty",
                "recordId": receipt.input().in_reply_to_record_id.to_string(),
            } })
            });
        let _ = surface.detach();
        result
    })
    .await
    .map_err(|_| "agent_runtime_native_input_unconfirmed")?
}

async fn read(
    state: &ServiceState,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
    after: Option<&Value>,
) -> Result<Value, BackendDispatchError> {
    let observed = query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &authority.binding.session_id,
        &authority.runtime_workspace_id,
        &authority_stop_fence(authority),
    )
    .await
    .map_err(|error| error.code())?;
    if observed.provider_id != selection.provider_id.as_str() {
        return Err("agent_runtime_native_changed".into());
    }
    let conversation = observed
        .provider_conversation_identity
        .as_ref()
        .map(|identity| identity.conversation_id.as_str());
    let count = observed.turn_completed_count().unwrap_or(0);
    let cursor = json!({ "terminalEpoch": authority.terminal_epoch,
        "turnCompletedCount": count.to_string(), "conversationId": conversation });
    let mut final_response = None;
    // Read provider history only for a newly completed native turn. In
    // particular, switching from chat must not republish an older answer.
    if count > 0 && after != Some(&cursor) && observed.is_agent_quiescent() {
        if let Some(conversation) = conversation {
            let resolved = state
                .credential_profiles
                .resolve(&selection.provider_id, &selection.execution_profile)
                .await
                .map_err(|error| error.code())?;
            let provider = selection.provider_id.as_str().to_owned();
            let home = resolved
                .map(|profile| profile.directory().to_path_buf())
                .or_else(|| {
                    std::env::var_os("HOME")
                        .map(PathBuf::from)
                        .map(|home| home.join(format!(".{provider}")))
                })
                .ok_or("agent_runtime_native_history_unavailable")?;
            let conversation = conversation.to_owned();
            final_response = tokio::task::spawn_blocking(move || {
                transcript::read_roots(
                    &home.join("projects"),
                    &home.join("sessions"),
                    &provider,
                    &conversation,
                )
                .map(|transcript| transcript.final_response)
            })
            .await
            .map_err(|_| "agent_runtime_native_history_unavailable")?
            .map_err(|_| "agent_runtime_native_history_unavailable")?;
        }
    }
    Ok(json!({ "schemaVersion": 1, "cursor": cursor,
        "waiting": observed.is_agent_quiescent(), "exited": observed.is_exited_exact(),
        "finalResponse": final_response }))
}
