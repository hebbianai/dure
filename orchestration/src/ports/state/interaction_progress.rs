use super::*;
use crate::contract::{
    DeliveryProgressGuidance, InteractionDeliveryProgress, InteractionProgressReceipt,
    WorkerTurnCorrelation,
};

impl StoreState {
    pub fn interaction_progress(
        &self,
        request: &GetInteractionRequest,
    ) -> Option<InteractionProgressReceipt> {
        // Readers use existing grants/fences. An author can also inspect their
        // own message with the exact dispatch's existing interaction authority.
        let interaction = self.interaction(request).or_else(|| {
            self.interactions
                .iter()
                .find(|interaction| {
                    let common = interaction.common();
                    request.endpoint_fence.is_none()
                        && common.id == request.interaction_id
                        && common.target.authority == request.authority
                        && common.author == request.participant
                        && self.dispatches.iter().any(|dispatch| {
                            dispatch.target == common.target
                                && dispatch.interaction_capability == request.read_capability
                        })
                })
                .cloned()
        })?;
        let common = interaction.common();
        let dispatch = self
            .dispatches
            .iter()
            .find(|entry| entry.target == common.target)?;
        let completion = self.events.iter().find(|event| {
            event.target == common.target
                && matches!(event.kind, EventKind::DispatchCompleted { .. })
        });
        let mut deliveries = Vec::new();
        for event in self
            .events
            .iter()
            .filter(|event| event.target == common.target)
        {
            let id = match &event.kind {
                EventKind::InteractionOpened { interaction_id } => interaction_id,
                EventKind::DispatchBlocked { decision_id }
                | EventKind::DecisionAnswered { decision_id }
                | EventKind::DispatchUnblocked { decision_id } => decision_id,
                EventKind::DispatchCompleted { message_id } => message_id,
                EventKind::RunCreated { .. } => continue,
            };
            if id != &common.id {
                continue;
            }
            for entry in self
                .deliveries
                .iter()
                .filter(|entry| entry.receipt.event_cursor == event.cursor)
            {
                deliveries.push(InteractionDeliveryProgress {
                    delivery: entry.receipt.clone(),
                    queued_at_ms: event.recorded_at_ms,
                    observed_at_ms: entry.observed_at_ms,
                    acknowledged_at_ms: entry.acknowledged_at_ms,
                    guidance: guidance(
                        &entry.receipt,
                        completion.is_some_and(|completed| completed.cursor >= event.cursor),
                    ),
                });
            }
        }
        Some(InteractionProgressReceipt {
            schema_version: INTERACTION_SCHEMA_VERSION,
            interaction_id: common.id.clone(),
            target: common.target.clone(),
            accepted_at_ms: common.created_at_ms,
            dispatch_state: dispatch.state,
            completed_at_ms: completion.map(|event| event.recorded_at_ms),
            worker_endpoint: delivery_endpoint_receipt(&dispatch.worker_endpoint),
            worker_turn_correlation: WorkerTurnCorrelation::NotRecorded,
            deliveries,
        })
    }
}

fn guidance(receipt: &DeliveryReceipt, completed: bool) -> DeliveryProgressGuidance {
    use DeliveryProgressGuidance as Guidance;
    if completed {
        return Guidance::DispatchCompleted;
    }
    match receipt.state {
        DeliveryState::Acknowledged => Guidance::AwaitCompletion,
        DeliveryState::Observed => Guidance::AwaitAcknowledgement,
        DeliveryState::Queued => match &receipt.wake {
            Some(wake) if wake.state == DeliveryWakeState::Uncertain => {
                Guidance::InspectBeforeRetry
            }
            Some(wake) if wake.state == DeliveryWakeState::QueuedUntilNextTurn => {
                Guidance::ResolveExactSessionThenWait
            }
            _ => Guidance::AwaitInboxRead,
        },
    }
}
