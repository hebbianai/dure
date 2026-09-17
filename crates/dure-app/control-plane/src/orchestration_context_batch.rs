use dure_app::{
    AgentIdV1, AgentRuntimeCloseStore, DomainStoreErrorV1, WorkflowSessionGenerationV1,
};
use dure_app_sqlite::{
    MAX_ORCHESTRATION_CONTEXT_BATCH_ITEMS, OrchestrationDispatchContextResolutionV1,
    OrchestrationDispatchGenerationV1,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    BackendDispatchError, BackendFailureDispositionV1, ServiceState, backend_error_body,
    dispatch_context_error, orchestration_store_error, verify_exact_orchestration_session,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestrationContextCandidateV1 {
    agent_id: AgentIdV1,
    session: WorkflowSessionGenerationV1,
    expected_dispatch: Option<OrchestrationDispatchGenerationV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestrationContextBatchGetBody {
    schema_version: u16,
    sessions: Option<Vec<WorkflowSessionGenerationV1>>,
    candidates: Option<Vec<OrchestrationContextCandidateV1>>,
}

#[derive(Clone, Debug)]
enum ContextCorrelationV1 {
    Legacy(WorkflowSessionGenerationV1),
    Candidate(OrchestrationContextCandidateV1),
}

impl ContextCorrelationV1 {
    fn session(&self) -> &WorkflowSessionGenerationV1 {
        match self {
            Self::Legacy(session) => session,
            Self::Candidate(candidate) => &candidate.session,
        }
    }
}

pub(super) async fn invoke(
    state: &ServiceState,
    value: Value,
) -> Result<Value, BackendDispatchError> {
    let body: OrchestrationContextBatchGetBody = serde_json::from_value(value)
        .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
    if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
        return Err(BackendDispatchError::terminal(
            "orchestration_request_invalid",
        ));
    }
    let correlations = correlations(body)?;
    resolve(state, correlations).await
}

fn correlations(
    body: OrchestrationContextBatchGetBody,
) -> Result<Vec<ContextCorrelationV1>, BackendDispatchError> {
    let correlations = match (body.sessions, body.candidates) {
        (Some(sessions), None) if valid_batch(&sessions, |left, right| left == right) => sessions
            .into_iter()
            .map(ContextCorrelationV1::Legacy)
            .collect(),
        (None, Some(candidates))
            if candidates.iter().all(|candidate| {
                candidate
                    .expected_dispatch
                    .as_ref()
                    .is_none_or(|expected| expected.generation >= 1)
            }) && valid_batch(&candidates, |left, right| left == right) =>
        {
            candidates
                .into_iter()
                .map(ContextCorrelationV1::Candidate)
                .collect()
        }
        _ => {
            return Err(BackendDispatchError::terminal(
                "orchestration_request_invalid",
            ));
        }
    };
    Ok(correlations)
}

fn valid_batch<T>(items: &[T], duplicate: impl Fn(&T, &T) -> bool) -> bool {
    !items.is_empty()
        && items.len() <= MAX_ORCHESTRATION_CONTEXT_BATCH_ITEMS
        && !items
            .iter()
            .enumerate()
            .any(|(index, item)| items[..index].iter().any(|prior| duplicate(prior, item)))
}

async fn resolve(
    state: &ServiceState,
    correlations: Vec<ContextCorrelationV1>,
) -> Result<Value, BackendDispatchError> {
    let mut sessions = Vec::with_capacity(correlations.len());
    for correlation in &correlations {
        if !sessions.contains(correlation.session()) {
            sessions.push(correlation.session().clone());
        }
    }
    let items = state
        .store
        .orchestration_dispatch_contexts_for_exact_sessions(&sessions)
        .await
        .map_err(dispatch_context_error)?;
    if items.len() != sessions.len()
        || sessions
            .iter()
            .zip(&items)
            .any(|(expected, item)| expected != &item.session)
    {
        return Err(BackendDispatchError::from("orchestration_receipt_invalid"));
    }

    let mut results = Vec::with_capacity(correlations.len());
    for correlation in correlations {
        let item = items
            .iter()
            .find(|item| &item.session == correlation.session())
            .ok_or_else(|| BackendDispatchError::from("orchestration_receipt_invalid"))?;
        let result = match &item.resolution {
            OrchestrationDispatchContextResolutionV1::Found(context) => correlated_result(
                &correlation,
                "found",
                "context",
                serde_json::to_value(context)
                    .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))?,
            ),
            OrchestrationDispatchContextResolutionV1::NoDispatch => {
                let error = no_dispatch_context_error(state, &correlation).await;
                correlated_result(&correlation, "failed", "error", backend_error_body(error))
            }
            OrchestrationDispatchContextResolutionV1::DomainError(error) => correlated_result(
                &correlation,
                "failed",
                "error",
                backend_error_body(dispatch_context_error(error.clone())),
            ),
        };
        results.push(result);
    }
    Ok(json!({
        "schemaVersion": agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        "results": results,
    }))
}

fn correlated_result(
    correlation: &ContextCorrelationV1,
    outcome: &str,
    payload_name: &str,
    payload: Value,
) -> Value {
    let mut result = serde_json::Map::new();
    result.insert("outcome".into(), json!(outcome));
    match correlation {
        ContextCorrelationV1::Legacy(session) => {
            result.insert("session".into(), json!(session));
        }
        ContextCorrelationV1::Candidate(candidate) => {
            result.insert("candidate".into(), candidate_value(candidate));
        }
    }
    result.insert(payload_name.into(), payload);
    Value::Object(result)
}

fn candidate_value(candidate: &OrchestrationContextCandidateV1) -> Value {
    let mut value = json!({
        "agentId": candidate.agent_id,
        "session": candidate.session,
    });
    if let Some(expected) = &candidate.expected_dispatch {
        value["expectedDispatch"] = json!({
            "taskId": expected.task_id,
            "dispatchId": expected.dispatch_id,
            "generation": expected.generation,
        });
    }
    value
}

async fn no_dispatch_context_error(
    state: &ServiceState,
    correlation: &ContextCorrelationV1,
) -> BackendDispatchError {
    let session = correlation.session();
    if let Err(error) = verify_exact_orchestration_session(state, session).await {
        return error;
    }
    if let ContextCorrelationV1::Candidate(OrchestrationContextCandidateV1 {
        agent_id,
        expected_dispatch: Some(expected_dispatch),
        ..
    }) = correlation
    {
        let reporting_agent = match state
            .store
            .orchestration_reporting_agent_for_exact_dispatch(expected_dispatch)
            .await
            .map_err(orchestration_store_error)
        {
            Ok(Some(reporting_agent)) if &reporting_agent == agent_id => reporting_agent,
            Ok(Some(_)) => {
                return BackendDispatchError::terminal("orchestration_request_invalid");
            }
            Ok(None) => return unassigned(session),
            Err(error) => return error,
        };
        let close = {
            let _guard = state.agent_operations.acquire(&reporting_agent).await;
            state
                .store
                .effective_agent_runtime_close(&reporting_agent)
                .await
                .map_err(orchestration_store_error)
        };
        match close {
            Ok(Some(_)) => {
                return BackendDispatchError::terminal("orchestration_reporting_unavailable");
            }
            Ok(None) => {}
            Err(error) => return error,
        }
    }
    unassigned(session)
}

fn unassigned(session: &WorkflowSessionGenerationV1) -> BackendDispatchError {
    dispatch_context_error(DomainStoreErrorV1::IdentityConflict {
        entity: "orchestration_session_fence",
        id: session.session_id.clone(),
        reason: "the exact Session generation must resolve to one active or completed Dispatch"
            .into(),
    })
    .with_disposition(BackendFailureDispositionV1::Unassigned)
}
