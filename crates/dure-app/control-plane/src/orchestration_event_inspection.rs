use agent_orchestration::contract::{DeliveryState, InspectEventsRequest, ReadEventsRequest};
use agent_orchestration::domain::EventCursor;
use dure_app::WorkflowSessionGenerationV1;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    BackendDispatchError, ServiceState, control_plane_build_id, exact_orchestration_context,
    orchestration_service_error,
};

const OBSERVATION_API_VERSION: &str = "dure.orchestration-event-observation/v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectExactSessionRequest {
    schema_version: u16,
    session: WorkflowSessionGenerationV1,
    after: EventCursor,
    limit: usize,
}

pub(super) async fn inspect_exact_session(
    state: &ServiceState,
    body: Value,
) -> Result<Value, BackendDispatchError> {
    let request: InspectExactSessionRequest = serde_json::from_value(body)
        .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
    if request.schema_version != 1 || request.limit == 0 || request.limit > 128 {
        return Err(BackendDispatchError::terminal(
            "orchestration_request_invalid",
        ));
    }
    let context = exact_orchestration_context(state, &request.session).await?;
    let query = InspectEventsRequest::try_from(ReadEventsRequest {
        schema_version: request.schema_version,
        authority: context.target.authority.clone(),
        target: Some(context.target.clone()),
        participant: context.participant.clone(),
        delivery_capability: context.delivery_capability.clone(),
        endpoint_fence: Some(context.endpoint_fence.clone()),
        after: request.after,
        acknowledgement: None,
        limit: request.limit,
    })
    .map_err(|error| orchestration_service_error(error.into()))?;
    let receipt = state
        .store
        .interaction_service()
        .inspect_events(query)
        .await
        .map_err(orchestration_service_error)?;
    let count = |expected| {
        receipt
            .deliveries
            .iter()
            .filter(|delivery| delivery.state == expected)
            .count()
    };
    Ok(json!({
        "schemaVersion": 1,
        "apiVersion": OBSERVATION_API_VERSION,
        "kind": "dure.orchestration_event_observation",
        "backendBuildId": control_plane_build_id(),
        "backendGeneration": state.descriptor.generation,
        "sessionIdentity": context.endpoint_fence.session_identity,
        "dispatchId": context.target.dispatch_id,
        "generation": context.target.generation,
        "after": request.after,
        "nextCursor": receipt.next_cursor,
        "eventCount": receipt.events.len(),
        "deliveryStates": {
            "queued": count(DeliveryState::Queued),
            "observed": count(DeliveryState::Observed),
            "acknowledged": count(DeliveryState::Acknowledged),
        },
        "observation": if receipt.events.is_empty() { "empty" } else { "events_available" },
    }))
}

pub(super) async fn read(state: &ServiceState, body: Value) -> Result<Value, BackendDispatchError> {
    let request: ReadEventsRequest = serde_json::from_value(body)
        .map_err(|_| BackendDispatchError::from("orchestration_request_invalid"))?;
    serde_json::to_value(
        state
            .store
            .interaction_service()
            .read_events(request)
            .await
            .map_err(orchestration_service_error)?,
    )
    .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))
}
