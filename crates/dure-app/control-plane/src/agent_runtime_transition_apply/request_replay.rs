use super::*;
use dure_app::{AgentRuntimeRequestOutcomeV1, AgentRuntimeRequestReceiptV1};

pub(crate) async fn apply(
    state: &ServiceState,
    attempt_id: &str,
    body: AgentRuntimeTransitionApplyBodyV1,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, crate::BackendDispatchError> {
    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    apply_locked(state, attempt_id, body).await
}

pub(crate) async fn apply_locked(
    state: &ServiceState,
    attempt_id: &str,
    body: AgentRuntimeTransitionApplyBodyV1,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, crate::BackendDispatchError> {
    if body.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1
        || body
            .expected_source_revision
            .is_some_and(|revision| revision < 1)
        || (body.source_stop_policy == AgentRuntimeSourceStopPolicyV1::Discard
            && body.expected_source_revision.is_none())
        // Observed-idle intent also needs its complete original native source,
        // carried by the hibernate entry point rather than this profile edit.
        || matches!(body.source_stop_policy, AgentRuntimeSourceStopPolicyV1::PreserveObserved { .. })
    {
        return Err("agent_runtime_transition_request_invalid".into());
    }

    let (operation_id, idempotency_key) = runtime_transition_identity(attempt_id)?;
    let fingerprint = fingerprint(&body)?;
    if let Some(receipt) = state
        .store
        .agent_runtime_request_receipt(&idempotency_key)
        .await
        .map_err(store_error)?
    {
        return respond(state, &fingerprint, receipt).await;
    }
    let admission = if let Some(existing) = state
        .store
        .agent_runtime_transition_by_idempotency_key(&idempotency_key)
        .await
        .map_err(store_error)?
    {
        validate_replay(&existing, &body, &operation_id)?;
        if existing.predecessor_operation_id.is_some() {
            return observe_replayed_repair(state, &existing).await;
        }
        AdmissionOutcome::Transition(Box::new(existing))
    } else {
        load_or_admit(
            state,
            &body,
            operation_id,
            idempotency_key.clone(),
            &fingerprint,
        )
        .await?
    };
    let transition = match admission {
        AdmissionOutcome::AlreadySelected(source) => {
            let (selection, authority) = *source;
            let receipt = state
                .store
                .record_agent_runtime_unchanged_request(
                    &idempotency_key,
                    &fingerprint,
                    &selection,
                    &authority,
                )
                .await
                .map_err(store_error)?;
            return respond(state, &fingerprint, receipt).await;
        }
        AdmissionOutcome::Transition(transition) => *transition,
        AdmissionOutcome::Replayed(transition) => {
            return observe_replayed_repair(state, &transition).await;
        }
    };

    state.agent_runtime_recovery_wake.notify_one();
    drive_outcome(drive_locked(state, transition).await?)
}

pub(super) fn fingerprint(body: &AgentRuntimeTransitionApplyBodyV1) -> Result<String, String> {
    let encoded = serde_json::to_vec(body)
        .map_err(|_| "agent_runtime_transition_request_invalid".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(super) async fn respond(
    state: &ServiceState,
    fingerprint: &str,
    receipt: AgentRuntimeRequestReceiptV1,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, crate::BackendDispatchError> {
    if receipt.fingerprint != fingerprint {
        return Err("agent_runtime_transition_idempotency_conflict".into());
    }
    match receipt.outcome {
        AgentRuntimeRequestOutcomeV1::Transition { operation_id } => {
            let transition = state
                .store
                .agent_runtime_transition(&operation_id)
                .await
                .map_err(store_error)?
                .ok_or_else(|| "agent_runtime_transition_commit_stale".to_string())?;
            observe_replayed_repair(state, &transition).await
        }
        AgentRuntimeRequestOutcomeV1::Unchanged {
            selection,
            authority,
        } => {
            // Clients project this receipt as the selected runtime. Keep the
            // immutable result, but never reinstall a retired selection.
            let current =
                crate::agent_runtime_projection::read_locked(state, &selection.agent_id).await?;
            if !matches!(current, crate::agent_runtime_projection::AgentRuntimeObservedV1::Stable {
                selection: selected, ..
            } if selected == selection)
            {
                return Err("agent_runtime_transition_commit_stale".into());
            }
            stable_runtime_receipt(state, &selection, &authority)
                .await
                .map_err(Into::into)
        }
    }
}
