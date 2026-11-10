//! Maps a native runtime Session back to the Agents whose current binding
//! names it, so a client that lost its own Agent list can still select the
//! Agent of a live Session. Identity only: the Host stays the liveness
//! authority and callers re-read the Agent's runtime projection before acting.
use super::*;

pub(super) const OPERATION: &str = "agent_runtime.native_session.resolve.v1";
const HMUX_RUNTIME_KIND: &str = "runtime.hmux";
/// A Session has one owner per exact generation; more rows are legacy
/// duplicates, reported as incomplete instead of being paged.
const MAX_SESSION_OWNERS: u32 = 8;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeSessionResolveBodyV1 {
    schema_version: u16,
    session_id: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

pub(super) async fn resolve(
    state: &ServiceState,
    body: NativeSessionResolveBodyV1,
) -> Result<serde_json::Value, String> {
    if body.schema_version != 1
        || !valid_token(&body.session_id)
        || body
            .workspace_id
            .as_deref()
            .is_some_and(|workspace_id| !valid_token(workspace_id))
    {
        return Err("agent_runtime_native_session_resolve_request_invalid".into());
    }
    let runtime_kind = RuntimeKindIdV1::new(HMUX_RUNTIME_KIND)
        .map_err(|_| "agent_runtime_native_session_resolve_failed".to_string())?;
    let mut owners = state
        .store
        .session_binding_authorities(
            &runtime_kind,
            &body.session_id,
            body.workspace_id.as_deref(),
            MAX_SESSION_OWNERS + 1,
        )
        .await
        .map_err(|_| "agent_runtime_native_session_resolve_failed".to_string())?;
    let complete = owners.len() <= MAX_SESSION_OWNERS as usize;
    owners.truncate(MAX_SESSION_OWNERS as usize);
    Ok(json!({
        "schemaVersion": 1,
        "sessionId": body.session_id,
        "workspaceId": body.workspace_id,
        "agents": owners
            .iter()
            .map(|authority| json!({
                "agentId": authority.binding.agent_id,
                "workspaceId": authority.runtime_workspace_id,
                "bindingGeneration": authority.binding.binding_generation,
            }))
            .collect::<Vec<_>>(),
        "complete": complete,
    }))
}
