use super::*;
use crate::contract::{
    EventAcknowledgementReceipt, InspectEventsRequest, ReadEventsReceipt, ReadEventsRequest,
};
use crate::ports::{ReadEventsStoreRequest, ReadEventsStoreResult};

impl StoreState {
    pub fn read_events(
        &mut self,
        request: ReadEventsRequest,
        acknowledgement_fingerprint: Option<String>,
    ) -> Result<(ReadEventsReceipt, bool), StoreError> {
        let observed_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .ok_or(StoreError::Unavailable {
                code: "observation_clock_invalid",
            })?;
        let mut changed = false;
        let selected = self.checked_event_cursors(&request)?;

        let mut acknowledgement_receipt = None;
        if let Some(acknowledgement) = &request.acknowledgement {
            let fingerprint = acknowledgement_fingerprint.ok_or(StoreError::Corrupt {
                code: "acknowledgement_fingerprint_missing",
            })?;
            let endpoint_key = request.endpoint_fence.as_ref().map_or_else(
                || "client".to_owned(),
                |fence| {
                    let generation = fence.generation.get().to_string();
                    stable_key([
                        fence.endpoint_ref.as_str(),
                        fence.session_identity.as_str(),
                        generation.as_str(),
                    ])
                },
            );
            let scope = scope_key(&request.authority);
            let operation = stable_key([
                "ack",
                scope.as_str(),
                request.participant.as_str(),
                endpoint_key.as_str(),
            ]);
            let key = operation_key(&operation, &acknowledgement.idempotency_key);
            let mut idempotent = false;
            if let Some(existing) = self.acknowledgement_idempotency.get(&key) {
                if existing != &fingerprint {
                    return Err(StoreError::IdempotencyConflict);
                }
                idempotent = true;
            }
            let acknowledged_delivery_index = self
                .deliveries
                .iter()
                .position(|delivery| {
                    delivery.receipt.participant == request.participant
                        && delivery.delivery_capability == request.delivery_capability
                        && delivery.receipt.event_cursor == acknowledgement.through
                        && delivery.receipt.state != DeliveryState::Queued
                        && event_in_scope(&self.events, &delivery.receipt, &request)
                })
                .ok_or(StoreError::StateConflict {
                    code: "acknowledgement_cursor_unknown",
                })?;
            for delivery in &mut self.deliveries {
                if delivery.receipt.participant == request.participant
                    && delivery.delivery_capability == request.delivery_capability
                    && delivery.receipt.event_cursor <= acknowledgement.through
                    && event_in_scope(&self.events, &delivery.receipt, &request)
                    && delivery.receipt.state != DeliveryState::Acknowledged
                {
                    delivery.receipt.state = DeliveryState::Acknowledged;
                    delivery.acknowledged_at_ms =
                        Some(observed_at_ms.max(delivery.observed_at_ms.unwrap_or(0)));
                    changed = true;
                }
            }
            let delivery = self.deliveries[acknowledged_delivery_index].receipt.clone();
            acknowledgement_receipt = Some(Box::new(EventAcknowledgementReceipt {
                through: acknowledgement.through,
                delivery,
                idempotent,
            }));
            if !idempotent {
                self.acknowledgement_idempotency.insert(key, fingerprint);
                changed = true;
            }
        }

        for delivery in &mut self.deliveries {
            if selected.contains(&delivery.receipt.event_cursor)
                && delivery.receipt.participant == request.participant
                && delivery.receipt.state == DeliveryState::Queued
            {
                delivery.receipt.state = DeliveryState::Observed;
                delivery.observed_at_ms = Some(observed_at_ms);
                changed = true;
            }
        }
        let mut receipt = self.event_receipt(&request, &selected);
        receipt.acknowledgement = acknowledgement_receipt;
        Ok((receipt, changed))
    }

    pub fn read_events_batch(
        &mut self,
        authority: &AuthorityScope,
        requests: Vec<ReadEventsStoreRequest>,
    ) -> Result<(Vec<ReadEventsStoreResult>, bool), StoreError> {
        let mut results = Vec::with_capacity(requests.len());
        let mut changed = false;
        for item in requests {
            if &item.request.authority != authority {
                return Err(StoreError::Corrupt {
                    code: "event_read_batch_scope_mismatch",
                });
            }
            let mut candidate = self.clone();
            match candidate.read_events(item.request, item.acknowledgement_fingerprint) {
                Ok((receipt, item_changed)) => {
                    if item_changed {
                        *self = candidate;
                        changed = true;
                    }
                    results.push(Ok(receipt));
                }
                Err(error @ (StoreError::Unavailable { .. } | StoreError::Corrupt { .. })) => {
                    return Err(error);
                }
                Err(error) => results.push(Err(error)),
            }
        }
        Ok((results, changed))
    }

    pub fn inspect_events(
        &self,
        request: &InspectEventsRequest,
    ) -> Result<ReadEventsReceipt, StoreError> {
        let request = request.as_read_request();
        let selected = self.checked_event_cursors(request)?;
        Ok(self.event_receipt(request, &selected))
    }

    fn checked_event_cursors(
        &self,
        request: &ReadEventsRequest,
    ) -> Result<Vec<EventCursor>, StoreError> {
        if let Some(fence) = &request.endpoint_fence {
            let target = request
                .target
                .as_ref()
                .ok_or(StoreError::GenerationConflict)?;
            let dispatch_index = self.dispatch_index(target)?;
            let endpoint = &self.dispatches[dispatch_index].worker_endpoint;
            if endpoint.participant != request.participant || !fence.matches(endpoint) {
                return Err(StoreError::CapabilityDenied);
            }
        }

        if self.deliveries.iter().any(|delivery| {
            delivery.receipt.participant == request.participant
                && delivery.delivery_capability == request.delivery_capability
                && event_in_scope(&self.events, &delivery.receipt, request)
                && match (&delivery.receipt.endpoint, &request.endpoint_fence) {
                    (Some(_), None) => true,
                    (Some(receipt), Some(fence)) => {
                        receipt.endpoint_ref != fence.endpoint_ref
                            || receipt.session_identity != fence.session_identity
                            || receipt.generation != fence.generation
                    }
                    (None, Some(_)) => true,
                    (None, None) => false,
                }
        }) {
            return Err(StoreError::CapabilityDenied);
        }

        let mut selected = Vec::new();
        for delivery in &self.deliveries {
            if delivery.receipt.participant == request.participant
                && delivery.delivery_capability == request.delivery_capability
                && delivery.receipt.event_cursor > request.after
                && event_in_scope(&self.events, &delivery.receipt, request)
            {
                selected.push(delivery.receipt.event_cursor);
            }
        }
        selected.sort_unstable();
        selected.dedup();
        selected.truncate(request.limit);
        Ok(selected)
    }

    fn event_receipt(
        &self,
        request: &ReadEventsRequest,
        selected: &[EventCursor],
    ) -> ReadEventsReceipt {
        let events: Vec<_> = selected
            .iter()
            .filter_map(|cursor| self.events.iter().find(|event| &event.cursor == cursor))
            .cloned()
            .collect();
        let deliveries: Vec<_> = selected
            .iter()
            .filter_map(|cursor| {
                self.deliveries
                    .iter()
                    .find(|delivery| {
                        delivery.receipt.event_cursor == *cursor
                            && delivery.receipt.participant == request.participant
                    })
                    .map(|delivery| delivery.receipt.clone())
            })
            .collect();
        let next_cursor = selected.last().copied().unwrap_or(request.after);
        ReadEventsReceipt {
            events,
            deliveries,
            next_cursor,
            acknowledgement: None,
        }
    }
}

fn event_in_scope(
    events: &[Event],
    receipt: &DeliveryReceipt,
    request: &ReadEventsRequest,
) -> bool {
    events
        .iter()
        .find(|event| event.cursor == receipt.event_cursor)
        .is_some_and(|event| {
            event.target.authority == request.authority
                && request
                    .target
                    .as_ref()
                    .is_none_or(|target| &event.target == target)
        })
}
