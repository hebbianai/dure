use agent_orchestration::contract::{
    DeliveryReceipt, DeliveryWakeState, DeliveryWakeTransition, DispatchContextReceipt,
    TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest,
};
use agent_orchestration::domain::{CapabilityRef, WakeEffectRef, WakeReasonCode};
use dure_app::{
    RuntimeKindIdV1, WorkflowPromptDeliveryIntentV1, WorkflowPromptDeliveryRequestV1,
    WorkflowSessionGenerationV1,
};
use sha2::{Digest, Sha256};

use super::{BackendDispatchError, ServiceState, now_ms, orchestration_service_error};

const INBOX_WAKE_HANDOFF: &str = "A Dure inbox event is waiting. Read and acknowledge it with the installed dure-orchestration tools.";

pub(super) async fn wake_exact_session_delivery(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
    context: &DispatchContextReceipt,
    deliveries: &mut [DeliveryReceipt],
    delivered_at_ms: i64,
) -> Result<(), BackendDispatchError> {
    let Some(delivery_index) = deliveries.iter().position(|delivery| {
        delivery.participant == context.participant
            && delivery.endpoint.as_ref().is_some_and(|endpoint| {
                endpoint.endpoint_ref == context.endpoint_fence.endpoint_ref
                    && endpoint.session_identity == context.endpoint_fence.session_identity
                    && endpoint.generation == context.endpoint_fence.generation
            })
    }) else {
        return Err("orchestration_delivery_receipt_missing".into());
    };
    let requested_at_ms = now_ms()
        .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
        .max(delivered_at_ms);
    let requested = transition_wake(
        state,
        context,
        &deliveries[delivery_index],
        context.wake_capability.clone(),
        DeliveryWakeTransition::Request,
        requested_at_ms,
    )
    .await?;
    deliveries[delivery_index] = requested.delivery;
    let delivery = &deliveries[delivery_index];
    let wake = delivery
        .wake
        .as_ref()
        .ok_or_else(|| BackendDispatchError::from("orchestration_wake_receipt_missing"))?;
    if wake.state != DeliveryWakeState::Pending {
        return Ok(());
    }
    let wake_capability = context
        .wake_capability
        .clone()
        .ok_or_else(|| BackendDispatchError::from("orchestration_wake_capability_missing"))?;
    let claimed_at_ms = now_ms()
        .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
        .max(wake.updated_at_ms);
    let claim = transition_wake(
        state,
        context,
        delivery,
        Some(wake_capability.clone()),
        DeliveryWakeTransition::Claim,
        claimed_at_ms,
    )
    .await?;
    deliveries[delivery_index] = claim.delivery.clone();
    if !claim.applied {
        return Ok(());
    }

    let request = match prepare_wake_request(state, session, &claim.delivery).await {
        Ok(request) => request,
        Err(reason_code) => {
            deliveries[delivery_index] = record_queued_wake(
                state,
                context,
                &claim.delivery,
                wake_capability,
                reason_code,
                claimed_at_ms,
            )
            .await?;
            return Ok(());
        }
    };
    match state.workflow_prompt_deliverer.deliver(request).await {
        Ok(evidence) => {
            let effect_ref = wake_effect_ref(evidence.delivery_identity_parts())?;
            let recorded_at_ms = now_ms()
                .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
                .max(claimed_at_ms);
            let outcome = transition_wake(
                state,
                context,
                &claim.delivery,
                Some(wake_capability),
                DeliveryWakeTransition::Triggered { effect_ref },
                recorded_at_ms,
            )
            .await?;
            deliveries[delivery_index] = outcome.delivery;
        }
        Err(failure) if !failure.may_have_written => {
            deliveries[delivery_index] = record_queued_wake(
                state,
                context,
                &claim.delivery,
                wake_capability,
                &failure.code,
                claimed_at_ms,
            )
            .await?;
        }
        Err(_) => {}
    }
    Ok(())
}

async fn transition_wake(
    state: &ServiceState,
    context: &DispatchContextReceipt,
    delivery: &DeliveryReceipt,
    wake_capability: Option<CapabilityRef>,
    transition: DeliveryWakeTransition,
    transitioned_at_ms: i64,
) -> Result<TransitionDeliveryWakeReceipt, BackendDispatchError> {
    state
        .store
        .interaction_service()
        .transition_delivery_wake(TransitionDeliveryWakeRequest {
            schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
            authority: context.target.authority.clone(),
            receipt_id: delivery.receipt_id.clone(),
            endpoint_fence: context.endpoint_fence.clone(),
            wake_capability,
            transition,
            transitioned_at_ms,
        })
        .await
        .map_err(orchestration_service_error)
}

async fn prepare_wake_request(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
    delivery: &DeliveryReceipt,
) -> Result<WorkflowPromptDeliveryRequestV1, &'static str> {
    let run_authority = state
        .store
        .orchestration_run_authority_for_exact_session(session)
        .await
        .map_err(|_| "provider_wake_authority_unavailable")?;
    let runtime_kind_id = RuntimeKindIdV1::new(run_authority.runtime_ref.as_str())
        .map_err(|_| "provider_wake_runtime_unsupported")?;
    let provider_conversation_id = run_authority
        .provider_conversation_id
        .ok_or("provider_wake_conversation_identity_unavailable")?;
    let request = WorkflowPromptDeliveryRequestV1 {
        runtime_kind_id,
        delivery_idempotency_key: format!("wake:{}", delivery.receipt_id),
        session: session.clone(),
        intent: WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id,
        },
        handoff: INBOX_WAKE_HANDOFF.into(),
    };
    Ok(request)
}

fn wake_effect_ref<'a>(
    identity_parts: impl IntoIterator<Item = &'a str>,
) -> Result<WakeEffectRef, BackendDispatchError> {
    let mut digest = Sha256::new();
    for value in identity_parts {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    WakeEffectRef::new(format!("wake-effect-{:x}", digest.finalize()))
        .map_err(|_| BackendDispatchError::from("orchestration_wake_receipt_invalid"))
}

async fn record_queued_wake(
    state: &ServiceState,
    context: &DispatchContextReceipt,
    delivery: &DeliveryReceipt,
    wake_capability: CapabilityRef,
    reason_code: &str,
    claimed_at_ms: i64,
) -> Result<DeliveryReceipt, BackendDispatchError> {
    let reason_code = WakeReasonCode::new(reason_code)
        .map_err(|_| BackendDispatchError::from("orchestration_wake_receipt_invalid"))?;
    let recorded_at_ms = now_ms()
        .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
        .max(claimed_at_ms);
    transition_wake(
        state,
        context,
        delivery,
        Some(wake_capability),
        DeliveryWakeTransition::QueuedUntilNextTurn { reason_code },
        recorded_at_ms,
    )
    .await
    .map(|receipt| receipt.delivery)
}
