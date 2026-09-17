use agent_orchestration::domain::graph::{
    WorkflowChangeRequest, WorkflowDefinition, WorkflowPutRequest, WorkflowTrigger,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::actions;
use crate::{BackendDispatchError, ServiceState};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Empty {
    schema_version: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Show {
    schema_version: u16,
    workflow_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Validate {
    schema_version: u16,
    definition: WorkflowDefinition,
    trigger: Option<WorkflowTrigger>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inspect {
    schema_version: u16,
    run_id: String,
    node_id: Option<String>,
}

pub(crate) async fn invoke(
    state: &ServiceState,
    method: &str,
    body: Value,
) -> Result<Value, BackendDispatchError> {
    if matches!(
        method,
        "workflow.graph.put"
            | "workflow.graph.activate"
            | "workflow.graph.pause"
            | "workflow.graph.run_once"
    ) && !state.is_mutation_authority()
    {
        return Err(BackendDispatchError::terminal("workflow_authority_changed"));
    }
    let now = crate::now_ms()
        .map_err(|_| BackendDispatchError::terminal("workflow_clock_unavailable"))?;
    match method {
        "workflow.graph.catalog" => {
            let body: Empty = parse(body)?;
            schema(body.schema_version)?;
            Ok(json!({"schemaVersion": 1, "actions": actions::contracts()}))
        }
        "workflow.graph.list" => {
            let body: Empty = parse(body)?;
            schema(body.schema_version)?;
            Ok(
                json!({"schemaVersion": 1, "workflows": state.store.workflow_summaries().await.map_err(store_error)?}),
            )
        }
        "workflow.graph.show" => {
            let body: Show = parse(body)?;
            schema(body.schema_version)?;
            let workflow = state
                .store
                .workflow_definition(&body.workflow_id)
                .await
                .map_err(store_error)?
                .ok_or_else(|| BackendDispatchError::terminal("workflow_not_found"))?;
            Ok(json!({"schemaVersion": 1, "workflow": workflow}))
        }
        "workflow.graph.put" => {
            let request: WorkflowPutRequest = parse(body)?;
            Ok(
                json!({"schemaVersion": 1, "workflow": state.store.put_workflow_definition(&request, now).await.map_err(store_error)?}),
            )
        }
        "workflow.graph.validate" => {
            let body: Validate = parse(body)?;
            schema(body.schema_version)?;
            if body
                .trigger
                .as_ref()
                .is_some_and(|trigger| validate_trigger(trigger).is_err())
            {
                return Ok(
                    json!({"schemaVersion": 1, "issues": [{"code": "workflow_trigger_invalid", "field": "trigger"}], "order": []}),
                );
            }
            Ok(match actions::compile(state, body.definition).await {
                Ok(graph) => {
                    json!({"schemaVersion": 1, "issues": [], "order": graph.order(), "digest": graph.digest()})
                }
                Err(issues) => json!({"schemaVersion": 1, "issues": issues, "order": []}),
            })
        }
        "workflow.graph.activate" => {
            let request: WorkflowChangeRequest = parse(body)?;
            if let Some(record) = state
                .store
                .workflow_activation_receipt(&request)
                .await
                .map_err(store_error)?
            {
                return Ok(json!({"schemaVersion": 1, "workflow": record}));
            }
            let record = state
                .store
                .workflow_definition(&request.workflow_id)
                .await
                .map_err(store_error)?
                .ok_or_else(|| BackendDispatchError::terminal("workflow_not_found"))?;
            validate_trigger(&record.trigger)?;
            let graph = actions::compile(state, record.definition)
                .await
                .map_err(|_| BackendDispatchError::terminal("workflow_validation_failed"))?;
            Ok(
                json!({"schemaVersion": 1, "workflow": state.store.activate_workflow_definition(&request, &graph, now).await.map_err(store_error)?}),
            )
        }
        "workflow.graph.pause" => {
            let request: WorkflowChangeRequest = parse(body)?;
            Ok(
                json!({"schemaVersion": 1, "workflow": state.store.pause_workflow_definition(&request, now).await.map_err(store_error)?}),
            )
        }
        "workflow.graph.run_once" => {
            let request: WorkflowChangeRequest = parse(body)?;
            if let Some(run) = state
                .store
                .manual_workflow_run_receipt(&request)
                .await
                .map_err(store_error)?
            {
                return Ok(json!({"schemaVersion": 1, "run": run}));
            }
            let record = state
                .store
                .workflow_definition(&request.workflow_id)
                .await
                .map_err(store_error)?
                .ok_or_else(|| BackendDispatchError::terminal("workflow_not_found"))?;
            let graph = actions::compile(state, record.definition)
                .await
                .map_err(|_| BackendDispatchError::terminal("workflow_validation_failed"))?;
            let run = state
                .store
                .start_manual_workflow_run(
                    &request,
                    &graph,
                    &actions::contracts(),
                    &state.descriptor.backend_id,
                    now,
                )
                .await
                .map_err(store_error)?;
            Ok(json!({"schemaVersion": 1, "run": run}))
        }
        "workflow.graph.runs" => {
            let body: Show = parse(body)?;
            schema(body.schema_version)?;
            Ok(
                json!({"schemaVersion": 1, "runs": state.store.workflow_run_summaries(&body.workflow_id).await.map_err(store_error)?}),
            )
        }
        "workflow.graph.inspect" => {
            let body: Inspect = parse(body)?;
            schema(body.schema_version)?;
            let (run, version) = state
                .store
                .workflow_run(&body.run_id)
                .await
                .map_err(store_error)?
                .ok_or_else(|| BackendDispatchError::terminal("workflow_run_not_found"))?;
            let selected = match body.node_id {
                Some(id) => run.tasks.iter().find(|task| task.node_id == id),
                None => run.tasks.first(),
            }
            .ok_or_else(|| BackendDispatchError::terminal("workflow_node_not_found"))?;
            let report = state
                .store
                .workflow_action_report(selected.dispatch_id.as_str())
                .await
                .map_err(store_error)?;
            let reports: Vec<_> = report.into_iter().map(|report| json!({"dispatchId": selected.dispatch_id, "reportDispatchId": report.report_dispatch_id, "completed": report.completed, "blockedBy": report.blocked_by})).collect();
            Ok(
                json!({"schemaVersion": 1, "run": run.summary(), "tasks": run.tasks.iter().map(|task| task.summary()).collect::<Vec<_>>(), "task": selected, "version": version, "reports": reports}),
            )
        }
        _ => Err(BackendDispatchError::terminal(
            "orchestration_method_unsupported",
        )),
    }
}

pub(super) fn parse<T: DeserializeOwned>(body: Value) -> Result<T, BackendDispatchError> {
    serde_json::from_value(body)
        .map_err(|_| BackendDispatchError::terminal("workflow_request_invalid"))
}
pub(super) fn schema(version: u16) -> Result<(), BackendDispatchError> {
    if version == 1 {
        Ok(())
    } else {
        Err(BackendDispatchError::terminal("workflow_request_invalid"))
    }
}
pub(super) fn validate_trigger(trigger: &WorkflowTrigger) -> Result<(), BackendDispatchError> {
    if let WorkflowTrigger::Schedule {
        expression,
        timezone,
    } = trigger
    {
        crate::schedule_runtime::validate_expression(expression, timezone)?;
    }
    Ok(())
}

pub(super) fn store_error(error: dure_app::DomainStoreErrorV1) -> BackendDispatchError {
    match error {
        dure_app::DomainStoreErrorV1::Storage {
            code: "workflow_contract_invalid",
            detail,
        } => BackendDispatchError::terminal(&detail),
        dure_app::DomainStoreErrorV1::Storage { code, .. } if code.starts_with("workflow_") => {
            BackendDispatchError::terminal(code)
        }
        _ => BackendDispatchError::from("workflow_store_unavailable"),
    }
}
