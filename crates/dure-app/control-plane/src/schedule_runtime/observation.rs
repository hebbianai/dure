//! Read-only projection of the current runtime authority. Launch acceptance,
//! Host attention and the retained Dispatch report remain separate facts.
use super::*;
use dure_app::{AgentRuntimeBindingAuthorityV1, AgentSpawnJournalStore, ScheduleLaunchStateV1};
use futures_util::{StreamExt, stream};

pub(super) async fn occurrences(
    state: &ServiceState,
    occurrences: &[ScheduleOccurrenceRecordV2],
) -> Value {
    // One shared budget bounds the whole history read, including stale Hosts.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
    let values: Vec<Value> = stream::iter(occurrences.to_vec())
        .map(|occurrence| async move {
            let mut value = json!(occurrence);
            if occurrence.launch_state != ScheduleLaunchStateV1::Started
                || occurrence.run.as_ref().is_some_and(|run| run.completed)
            {
                return value;
            }
            let observed = tokio::time::timeout_at(deadline, runtime(state, &occurrence))
                .await
                .unwrap_or(Err("schedule_runtime_observation_timeout"));
            let mut runtime =
                observed.unwrap_or_else(|code| json!({"state": "unavailable", "errorCode": code}));
            runtime["observedAtMs"] = json!(now_ms().unwrap_or(0));
            value["runtime"] = runtime;
            value
        })
        .buffered(8)
        .collect()
        .await;
    json!(values)
}

async fn runtime(
    state: &ServiceState,
    occurrence: &ScheduleOccurrenceRecordV2,
) -> Result<Value, &'static str> {
    let operation = OperationIdV1::new(
        occurrence
            .operation_id
            .clone()
            .ok_or("schedule_runtime_unbound")?,
    )
    .map_err(|_| "schedule_runtime_unbound")?;
    let spawn = state
        .store
        .agent_spawn_receipt(&operation)
        .await
        .map_err(|_| "schedule_runtime_unavailable")?
        .ok_or("schedule_runtime_unbound")?;
    let agent = &spawn.plan.agent_id;
    let _guard = state.agent_operations.acquire(agent).await;
    let crate::agent_runtime_projection::AgentRuntimeObservedV1::Stable {
        selection,
        authority,
    } = crate::agent_runtime_projection::read_locked(state, agent)
        .await
        .map_err(|_| "schedule_runtime_unavailable")?
    else {
        return Err("schedule_runtime_not_stable");
    };
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = *authority else {
        return Err("schedule_runtime_not_native");
    };
    let session = dure_app::WorkflowSessionGenerationV1 {
        session_id: authority.binding.session_id.clone(),
        workspace_id: authority.runtime_workspace_id.clone(),
        provider_id: selection.provider_id.clone(),
        runner_principal: authority.runner_principal.clone(),
        runner_instance: authority.runner_instance.clone(),
        channel_epoch: authority.channel_epoch.clone(),
        host_instance_id: authority.host_instance_id.clone(),
        terminal_epoch: authority.terminal_epoch.clone(),
    };
    let result = crate::query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &session.session_id,
        &session.workspace_id,
        &crate::authority_stop_fence(&authority),
    )
    .await;
    let observed = match result {
        Ok(observed) if observed.provider_id == session.provider_id.as_str() => observed,
        Ok(_) => return Err("hmux_descriptor_mismatch"),
        Err(error) => {
            return Ok(
                json!({"state": "unavailable", "session": session, "errorCode": error.code()}),
            );
        }
    };
    let Some(runtime) = observed.agent_runtime_state else {
        return Ok(
            json!({"state": "unavailable", "session": session, "errorCode": "hmux_agent_runtime_state_unavailable"}),
        );
    };
    Ok(json!({"state": "observed", "session": session,
        "lifecycle": runtime.lifecycle, "activity": runtime.activity, "attention": runtime.attention}))
}
