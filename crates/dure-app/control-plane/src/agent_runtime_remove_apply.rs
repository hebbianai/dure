use dure_app::{
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseIntentV1, AgentRuntimeCloseRecordV1,
    AgentRuntimeRemovalPlanV1, SessionCheckoutIdentityV1, SessionCheckoutOwnerV1,
    WorkflowSessionGenerationV1,
};
use dure_session_runtime::CheckoutSessionRuntime;
use serde_json::{Value, json};

use crate::{BackendDispatchError, ServiceState, agent_runtime_close_apply, now_ms};
use agent_runtime_close_apply::{AgentRuntimeStopBodyV1, CloseDriveOutcome, store_error};

pub(super) async fn apply(
    state: &ServiceState,
    attempt_id: &str,
    body: AgentRuntimeStopBodyV1,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != 1 {
        return Err(BackendDispatchError::terminal(
            "agent_runtime_remove_request_invalid",
        ));
    }
    let _guard = state.agent_operations.acquire(&body.agent_id).await;
    let intent =
        agent_runtime_close_apply::prepare_close_intent(state, attempt_id, &body, None).await?;
    let plan = match state
        .store
        .agent_runtime_removal(&intent.operation_id)
        .await
        .map_err(store_error)?
    {
        Some(removal) => removal.plan,
        None => prepare(state, &intent).await?,
    };
    let close = state
        .store
        .admit_agent_runtime_removal(&intent, &plan)
        .await
        .map_err(store_error)?;
    state.agent_runtime_recovery_wake.notify_one();
    match agent_runtime_close_apply::drive_locked(state, &close).await? {
        CloseDriveOutcome::Stopped => Ok(json!({ "schemaVersion": 1, "stopped": true })),
        CloseDriveOutcome::SourceRetained => Err(BackendDispatchError::terminal(
            crate::agent_runtime_stop_boundary::SOURCE_RETAINED_CODE,
        )),
    }
}

async fn prepare(
    state: &ServiceState,
    intent: &AgentRuntimeCloseIntentV1,
) -> Result<AgentRuntimeRemovalPlanV1, BackendDispatchError> {
    let checkout =
        crate::agent_runtime_checkout::resolve(state, &intent.source, &intent.source_authority)
            .await?;
    let mut managed_roots = Vec::new();
    if let Some(checkout) = &checkout {
        let origin: SessionCheckoutIdentityV1 = match &checkout.binding.identity.owner {
            SessionCheckoutOwnerV1::Managed { .. } => checkout.binding.identity.clone(),
            SessionCheckoutOwnerV1::Agent { .. } => serde_json::from_value(
                checkout
                    .close_payload
                    .clone()
                    .ok_or_else(|| runtime_error("missing resource origin"))?,
            )
            .map_err(runtime_error)?,
            _ => return Err(runtime_error("Agent resource has no managed origin")),
        };
        managed_roots.push(origin);
    }
    if let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = &intent.source_authority {
        let session = WorkflowSessionGenerationV1::from_checkpoint_authority(
            authority,
            &intent.source.provider_id,
        );
        if let Some((origin, _)) = CheckoutSessionRuntime::at_root(
            state.store.as_ref().clone(),
            state.hmux_identity.runtime_executable_path.clone(),
            state.hmux_identity.discovery_root.clone(),
        )
        .map_err(runtime_error)?
        .managed_checkout_origin(session)
        .await
        .map_err(runtime_error)?
        {
            if !managed_roots.contains(&origin) {
                managed_roots.push(origin);
            }
        }
    }
    Ok(AgentRuntimeRemovalPlanV1 {
        checkout: checkout.map(|record| record.binding),
        managed_roots,
    })
}

pub(super) async fn finish_locked(
    state: &ServiceState,
    close: &AgentRuntimeCloseRecordV1,
) -> Result<(), BackendDispatchError> {
    let Some(removal) = state
        .store
        .agent_runtime_removal(&close.intent.operation_id)
        .await
        .map_err(store_error)?
    else {
        return Ok(());
    };
    if removal.completed_at_ms.is_some() {
        return Ok(());
    }
    CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        state.hmux_identity.runtime_executable_path.clone(),
        state.hmux_identity.discovery_root.clone(),
    )
    .map_err(runtime_error)?
    .finish_agent_removal(close, &removal.plan)
    .await
    .map_err(runtime_error)?;
    state
        .store
        .finish_agent_runtime_removal(&close.intent.operation_id, now_ms().map_err(runtime_error)?)
        .await
        .map_err(store_error)
}

fn runtime_error(error: impl std::fmt::Display) -> BackendDispatchError {
    BackendDispatchError::from(format!("agent_runtime_remove_failed: {error}"))
        .with_disposition(crate::BackendFailureDispositionV1::RetrySame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BackendFailureDispositionV1;
    use dure_app::DomainStoreErrorV1;

    #[test]
    fn removal_store_failures_preserve_close_retry_dispositions() {
        for error in [
            DomainStoreErrorV1::InvalidRecord {
                field: "removal",
                reason: "invalid frozen input".into(),
            },
            DomainStoreErrorV1::IdentityConflict {
                entity: "agent runtime removal",
                id: "agent".into(),
                reason: "resource owner changed".into(),
            },
            DomainStoreErrorV1::IdempotencyConflict {
                reason: "removal input changed".into(),
            },
            DomainStoreErrorV1::RevisionConflict {
                agent_id: "agent".into(),
                expected_revision: 1,
                actual_revision: Some(2),
            },
            DomainStoreErrorV1::Busy {
                operation: "remove",
            },
        ] {
            let expected = match &error {
                DomainStoreErrorV1::InvalidRecord { .. } => BackendFailureDispositionV1::Terminal,
                DomainStoreErrorV1::Busy { .. } => BackendFailureDispositionV1::RetrySame,
                _ => BackendFailureDispositionV1::StaleGeneration,
            };
            assert_eq!(store_error(error).disposition, expected);
        }
    }
}
