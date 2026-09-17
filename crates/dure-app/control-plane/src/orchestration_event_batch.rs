use std::collections::BTreeSet;

use agent_orchestration::contract::{
    MAX_READ_EVENTS_BATCH_ITEMS, ReadEventsBatchItemOutcome, ReadEventsBatchReceipt,
    ReadEventsBatchRequest, ServiceError,
};
use agent_orchestration::domain::AuthorityScope;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    BackendDispatchError, BackendFailureDispositionV1, ServiceState, backend_error_body,
    orchestration_service_error,
};

const ROUTE_BATCH_SCHEMA_VERSION: u16 = 1;
const MAX_CORRELATION_ID_BYTES: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RouteBatchRequest {
    schema_version: u16,
    batches: Vec<RouteBatchItemRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RouteBatchItemRequest {
    correlation_id: String,
    request: ReadEventsBatchRequest,
}

impl RouteBatchRequest {
    fn parse(body: Value) -> Result<Self, BackendDispatchError> {
        let request: Self = serde_json::from_value(body)
            .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), BackendDispatchError> {
        if self.schema_version != ROUTE_BATCH_SCHEMA_VERSION
            || self.batches.is_empty()
            || self.batches.len() > MAX_READ_EVENTS_BATCH_ITEMS
        {
            return Err(BackendDispatchError::terminal(
                "orchestration_request_invalid",
            ));
        }

        let mut outer_correlations = BTreeSet::new();
        let mut leaf_correlations = BTreeSet::new();
        let mut authorities: Vec<&AuthorityScope> = Vec::with_capacity(self.batches.len());
        let mut leaf_count = 0usize;
        for batch in &self.batches {
            if !valid_correlation_id(&batch.correlation_id)
                || !outer_correlations.insert(batch.correlation_id.as_str())
                || authorities.contains(&&batch.request.authority)
            {
                return Err(BackendDispatchError::terminal(
                    "orchestration_request_invalid",
                ));
            }
            authorities.push(&batch.request.authority);
            leaf_count = leaf_count
                .checked_add(batch.request.requests.len())
                .ok_or_else(|| BackendDispatchError::terminal("orchestration_request_invalid"))?;
            if leaf_count > MAX_READ_EVENTS_BATCH_ITEMS
                || batch
                    .request
                    .requests
                    .iter()
                    .any(|item| !leaf_correlations.insert(item.correlation_id.as_str()))
            {
                return Err(BackendDispatchError::terminal(
                    "orchestration_request_invalid",
                ));
            }
        }
        if leaf_count == 0 {
            return Err(BackendDispatchError::terminal(
                "orchestration_request_invalid",
            ));
        }
        Ok(())
    }
}

fn valid_correlation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CORRELATION_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

pub(super) async fn invoke(
    state: &ServiceState,
    body: Value,
) -> Result<Value, BackendDispatchError> {
    let request: ReadEventsBatchRequest = serde_json::from_value(body)
        .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
    let receipt = state
        .store
        .interaction_service()
        .read_events_batch(request)
        .await
        .map_err(|error| {
            let invalid = matches!(&error, ServiceError::Invalid { .. });
            let error = orchestration_service_error(error);
            if invalid {
                error.with_disposition(BackendFailureDispositionV1::Terminal)
            } else {
                error
            }
        })?;
    Ok(batch_receipt_value(receipt))
}

pub(super) async fn invoke_route(
    state: &ServiceState,
    body: Value,
) -> Result<Value, BackendDispatchError> {
    let request = RouteBatchRequest::parse(body)?;
    let service = state.store.interaction_service();
    let mut results = Vec::with_capacity(request.batches.len());
    for batch in request.batches {
        let authority = batch.request.authority.clone();
        let result = match service.read_events_batch(batch.request).await {
            Ok(receipt) => json!({
                "outcome": "read",
                "correlationId": batch.correlation_id,
                "receipt": batch_receipt_value(receipt),
            }),
            Err(error) => {
                let invalid = matches!(&error, ServiceError::Invalid { .. });
                let mut error = orchestration_service_error(error);
                if invalid {
                    error = error.with_disposition(BackendFailureDispositionV1::Terminal);
                }
                json!({
                    "outcome": "failed",
                    "correlationId": batch.correlation_id,
                    "authority": authority,
                    "error": backend_error_body(error),
                })
            }
        };
        results.push(result);
    }
    Ok(json!({
        "schemaVersion": ROUTE_BATCH_SCHEMA_VERSION,
        "results": results,
    }))
}

fn batch_receipt_value(receipt: ReadEventsBatchReceipt) -> Value {
    let results = receipt
        .results
        .into_iter()
        .map(|item| match item.outcome {
            ReadEventsBatchItemOutcome::Read(receipt) => json!({
                "outcome": "read",
                "correlationId": item.correlation_id,
                "receipt": receipt,
            }),
            ReadEventsBatchItemOutcome::Failed(error) => json!({
                "outcome": "failed",
                "correlationId": item.correlation_id,
                "error": backend_error_body(orchestration_service_error(error)),
            }),
        })
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": receipt.schema_version,
        "authority": receipt.authority,
        "results": results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(authority: &str, outer_correlation: &str, leaf_correlations: &[String]) -> Value {
        json!({
            "correlationId": outer_correlation,
            "request": {
                "schemaVersion": 1,
                "authority": { "workspaceId": authority },
                "requests": leaf_correlations.iter().map(|correlation_id| json!({
                    "correlationId": correlation_id,
                    "request": {
                        "schemaVersion": 1,
                        "authority": { "workspaceId": authority },
                        "participant": "participant-route-batch",
                        "deliveryCapability": "capability-route-batch",
                        "after": 0,
                        "limit": 1
                    }
                })).collect::<Vec<_>>()
            }
        })
    }

    #[test]
    fn route_batch_envelope_enforces_bounded_unique_authority_composition() {
        let leaf_a = vec!["leaf-a".to_string()];
        let leaf_b = vec!["leaf-b".to_string()];
        RouteBatchRequest::parse(json!({
            "schemaVersion": 1,
            "batches": [
                batch("workspace-a", "outer-a", &leaf_a),
                batch("workspace-b", "outer-b", &leaf_b)
            ]
        }))
        .unwrap();

        let thirty_two = (0..32)
            .map(|index| format!("leaf-{index}"))
            .collect::<Vec<_>>();
        let invalid = [
            json!({ "schemaVersion": 1, "batches": [] }),
            json!({
                "schemaVersion": 1,
                "batches": [
                    batch("workspace-a", "outer-same", &leaf_a),
                    batch("workspace-b", "outer-same", &leaf_b)
                ]
            }),
            json!({
                "schemaVersion": 1,
                "batches": [
                    batch("workspace-a", "outer-a", &leaf_a),
                    batch("workspace-a", "outer-b", &leaf_b)
                ]
            }),
            json!({
                "schemaVersion": 1,
                "batches": [
                    batch("workspace-a", "outer-a", &leaf_a),
                    batch("workspace-b", "outer-b", &leaf_a)
                ]
            }),
            json!({
                "schemaVersion": 1,
                "batches": [
                    batch("workspace-a", "outer-a", &thirty_two),
                    batch("workspace-b", "outer-b", &leaf_b)
                ]
            }),
            json!({
                "schemaVersion": 1,
                "batches": [batch("workspace-a", "outer/invalid", &leaf_a)]
            }),
        ];
        for body in invalid {
            let error = RouteBatchRequest::parse(body).unwrap_err();
            assert_eq!(error.code, "orchestration_request_invalid");
            assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
        }
    }
}
