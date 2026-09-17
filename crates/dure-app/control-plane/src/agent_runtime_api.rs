//! Runtime lifecycle routes share application authority across CLI and desktop.
use super::*;

pub(super) async fn dispatch(
    state: &ServiceState,
    request: &BackendRequest,
) -> Result<serde_json::Value, BackendDispatchError> {
    match request.operation.as_str() {
        "agent_runtime.idle.inspect" => {
            if request.body != json!({"schemaVersion": 1}) {
                return Err("runtime_idle_inspect_request_invalid".into());
            }
            serde_json::to_value(state.runtime_idle.inspect_with_outcomes(state).await)
                .map_err(|_| "runtime_idle_inspect_response_invalid".into())
        }
        "agent_runtime.idle.configure" => {
            let body = serde_json::from_value(request.body.clone())
                .map_err(|_| "runtime_idle_configure_request_invalid".to_string())?;
            serde_json::to_value(state.runtime_idle.configure(state, body).await?)
                .map_err(|_| "runtime_idle_configure_response_invalid".into())
        }
        "agent_runtime.transition" => {
            let body: agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "agent_runtime_transition_request_invalid".to_string())?;
            let receipt =
                agent_runtime_transition_apply::apply(state, &request.request_id, body).await?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        "agent_runtime.repair" => {
            let body: agent_runtime_transition_apply::AgentRuntimeRepairApplyBodyV1 =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "agent_runtime_repair_request_invalid".to_string())?;
            let receipt =
                agent_runtime_transition_apply::repair(state, &request.request_id, body).await?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        "agent_runtime.repair_intent.inspect.v1" => {
            let body: agent_runtime_transition_apply::AgentRuntimeRepairIntentInspectBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    "agent_runtime_repair_intent_inspect_request_invalid".to_string()
                })?;
            let observation =
                agent_runtime_transition_apply::inspect_repair_intent(state, body).await?;
            serde_json::to_value(observation)
                .map_err(|_| "agent_runtime_repair_intent_inspect_response_invalid".into())
        }
        "agent_runtime.inspect" => {
            let body: agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "agent_runtime_inspect_request_invalid".to_string())?;
            let observation = agent_runtime_transition_apply::inspect(state, body).await?;
            serde_json::to_value(observation)
                .map_err(|_| "agent_runtime_inspect_response_invalid".into())
        }
        "agent_runtime.projection.inspect" => {
            let body: agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "agent_runtime_projection_inspect_request_invalid".to_string())?;
            let observation =
                agent_runtime_transition_apply::inspect_projection(state, body).await?;
            serde_json::to_value(observation)
                .map_err(|_| "agent_runtime_projection_inspect_response_invalid".into())
        }
        "agent_runtime.native_rehost.reconcile" => {
            let body: agent_runtime_native_rehost::request::RequestV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::terminal("agent_runtime_native_rehost_request_invalid")
                })?;
            let receipt = agent_runtime_native_rehost::request::apply(state, body).await?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        "agent_runtime.native_resume.publish" => {
            let body: agent_runtime_native_rehost::AgentRuntimeNativeResumeBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::terminal("agent_runtime_native_resume_request_invalid")
                })?;
            let receipt = agent_runtime_native_rehost::apply_resume(state, body).await?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        "agent_runtime.stop" | "agent_runtime.remove" => {
            let body: agent_runtime_close_apply::AgentRuntimeStopBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::terminal("agent_runtime_stop_request_invalid")
                })?;
            if request.operation == "agent_runtime.remove" {
                agent_runtime_remove_apply::apply(state, &request.request_id, body).await
            } else {
                agent_runtime_close_apply::apply(state, &request.request_id, body).await
            }
        }
        "agent_runtime.hibernate" => {
            let body = serde_json::from_value(request.body.clone())
                .map_err(|_| "agent_runtime_hibernate_request_invalid".to_string())?;
            let observation = agent_runtime_transition_apply::deferred::hibernate(
                state,
                &request.request_id,
                body,
            )
            .await?;
            serde_json::to_value(observation)
                .map_err(|_| "agent_runtime_hibernate_response_invalid".into())
        }
        "agent_runtime.wake" => {
            let body = serde_json::from_value(request.body.clone())
                .map_err(|_| "agent_runtime_wake_request_invalid".to_string())?;
            let observation =
                agent_runtime_transition_apply::deferred::wake(state, &request.request_id, body)
                    .await?;
            serde_json::to_value(observation)
                .map_err(|_| "agent_runtime_wake_response_invalid".into())
        }
        _ => Err("backend_operation_unavailable".into()),
    }
}
