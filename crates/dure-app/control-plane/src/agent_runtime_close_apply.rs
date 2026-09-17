use dure_app::{
    AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1, AgentInteractionBindingV1, AgentInteractionProfileV1,
    AgentInteractionSessionIdV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseAdvanceRequestV1,
    AgentRuntimeCloseAdvanceV1, AgentRuntimeCloseIntentV1, AgentRuntimeCloseRecordV1,
    AgentRuntimeCloseStateV1, AgentRuntimeCloseStoppedTransitionV1, AgentRuntimeCloseStore,
    AgentRuntimeTransitionStateV1, AgentRuntimeTransitionStore, AgentTimelineStore, DomainStore,
    DomainStoreErrorV1, OperationIdV1,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    BackendDispatchError, BackendFailureDispositionV1, ServiceState, now_ms,
    structured_provider_runtime_error,
};
use crate::agent_runtime_stop_boundary::{SOURCE_RETAINED_CODE, SourceStopFailure};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentRuntimeStopBodyV1 {
    pub schema_version: u16,
    pub agent_id: dure_app::AgentIdV1,
}

pub(super) struct AgentRuntimeStopObservationV1 {
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime_generation: String,
}

pub(super) enum CloseDriveOutcome {
    Stopped,
    SourceRetained,
}

pub(super) async fn apply(
    state: &ServiceState,
    attempt_id: &str,
    body: AgentRuntimeStopBodyV1,
) -> Result<Value, BackendDispatchError> {
    apply_observed(state, attempt_id, body, None).await
}

pub(super) async fn apply_observed(
    state: &ServiceState,
    attempt_id: &str,
    body: AgentRuntimeStopBodyV1,
    observation: Option<AgentRuntimeStopObservationV1>,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1 {
        return Err(terminal("agent_runtime_stop_request_invalid"));
    }
    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    let close = load_or_admit(state, attempt_id, &body, observation.as_ref()).await?;
    state.agent_runtime_recovery_wake.notify_one();
    match drive_locked(state, &close).await? {
        CloseDriveOutcome::Stopped => Ok(stopped_receipt()),
        CloseDriveOutcome::SourceRetained => Err(terminal(SOURCE_RETAINED_CODE)),
    }
}

pub(super) async fn drive_locked(
    state: &ServiceState,
    close: &AgentRuntimeCloseRecordV1,
) -> Result<CloseDriveOutcome, BackendDispatchError> {
    match close.state {
        AgentRuntimeCloseStateV1::SourceRetained => {
            unblock_retained_structured_source(state, close)?;
            return Ok(CloseDriveOutcome::SourceRetained);
        }
        AgentRuntimeCloseStateV1::Stopped => {
            super::agent_runtime_remove_apply::finish_locked(state, close).await?;
            return Ok(CloseDriveOutcome::Stopped);
        }
        AgentRuntimeCloseStateV1::Admitted => {}
    }

    if close.intent.stopped_transition.is_some() {
        stop_failed_structured_target(state, close).await?;
        let stopped = advance_close(state, close, AgentRuntimeCloseAdvanceV1::Stopped).await?;
        super::agent_runtime_remove_apply::finish_locked(state, &stopped).await?;
        return Ok(CloseDriveOutcome::Stopped);
    }

    if let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
        &close.intent.source_authority
    {
        // Admission is the durable authority; this is only its hot-path
        // projection while the exact provider process is being stopped.
        state
            .agent_conversation_runtimes
            .block_commands_for_close(&binding.interaction_session_id, &close.intent.operation_id)
            .map_err(|_| retry("agent_runtime_stop_runtime_unavailable"))?;
    }

    match &close.intent.source_authority {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            let runtime = state
                .structured_runtimes
                .resolve(&close.intent.source.provider_id)
                .ok_or_else(|| retry("agent_runtime_stop_runtime_unavailable"))?;
            if let Err(error) = runtime.stop_current(binding).await {
                if error.retains_source() {
                    return retain_source(state, close).await;
                }
                return Err(structured_provider_runtime_error(error));
            }
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => {
            match super::agent_runtime_transition_apply::native::stop_current(
                state,
                &close.intent.source,
                authority,
                &close.intent.operation_id,
            )
            .await
            {
                Ok(()) => {}
                Err(SourceStopFailure::SourceRetained) => {
                    return retain_source(state, close).await;
                }
                Err(SourceStopFailure::Failed(_)) => {
                    return Err(retry("agent_runtime_stop_failed"));
                }
            }
        }
    }
    let stopped = advance_close(state, close, AgentRuntimeCloseAdvanceV1::Stopped).await?;
    super::agent_runtime_remove_apply::finish_locked(state, &stopped).await?;
    Ok(CloseDriveOutcome::Stopped)
}

async fn stop_failed_structured_target(
    state: &ServiceState,
    close: &AgentRuntimeCloseRecordV1,
) -> Result<(), BackendDispatchError> {
    let Some(stopped) = close.intent.stopped_transition.as_ref() else {
        return Ok(());
    };
    let transition = state
        .store
        .agent_runtime_transition(&stopped.operation_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| retry("agent_runtime_stop_runtime_unavailable"))?;
    if (transition.state != AgentRuntimeTransitionStateV1::RepairRequired
        && !transition.is_dormant())
        || transition.journal_revision != stopped.journal_revision
        || transition.intent.source.agent_id != close.intent.source.agent_id
    {
        return Err(conflict("agent_runtime_stop_conflict"));
    }
    let Some(dure_app::AgentRuntimeReplacementAuthorityV1(
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
    )) = transition.replacement_authority.as_ref()
    else {
        return Ok(());
    };
    let runtime = state
        .structured_runtimes
        .resolve(&binding.provider_id)
        .ok_or_else(|| retry("agent_runtime_stop_runtime_unavailable"))?;
    runtime
        .stop_current(binding)
        .await
        .map_err(structured_provider_runtime_error)
}

async fn retain_source(
    state: &ServiceState,
    close: &AgentRuntimeCloseRecordV1,
) -> Result<CloseDriveOutcome, BackendDispatchError> {
    advance_close(state, close, AgentRuntimeCloseAdvanceV1::SourceRetained).await?;
    unblock_retained_structured_source(state, close)?;
    Ok(CloseDriveOutcome::SourceRetained)
}

async fn advance_close(
    state: &ServiceState,
    close: &AgentRuntimeCloseRecordV1,
    advance: AgentRuntimeCloseAdvanceV1,
) -> Result<AgentRuntimeCloseRecordV1, BackendDispatchError> {
    state
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            operation_id: close.intent.operation_id.clone(),
            expected_journal_revision: close.journal_revision,
            advance,
            advanced_at_ms: clock_at_least(close.updated_at_ms)?,
        })
        .await
        .map_err(store_error)
}

fn unblock_retained_structured_source(
    state: &ServiceState,
    close: &AgentRuntimeCloseRecordV1,
) -> Result<(), BackendDispatchError> {
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
        &close.intent.source_authority
    else {
        return Ok(());
    };
    state
        .agent_conversation_runtimes
        .unblock_commands_after_retained_close(
            &binding.interaction_session_id,
            &close.intent.operation_id,
        )
        .map_err(|_| retry("agent_runtime_stop_runtime_unavailable"))
}

pub(super) async fn reject_if_closed(
    state: &ServiceState,
    agent_id: &dure_app::AgentIdV1,
    code: &'static str,
) -> Result<(), BackendDispatchError> {
    if state
        .store
        .effective_agent_runtime_close(agent_id)
        .await
        .map_err(|_| retry("agent_runtime_close_store_failed"))?
        .is_some()
    {
        return Err(terminal(code));
    }
    Ok(())
}

async fn load_or_admit(
    state: &ServiceState,
    attempt_id: &str,
    body: &AgentRuntimeStopBodyV1,
    observation: Option<&AgentRuntimeStopObservationV1>,
) -> Result<AgentRuntimeCloseRecordV1, BackendDispatchError> {
    let intent = prepare_close_intent(state, attempt_id, body, observation).await?;
    state
        .store
        .admit_agent_runtime_close(&intent)
        .await
        .map_err(store_error)
}

pub(super) async fn prepare_close_intent(
    state: &ServiceState,
    attempt_id: &str,
    body: &AgentRuntimeStopBodyV1,
    observation: Option<&AgentRuntimeStopObservationV1>,
) -> Result<AgentRuntimeCloseIntentV1, BackendDispatchError> {
    let (operation_id, idempotency_key) = close_identity(attempt_id)?;
    if let Some(existing) = state
        .store
        .agent_runtime_close(&operation_id)
        .await
        .map_err(store_error)?
    {
        validate_replay(&existing, body, observation)?;
        if existing.intent.idempotency_key != idempotency_key {
            return Err(conflict("agent_runtime_stop_conflict"));
        }
        return Ok(existing.intent);
    }

    if let Some(existing) = state
        .store
        .effective_agent_runtime_close(&body.agent_id)
        .await
        .map_err(store_error)?
    {
        validate_replay(&existing, body, observation)?;
        // The admitted record, not the transport request that created it, is
        // the durable close authority. A later exact stop request may resume
        // that frozen intent after a lost response or retryable provider
        // failure; the per-Agent operation lock still serializes every drive.
        return Ok(existing.intent);
    }

    let active_transition = state
        .store
        .active_agent_runtime_transition(&body.agent_id)
        .await
        .map_err(store_error)?;
    let (source, source_authority, stopped_transition) = if let Some(transition) = active_transition
    {
        if transition.state != AgentRuntimeTransitionStateV1::RepairRequired
            && !transition.is_dormant()
        {
            return Err(conflict("agent_runtime_stop_conflict"));
        }
        validate_authority_observation(&transition.intent.source_authority, observation)?;
        (
            transition.intent.source,
            transition.intent.source_authority,
            Some(AgentRuntimeCloseStoppedTransitionV1 {
                operation_id: transition.intent.operation_id,
                journal_revision: transition.journal_revision,
            }),
        )
    } else {
        let source = state
            .store
            .agent_runtime_selection(&body.agent_id)
            .await
            .map_err(store_error)?
            .ok_or_else(|| terminal("agent_runtime_stop_not_found"))?;
        let source_authority = match source.interaction_profile {
            AgentInteractionProfileV1::StructuredProtocol => {
                let binding = state
                    .store
                    .agent_interaction_for_agent(&body.agent_id)
                    .await
                    .map_err(store_error)?
                    .ok_or_else(|| terminal("agent_runtime_stop_not_found"))?;
                validate_observation(&binding, observation)?;
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding }
            }
            AgentInteractionProfileV1::NativeCli => {
                if observation.is_some() {
                    return Err(conflict("agent_runtime_stop_conflict"));
                }
                let authority = state
                    .store
                    .agent_checkpoint_binding_authority(&body.agent_id)
                    .await
                    .map_err(store_error)?
                    .ok_or_else(|| terminal("agent_runtime_stop_not_found"))?;
                AgentRuntimeBindingAuthorityV1::NativeCli { authority }
            }
        };
        (source, source_authority, None)
    };
    source_authority
        .validate_for_selection(&source)
        .map_err(store_error)?;
    let authority_updated_at_ms = match &source_authority {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => binding.updated_at_ms,
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => authority.updated_at_ms,
    };
    let requested_at_ms = clock_at_least(source.updated_at_ms.max(authority_updated_at_ms))?;
    Ok(AgentRuntimeCloseIntentV1 {
        schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
        operation_id,
        idempotency_key,
        source,
        source_authority,
        stopped_transition,
        requested_at_ms,
    })
}

fn validate_authority_observation(
    authority: &AgentRuntimeBindingAuthorityV1,
    observation: Option<&AgentRuntimeStopObservationV1>,
) -> Result<(), BackendDispatchError> {
    match authority {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            validate_observation(binding, observation)
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } if observation.is_some() => {
            Err(conflict("agent_runtime_stop_conflict"))
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } => Ok(()),
    }
}

fn validate_replay(
    close: &AgentRuntimeCloseRecordV1,
    body: &AgentRuntimeStopBodyV1,
    observation: Option<&AgentRuntimeStopObservationV1>,
) -> Result<(), BackendDispatchError> {
    close.validate().map_err(store_error)?;
    if close.intent.source.agent_id != body.agent_id {
        return Err(conflict("agent_runtime_stop_conflict"));
    }
    match &close.intent.source_authority {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            validate_observation(binding, observation)?
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } if observation.is_some() => {
            return Err(conflict("agent_runtime_stop_conflict"));
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } => {}
    }
    Ok(())
}

fn validate_observation(
    binding: &AgentInteractionBindingV1,
    observation: Option<&AgentRuntimeStopObservationV1>,
) -> Result<(), BackendDispatchError> {
    if observation.is_some_and(|observation| {
        binding.interaction_session_id != observation.interaction_session_id
            || binding.runtime.runtime_generation != observation.runtime_generation
    }) {
        return Err(conflict("agent_runtime_stop_conflict"));
    }
    Ok(())
}

fn close_identity(attempt_id: &str) -> Result<(OperationIdV1, String), BackendDispatchError> {
    let mut digest = Sha256::new();
    digest.update(b"dure-agent-runtime-close-attempt/v1\0");
    digest_field(&mut digest, attempt_id.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    let operation_id = OperationIdV1::new(format!("runtime-close-{digest}"))
        .map_err(|_| terminal("agent_runtime_stop_request_invalid"))?;
    Ok((operation_id, format!("runtime-close-{digest}")))
}

fn digest_field(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn clock_at_least(minimum: i64) -> Result<i64, BackendDispatchError> {
    now_ms()
        .map(|value| value.max(minimum))
        .map_err(|_| retry("agent_runtime_stop_clock_unavailable"))
}

fn stopped_receipt() -> Value {
    json!({ "schemaVersion": 1, "stopped": true })
}

pub(super) fn store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    match error {
        DomainStoreErrorV1::InvalidRecord { .. } => terminal("agent_runtime_stop_request_invalid"),
        DomainStoreErrorV1::IdentityConflict { .. }
        | DomainStoreErrorV1::IdempotencyConflict { .. }
        | DomainStoreErrorV1::RevisionConflict { .. } => conflict("agent_runtime_stop_conflict"),
        _ => retry("agent_runtime_stop_store_failed"),
    }
}

fn terminal(code: &'static str) -> BackendDispatchError {
    BackendDispatchError::from(code).with_disposition(BackendFailureDispositionV1::Terminal)
}

fn conflict(code: &'static str) -> BackendDispatchError {
    BackendDispatchError::from(code).with_disposition(BackendFailureDispositionV1::StaleGeneration)
}

fn retry(code: &'static str) -> BackendDispatchError {
    BackendDispatchError::from(code).with_disposition(BackendFailureDispositionV1::RetrySame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_identity_is_stable_only_for_the_exact_transport_attempt() {
        let first = close_identity("request-1").unwrap();
        assert_eq!(first, close_identity("request-1").unwrap());
        assert_ne!(first, close_identity("request-2").unwrap());
    }

    #[test]
    fn retained_close_attempt_is_terminal_for_transport_replay() {
        let error = terminal(SOURCE_RETAINED_CODE);

        assert_eq!(error.code, SOURCE_RETAINED_CODE);
        assert!(matches!(
            error.disposition,
            BackendFailureDispositionV1::Terminal
        ));
    }
}
