use agent_orchestration::contract::{
    DeliveryReceipt, DeliveryWakeState, DeliveryWakeTransition, DispatchContextReceipt,
    TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest,
};
use agent_orchestration::domain::{CapabilityRef, WakeEffectRef, WakeReasonCode};
use dure_app::{
    RuntimeKindIdV1, WorkflowPromptDeliveryIntentV1, WorkflowPromptDeliveryRequestV1,
    WorkflowSessionGenerationV1,
};
use dure_app_sqlite::QueuedOrchestrationWakeV1;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::time::{Duration, MissedTickBehavior};

use super::{BackendDispatchError, ServiceState, now_ms, orchestration_service_error};

const INBOX_WAKE_HANDOFF: &str =
    "Read and acknowledge it with the installed dure-orchestration tools.";

pub(super) async fn wake_exact_session_delivery(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
    context: &DispatchContextReceipt,
    deliveries: &mut [DeliveryReceipt],
    delivered_at_ms: i64,
) -> Result<(), BackendDispatchError> {
    let Some(delivery_index) = deliveries
        .iter()
        .position(|delivery| addressed_to(delivery, context))
    else {
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
    deliveries[delivery_index] =
        claim_and_deliver(state, session, context, delivery, wake_capability).await?;
    Ok(())
}

fn addressed_to(delivery: &DeliveryReceipt, context: &DispatchContextReceipt) -> bool {
    delivery.participant == context.participant
        && delivery.endpoint.as_ref().is_some_and(|endpoint| {
            endpoint.endpoint_ref == context.endpoint_fence.endpoint_ref
                && endpoint.session_identity == context.endpoint_fence.session_identity
                && endpoint.generation == context.endpoint_fence.generation
        })
}

/// Claims a pending or queued wake and types the inbox handoff once the exact
/// Session admits a prompt. A refusal that proves nothing was written queues
/// the wake again; an uncertain write stays uncertain and is never retried.
async fn claim_and_deliver(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
    context: &DispatchContextReceipt,
    delivery: &DeliveryReceipt,
    wake_capability: CapabilityRef,
) -> Result<DeliveryReceipt, BackendDispatchError> {
    let wake = delivery
        .wake
        .as_ref()
        .ok_or_else(|| BackendDispatchError::from("orchestration_wake_receipt_missing"))?;
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
    if !claim.applied {
        return Ok(claim.delivery);
    }

    let request = match prepare_wake_request(state, session, &claim.delivery).await {
        Ok(request) => request,
        Err(reason_code) => {
            return record_queued_wake(
                state,
                context,
                &claim.delivery,
                wake_capability,
                reason_code,
                claimed_at_ms,
            )
            .await;
        }
    };
    match state.workflow_prompt_deliverer.deliver(request).await {
        Ok(evidence) => {
            let effect_ref = wake_effect_ref(evidence.delivery_identity_parts())?;
            let recorded_at_ms = now_ms()
                .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
                .max(claimed_at_ms);
            transition_wake(
                state,
                context,
                &claim.delivery,
                Some(wake_capability),
                DeliveryWakeTransition::Triggered { effect_ref },
                recorded_at_ms,
            )
            .await
            .map(|outcome| outcome.delivery)
        }
        Err(failure) if !failure.may_have_written => {
            record_queued_wake(
                state,
                context,
                &claim.delivery,
                wake_capability,
                &failure.code,
                claimed_at_ms,
            )
            .await
        }
        Err(_) => Ok(claim.delivery),
    }
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
        handoff: format!(
            "Dure inbox message: {}\n{INBOX_WAKE_HANDOFF}",
            delivery.receipt_id
        ),
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

/// Refusals that prove nothing was written because the exact Session was not
/// ready for a prompt yet. Other reasons cannot change by waiting.
const RETRYABLE_WAKE_REASONS: &[&str] = &[
    "hmux_agent_prompt_runtime_changed",
    "hmux_input_draft_pending",
    "workflow_prompt_provider_busy",
];
const WAKE_RETRY_TICK: Duration = Duration::from_secs(15);
const WAKE_RETRY_MIN_INTERVAL_MS: i64 = 30_000;
const WAKE_RETRY_MAX_INTERVAL_MS: i64 = 5 * 60_000;
const WAKE_RETRY_WINDOW_MS: i64 = 24 * 60 * 60_000;
const WAKE_RETRY_LIMIT: u32 = 256;
const WAKE_RETRY_ATTEMPTS_PER_TICK: usize = 8;

/// The wait between attempts grows with the message's age, so a Session that
/// stays busy is probed less often while a fresh message is not left waiting.
fn retry_interval_ms(age_ms: i64) -> i64 {
    (age_ms / 10).clamp(WAKE_RETRY_MIN_INTERVAL_MS, WAKE_RETRY_MAX_INTERVAL_MS)
}

/// A queued wake used to wait for the worker's next turn, but nothing starts
/// that turn for an idle worker. Retry each unread delivery until its Session
/// admits the inbox prompt or the retry window closes.
pub(crate) async fn retry_loop(state: Arc<ServiceState>) {
    let mut interval = tokio::time::interval(WAKE_RETRY_TICK);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut attempted = HashMap::new();
    loop {
        interval.tick().await;
        if !state.is_mutation_authority() {
            continue;
        }
        let Ok(now) = now_ms() else { continue };
        retry_queued_wakes(&state, now, &mut attempted).await;
    }
}

/// `attempted` remembers attempts that left no wake transition, such as a
/// Session that could not be observed. Losing it on restart only makes the
/// next attempt sooner.
pub(crate) async fn retry_queued_wakes(
    state: &ServiceState,
    now: i64,
    attempted: &mut HashMap<String, i64>,
) {
    let Ok(queued) = state
        .store
        .queued_orchestration_wakes(
            RETRYABLE_WAKE_REASONS,
            now - WAKE_RETRY_MIN_INTERVAL_MS,
            now - WAKE_RETRY_WINDOW_MS,
            WAKE_RETRY_LIMIT,
        )
        .await
    else {
        return;
    };
    attempted.retain(|receipt_id, _| {
        queued
            .iter()
            .any(|queued| queued.delivery.receipt_id.as_str() == receipt_id)
    });
    let due = queued.iter().filter(|queued| {
        let last_attempt = queued
            .delivery
            .wake
            .as_ref()
            .map_or(0, |wake| wake.updated_at_ms)
            .max(
                attempted
                    .get(queued.delivery.receipt_id.as_str())
                    .copied()
                    .unwrap_or(0),
            );
        now - last_attempt >= retry_interval_ms(now - queued.opened_at_ms)
    });
    let due: Vec<_> = due.take(WAKE_RETRY_ATTEMPTS_PER_TICK).collect();
    for queued in due {
        attempted.insert(queued.delivery.receipt_id.to_string(), now);
        let _ = retry_queued_wake(state, queued).await;
    }
}

async fn retry_queued_wake(
    state: &ServiceState,
    queued: &QueuedOrchestrationWakeV1,
) -> Result<(), BackendDispatchError> {
    let context = super::exact_orchestration_context(state, &queued.session).await?;
    // A rebound Dispatch addresses a successor endpoint; its own deliveries
    // carry their own wakes.
    if !addressed_to(&queued.delivery, &context) {
        return Ok(());
    }
    let wake_capability = context
        .wake_capability
        .clone()
        .ok_or_else(|| BackendDispatchError::from("orchestration_wake_capability_missing"))?;
    claim_and_deliver(
        state,
        &queued.session,
        &context,
        &queued.delivery,
        wake_capability,
    )
    .await
    .map(drop)
}
