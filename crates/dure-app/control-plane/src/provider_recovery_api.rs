//! Recovery configuration and observations shared by desktop and headless clients.

use dure_app::{
    AgentIdV1, AgentRecoveryStore, DomainStoreErrorV1, ProviderCredentialProfileStore,
    ProviderIdV1, ProviderRecoveryPolicyPutV1, ProviderRecoveryStore, ProviderRecoveryUsageV1,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{BackendDispatchError, ServiceState, now_ms, pro_features};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Get {
    schema_version: u16,
    provider_id: ProviderIdV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    schema_version: u16,
    agent_id: AgentIdV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observe {
    schema_version: u16,
    observations: Vec<ProviderRecoveryUsageV1>,
}

fn store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    match error {
        DomainStoreErrorV1::IdentityConflict { .. }
        | DomainStoreErrorV1::IdempotencyConflict { .. } => {
            BackendDispatchError::terminal("provider_recovery_conflict")
        }
        DomainStoreErrorV1::InvalidRecord { .. } => "provider_recovery_request_invalid".into(),
        _ => "provider_recovery_store_failed".into(),
    }
}

pub(crate) async fn invoke(
    state: &ServiceState,
    operation: &str,
    body: &Value,
) -> Result<Value, BackendDispatchError> {
    match operation {
        "provider_recovery.get" => {
            let request: Get = serde_json::from_value(body.clone())
                .map_err(|_| "provider_recovery_request_invalid")?;
            if request.schema_version != 1 {
                return Err("provider_recovery_request_invalid".into());
            }
            let policy = state
                .store
                .provider_recovery_policy(&request.provider_id)
                .await
                .map_err(store_error)?;
            let profiles = state
                .store
                .provider_credential_profiles(&request.provider_id)
                .await
                .map_err(store_error)?;
            Ok(json!({ "schemaVersion": 1, "policy": policy, "profiles": profiles }))
        }
        "provider_recovery.put" => {
            let request: ProviderRecoveryPolicyPutV1 = serde_json::from_value(body.clone())
                .map_err(|_| "provider_recovery_request_invalid")?;
            if request.enabled && !pro_features::available() {
                return Err(BackendDispatchError::terminal("pro_required"));
            }
            let policy = state
                .store
                .put_provider_recovery_policy(
                    &request,
                    now_ms().map_err(|_| "provider_recovery_clock_unavailable")?,
                )
                .await
                .map_err(store_error)?;
            state.goal_wakeup.notify_one();
            Ok(json!({ "schemaVersion": 1, "policy": policy }))
        }
        "provider_recovery.observe_usage" => {
            let request: Observe = serde_json::from_value(body.clone())
                .map_err(|_| "provider_recovery_request_invalid")?;
            if request.schema_version != 1 {
                return Err("provider_recovery_request_invalid".into());
            }
            for observation in request.observations {
                state
                    .store
                    .observe_provider_recovery_usage(&observation)
                    .await
                    .map_err(store_error)?;
            }
            Ok(json!({ "schemaVersion": 1 }))
        }
        "agent_recovery.read" => {
            let request: Read = serde_json::from_value(body.clone())
                .map_err(|_| "provider_recovery_request_invalid")?;
            if request.schema_version != 1 {
                return Err("provider_recovery_request_invalid".into());
            }
            let recovery = state
                .store
                .latest_agent_recovery(&request.agent_id)
                .await
                .map_err(store_error)?;
            Ok(json!({ "schemaVersion": 1, "recovery": recovery }))
        }
        _ => Err("provider_recovery_operation_unsupported".into()),
    }
}
