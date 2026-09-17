use std::collections::HashMap;
use std::sync::Arc;

use agent_orchestration::domain::graph::{ActionState, ExecutingWorkflow, WorkflowTrigger};
use tokio::task::JoinSet;
use tokio::time::{Duration, MissedTickBehavior};

use super::{actions, agent, command, definitions::store_error};
use crate::{BackendDispatchError, ServiceState};

pub(crate) async fn run_loop(state: Arc<ServiceState>) {
    let Ok(owner) = crate::random_opaque_reference("workflow-executor") else {
        return;
    };
    let mut interval = tokio::time::interval(Duration::from_secs(3));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut workers = JoinSet::new();
    let mut active = HashMap::new();
    loop {
        tokio::select! {
            result = workers.join_next_with_id(), if !workers.is_empty() => {
                match result {
                    Some(Ok((id, ()))) => { active.remove(&id); },
                    Some(Err(error)) => { active.remove(&error.id()); },
                    None => {},
                }
            },
            _ = interval.tick() => {
                if !state.is_mutation_authority() { continue; }
                let Ok(now) = crate::now_ms() else { continue };
                let _ = admit_schedules(&state, now).await;
                let Ok(ids) = state.store.active_workflow_run_ids().await else { continue };
                for id in ids {
                    if workers.len() >= 4 { break; }
                    if active.values().any(|current| current == &id) { continue; }
                    let state = Arc::clone(&state);
                    let owner = owner.clone();
                    let run_id = id.clone();
                    let worker = workers.spawn(async move {
                        let _ = advance(&state, &run_id, &owner).await;
                    });
                    active.insert(worker.id(), id);
                }
            }
        }
    }
}

pub(crate) async fn admit_schedules(
    state: &ServiceState,
    now: i64,
) -> Result<(), BackendDispatchError> {
    let minute = now - now.rem_euclid(60_000);
    for record in state
        .store
        .workflow_summaries()
        .await
        .map_err(store_error)?
    {
        if !record.enabled {
            continue;
        }
        let Some(number) = record.active_version else {
            continue;
        };
        let Some(version) = state
            .store
            .workflow_version(&record.workflow_id, number)
            .await
            .map_err(store_error)?
        else {
            continue;
        };
        let WorkflowTrigger::Schedule {
            expression,
            timezone,
        } = version.trigger
        else {
            continue;
        };
        if !crate::schedule_runtime::expression_is_due(&expression, &timezone, minute)? {
            continue;
        }
        state
            .store
            .claim_scheduled_workflow_run(
                &record.workflow_id,
                number,
                minute,
                &actions::contracts(),
                &state.descriptor.backend_id,
                now,
            )
            .await
            .map_err(store_error)?;
    }
    Ok(())
}

/// One step uses the same stored version for scheduled runs and Run once. Only
/// this detached service loop executes effects; editor requests only admit Runs.
pub(crate) async fn advance(
    state: &ServiceState,
    run_id: &str,
    owner: &str,
) -> Result<(), BackendDispatchError> {
    if !state.is_mutation_authority() {
        return Err(BackendDispatchError::terminal("workflow_authority_changed"));
    }
    let Some((run, version)) = state
        .store
        .workflow_run(run_id)
        .await
        .map_err(store_error)?
    else {
        return Ok(());
    };
    let mut execution = ExecutingWorkflow::restore(&version, &actions::contracts(), run)
        .map_err(|_| BackendDispatchError::terminal("workflow_run_invalid"))?;
    let now =
        crate::now_ms().map_err(|_| BackendDispatchError::from("workflow_clock_unavailable"))?;
    let started = execution
        .run()
        .tasks
        .iter()
        .find(|task| matches!(task.state, ActionState::Started { .. }))
        .cloned();
    let task = if let Some(task) = started {
        if task.action.action_id == "command" {
            // There is no retained process result. The old command may have had
            // effects; another executor must never assume it is safe to repeat.
            let prior = execution.run().clone();
            execution
                .fail(
                    &task.dispatch_id,
                    "command_result_unavailable",
                    true,
                    None,
                    now,
                )
                .map_err(|_| BackendDispatchError::terminal("workflow_run_invalid"))?;
            state
                .store
                .update_workflow_run(&prior, &execution)
                .await
                .map_err(store_error)?;
            return Ok(());
        }
        task
    } else {
        let prior = execution.run().clone();
        let Some(task) = execution
            .start_next(owner, now)
            .map_err(|_| BackendDispatchError::terminal("workflow_run_invalid"))?
            .cloned()
        else {
            return Ok(());
        };
        state
            .store
            .update_workflow_run(&prior, &execution)
            .await
            .map_err(store_error)?;
        task
    };
    if !state.is_mutation_authority() {
        return Err(BackendDispatchError::terminal("workflow_authority_changed"));
    }
    let result = match task.action.action_id.as_str() {
        "command" => {
            let ActionState::Started { inputs, .. } = &task.state else {
                return Err(BackendDispatchError::terminal("workflow_run_invalid"));
            };
            match actions::command_directory(state, inputs).await {
                Some(directory) => command::execute(inputs, &directory).await.map(Some),
                None => Err(command::ActionFailure {
                    code: "command_directory_invalid",
                    uncertain: false,
                    outputs: None,
                }),
            }
        }
        "agent" => agent::execute(state, &mut execution, &task).await,
        _ => {
            return Err(BackendDispatchError::terminal(
                "workflow_action_unsupported",
            ));
        }
    };
    if !state.is_mutation_authority() {
        return Err(BackendDispatchError::terminal("workflow_authority_changed"));
    }
    let now =
        crate::now_ms().map_err(|_| BackendDispatchError::from("workflow_clock_unavailable"))?;
    let prior = execution.run().clone();
    match result {
        Ok(None) => return Ok(()),
        Ok(Some(outputs)) => {
            if execution.complete(&task.dispatch_id, outputs, now).is_err() {
                execution
                    .fail(&task.dispatch_id, "action_output_invalid", false, None, now)
                    .map_err(|_| BackendDispatchError::terminal("workflow_run_invalid"))?;
            }
        }
        Err(failure) => {
            if execution
                .fail(
                    &task.dispatch_id,
                    failure.code,
                    failure.uncertain,
                    failure.outputs,
                    now,
                )
                .is_err()
            {
                execution
                    .fail(
                        &task.dispatch_id,
                        "action_output_invalid",
                        failure.uncertain,
                        None,
                        now,
                    )
                    .map_err(|_| BackendDispatchError::terminal("workflow_run_invalid"))?;
            }
        }
    }
    state
        .store
        .update_workflow_run(&prior, &execution)
        .await
        .map_err(store_error)?;
    Ok(())
}
