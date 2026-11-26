//! Read-only projection of the current runtime authority. Launch acceptance,
//! Host attention and the retained Dispatch report remain separate facts.
use super::*;
use crate::agent_runtime_projection::AgentRuntimeObservedV1;
use dure_app::{
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseStateV1, AgentSpawnJournalStore,
    ScheduleLaunchStateV1,
};
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
    agent_runtime(state, &spawn.plan.agent_id).await
}

/// The runtime state of one schedule-started agent, whichever interface it
/// runs on.
pub(crate) async fn agent_runtime(
    state: &ServiceState,
    agent: &dure_app::AgentIdV1,
) -> Result<Value, &'static str> {
    let _guard = state.agent_operations.acquire(agent).await;
    let (selection, authority) = match crate::agent_runtime_projection::read_locked(state, agent)
        .await
        .map_err(|_| "schedule_runtime_unavailable")?
    {
        AgentRuntimeObservedV1::Stable {
            selection,
            authority,
        } => (selection, authority),
        // Idle hibernation and stops are named, so a finished run does not
        // read as an unknown runtime. Older clients still see them as
        // unavailable.
        AgentRuntimeObservedV1::Transitioning { transition, .. } if transition.is_dormant() => {
            return Err("schedule_runtime_sleeping");
        }
        AgentRuntimeObservedV1::Closed { close, .. }
            if close.state == AgentRuntimeCloseStateV1::Stopped =>
        {
            return Err("schedule_runtime_stopped");
        }
        _ => return Err("schedule_runtime_not_stable"),
    };
    let authority = match *authority {
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => authority,
        // The chat runtime has no terminal session to probe. Its conversation
        // says whether a turn is running, waiting on a person or failed.
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            let page = super::conversation::read(state, &binding).await?;
            return Ok(json!({
                "state": "unavailable",
                "errorCode": "schedule_runtime_not_native",
                "conversation":
                    super::conversation::ConversationActivity::from_page(&page).observation(),
            }));
        }
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
