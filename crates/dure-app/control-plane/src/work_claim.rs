//! Advisory work claims: declare, list and release what a holder works on.

use dure_app::{DomainStoreErrorV1, WORK_CLAIM_SCHEMA_VERSION_V1, WorkClaimPutRequestV1};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{BackendDispatchError, BackendFailureDispositionV1, ServiceState, now_ms};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    schema_version: u16,
    #[serde(default)]
    repository: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release {
    schema_version: u16,
    repository: String,
    holder: String,
}

fn request_invalid(detail: &str) -> BackendDispatchError {
    BackendDispatchError::from(format!("work_claim_request_invalid: {detail}"))
        .with_disposition(BackendFailureDispositionV1::Terminal)
}

fn parse<T: for<'de> Deserialize<'de>>(body: &Value) -> Result<T, BackendDispatchError> {
    serde_json::from_value(body.clone()).map_err(|error| request_invalid(&error.to_string()))
}

fn store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    match error {
        DomainStoreErrorV1::InvalidRecord { field, reason } => {
            request_invalid(&format!("{field} {reason}"))
        }
        _ => "work_claim_store_failed".into(),
    }
}

pub(crate) async fn invoke(
    state: &ServiceState,
    operation: &str,
    body: &Value,
) -> Result<Value, BackendDispatchError> {
    match operation {
        "work_claim.put" => {
            let request: WorkClaimPutRequestV1 = parse(body)?;
            let receipt = state
                .store
                .put_work_claim(
                    &request,
                    now_ms().map_err(|_| "work_claim_clock_unavailable")?,
                )
                .await
                .map_err(store_error)?;
            serde_json::to_value(receipt).map_err(|_| "work_claim_receipt_invalid".into())
        }
        "work_claim.list" => {
            let request: List = parse(body)?;
            if request.schema_version != WORK_CLAIM_SCHEMA_VERSION_V1 {
                return Err(request_invalid("unsupported schemaVersion"));
            }
            let (claims, complete) = state
                .store
                .work_claims(request.repository.as_deref())
                .await
                .map_err(store_error)?;
            Ok(json!({ "schemaVersion": 1, "claims": claims, "complete": complete }))
        }
        "work_claim.release" => {
            let request: Release = parse(body)?;
            if request.schema_version != WORK_CLAIM_SCHEMA_VERSION_V1 {
                return Err(request_invalid("unsupported schemaVersion"));
            }
            let released = state
                .store
                .release_work_claim(&request.repository, &request.holder)
                .await
                .map_err(store_error)?;
            Ok(json!({ "schemaVersion": 1, "released": released }))
        }
        _ => Err("backend_operation_unsupported".into()),
    }
}
