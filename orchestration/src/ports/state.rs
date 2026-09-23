mod event_reads;
mod interaction_progress;

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::StoreError;
use crate::contract::{
    AnswerDecisionReceipt, AnswerDecisionRequest, CompleteDispatchReceipt, CompleteDispatchRequest,
    CreateRunReceipt, CreateRunRequest, DeliveryEndpointReceipt, DeliveryReceipt, DeliveryState,
    DeliveryWakeReceipt, DeliveryWakeState, DeliveryWakeTransition, DispatchContextReceipt, Event,
    EventKind, GetInteractionRequest, InteractionDraft, OpenInteractionReceipt,
    OpenInteractionRequest, TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest,
};
use crate::domain::{
    AnswerRecord, AuthorityScope, CapabilityRef, DecisionState, DeliveryReceiptId, DispatchRecord,
    DispatchState, EventCursor, INTERACTION_SCHEMA_VERSION, InteractionCommon, InteractionRecord,
    InteractionTarget, MessagePurpose, Revision, ValidationError, WakeReasonCode, WorkerEndpoint,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StoreState {
    pub dispatches: Vec<DispatchRecord>,
    pub interactions: Vec<InteractionRecord>,
    pub events: Vec<Event>,
    pub deliveries: Vec<DeliveryEntry>,
    pub idempotency: BTreeMap<String, IdempotencyEntry>,
    pub acknowledgement_idempotency: BTreeMap<String, String>,
    pub next_cursor: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeliveryEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acknowledged_at_ms: Option<i64>,
    pub receipt: DeliveryReceipt,
    pub delivery_capability: crate::domain::CapabilityRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_capability: Option<crate::domain::CapabilityRef>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IdempotencyEntry {
    pub fingerprint: String,
    pub receipt: StoredReceipt,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "operation", content = "receipt")]
pub enum StoredReceipt {
    Create(Box<CreateRunReceipt>),
    Open(OpenInteractionReceipt),
    Answer(AnswerDecisionReceipt),
    Complete(CompleteDispatchReceipt),
}

impl StoreState {
    pub fn seeded(dispatches: Vec<DispatchRecord>) -> Result<Self, ValidationError> {
        let mut keys = std::collections::BTreeSet::new();
        for dispatch in &dispatches {
            dispatch.validate()?;
            let key = dispatch_key(&dispatch.target);
            if !keys.insert(key) {
                return Err(ValidationError {
                    field: "dispatches",
                    code: "duplicate",
                });
            }
        }
        Ok(Self {
            dispatches,
            interactions: Vec::new(),
            events: Vec::new(),
            deliveries: Vec::new(),
            idempotency: BTreeMap::new(),
            acknowledgement_idempotency: BTreeMap::new(),
            next_cursor: 1,
        })
    }

    pub fn validate(&self) -> Result<(), StoreError> {
        let mut dispatch_keys = std::collections::BTreeSet::new();
        for dispatch in &self.dispatches {
            dispatch.validate().map_err(|_| StoreError::Corrupt {
                code: "dispatch_invalid",
            })?;
            let key = dispatch_key(&dispatch.target);
            if !dispatch_keys.insert(key) {
                return Err(StoreError::Corrupt {
                    code: "dispatch_duplicate",
                });
            }
        }
        let mut interaction_keys = std::collections::BTreeSet::new();
        for interaction in &self.interactions {
            interaction.validate().map_err(|_| StoreError::Corrupt {
                code: "interaction_invalid",
            })?;
            if !self
                .dispatches
                .iter()
                .any(|dispatch| dispatch.target == interaction.common().target)
            {
                return Err(StoreError::Corrupt {
                    code: "interaction_dispatch_missing",
                });
            }
            let key = stable_key([
                scope_key(&interaction.common().target.authority).as_str(),
                interaction.common().id.as_str(),
            ]);
            if !interaction_keys.insert(key) {
                return Err(StoreError::Corrupt {
                    code: "interaction_duplicate",
                });
            }
        }
        let mut delivery_keys = std::collections::BTreeSet::new();
        for event in &self.events {
            event.validate().map_err(|_| StoreError::Corrupt {
                code: "event_invalid",
            })?;
            if !self
                .dispatches
                .iter()
                .any(|dispatch| dispatch.target == event.target)
            {
                return Err(StoreError::Corrupt {
                    code: "event_dispatch_missing",
                });
            }
        }
        for delivery in &self.deliveries {
            delivery
                .receipt
                .validate()
                .map_err(|_| StoreError::Corrupt {
                    code: "delivery_receipt_invalid",
                })?;
            if !delivery_keys.insert(delivery.receipt.receipt_id.clone()) {
                return Err(StoreError::Corrupt {
                    code: "delivery_duplicate",
                });
            }
            let event = self
                .events
                .iter()
                .find(|event| event.cursor == delivery.receipt.event_cursor)
                .ok_or(StoreError::Corrupt {
                    code: "delivery_event_missing",
                })?;
            if delivery.receipt.receipt_id
                != receipt_id(delivery.receipt.event_cursor, &delivery.receipt.participant)?
            {
                return Err(StoreError::Corrupt {
                    code: "delivery_receipt_identity_invalid",
                });
            }
            delivery
                .delivery_capability
                .validate()
                .map_err(|_| StoreError::Corrupt {
                    code: "delivery_capability_invalid",
                })?;
            if let Some(wake_capability) = &delivery.wake_capability {
                wake_capability
                    .validate()
                    .map_err(|_| StoreError::Corrupt {
                        code: "delivery_wake_capability_invalid",
                    })?;
            }
            if let Some(endpoint_receipt) = &delivery.receipt.endpoint {
                let endpoint = self
                    .dispatches
                    .iter()
                    .find(|dispatch| dispatch.target == event.target)
                    .map(|dispatch| &dispatch.worker_endpoint)
                    .ok_or(StoreError::Corrupt {
                        code: "delivery_dispatch_missing",
                    })?;
                if endpoint.participant != delivery.receipt.participant
                    || endpoint.delivery_capability != delivery.delivery_capability
                    || endpoint_receipt != &delivery_endpoint_receipt(endpoint)
                    || endpoint.wake_capability != delivery.wake_capability
                {
                    return Err(StoreError::Corrupt {
                        code: "delivery_endpoint_invalid",
                    });
                }
                let pending_wake_requires_capability =
                    delivery.receipt.wake.as_ref().is_some_and(|wake| {
                        matches!(
                            wake.state,
                            DeliveryWakeState::Pending
                                | DeliveryWakeState::Uncertain
                                | DeliveryWakeState::Triggered
                        )
                    });
                if pending_wake_requires_capability && delivery.wake_capability.is_none() {
                    return Err(StoreError::Corrupt {
                        code: "delivery_wake_capability_missing",
                    });
                }
            } else if delivery.wake_capability.is_some() || delivery.receipt.wake.is_some() {
                return Err(StoreError::Corrupt {
                    code: "delivery_wake_endpoint_missing",
                });
            }
        }
        if self.next_cursor == 0
            || self
                .events
                .windows(2)
                .any(|pair| pair[0].cursor >= pair[1].cursor)
            || self
                .events
                .last()
                .is_some_and(|event| event.cursor.get() >= self.next_cursor)
        {
            return Err(StoreError::Corrupt {
                code: "event_cursor_invalid",
            });
        }
        if self
            .idempotency
            .iter()
            .any(|(key, entry)| !valid_store_key(key) || !valid_digest(&entry.fingerprint))
            || self
                .acknowledgement_idempotency
                .iter()
                .any(|(key, fingerprint)| !valid_store_key(key) || !valid_digest(fingerprint))
        {
            return Err(StoreError::Corrupt {
                code: "idempotency_record_invalid",
            });
        }
        Ok(())
    }

    pub fn create_run(
        &mut self,
        request: CreateRunRequest,
        context: DispatchContextReceipt,
        fingerprint: String,
    ) -> Result<CreateRunReceipt, StoreError> {
        let key =
            authority_operation_key("create_run", &request.authority, &request.idempotency_key);
        if let Some(entry) = self.idempotency.get(&key) {
            return match (&entry.receipt, entry.fingerprint == fingerprint) {
                (StoredReceipt::Create(receipt), true) => {
                    let mut receipt = receipt.as_ref().clone();
                    self.canonicalize_context(&mut receipt.context);
                    self.canonicalize_deliveries(&mut receipt.deliveries);
                    receipt.idempotent = true;
                    Ok(receipt)
                }
                _ => Err(StoreError::IdempotencyConflict),
            };
        }

        if self
            .dispatches
            .iter()
            .any(|dispatch| dispatch.target == context.target)
        {
            return Err(StoreError::StateConflict {
                code: "dispatch_exists",
            });
        }
        if self.dispatches.iter().any(|dispatch| {
            dispatch.state != DispatchState::Completed
                && dispatch.worker_endpoint.session_identity
                    == context.endpoint_fence.session_identity
        }) {
            return Err(StoreError::GenerationConflict);
        }
        let worker_endpoint = WorkerEndpoint {
            endpoint_ref: context.endpoint_fence.endpoint_ref.clone(),
            participant: context.participant.clone(),
            session_identity: context.endpoint_fence.session_identity.clone(),
            generation: context.target.generation,
            delivery_capability: context.delivery_capability.clone(),
            acknowledgement_capability: context.acknowledgement_capability.clone(),
            wake_capability: context.wake_capability.clone(),
            integration_receipt: context.integration_receipt.clone(),
        };
        let dispatch = DispatchRecord {
            target: context.target.clone(),
            revision: Revision::INITIAL,
            state: DispatchState::Active,
            blocked_by: None,
            interaction_capability: context.interaction_capability.clone(),
            completion_capability: context.completion_capability.clone(),
            worker_endpoint,
        };
        dispatch.validate().map_err(|_| StoreError::Corrupt {
            code: "validated_dispatch_rejected",
        })?;
        self.dispatches.push(dispatch);

        let event = self.append_event(
            context.target.clone(),
            context.coordinator_grant.participant.clone(),
            EventKind::RunCreated {
                workflow_kind_ref: request.workflow_kind_ref,
            },
            request.created_at_ms,
        )?;
        let mut receipt_ids = std::collections::BTreeSet::new();
        let coordinator_delivery = self.queue_delivery(
            &event,
            context.coordinator_grant.participant.clone(),
            context.coordinator_grant.delivery_capability.clone(),
            None,
            None,
            &mut receipt_ids,
        )?;
        let worker_delivery = self
            .queue_worker_delivery(&event)?
            .ok_or(StoreError::Corrupt {
                code: "worker_delivery_missing",
            })?;
        let receipt = CreateRunReceipt {
            context,
            event,
            deliveries: vec![coordinator_delivery, worker_delivery],
            idempotent: false,
        };
        self.idempotency.insert(
            key,
            IdempotencyEntry {
                fingerprint,
                receipt: StoredReceipt::Create(Box::new(receipt.clone())),
            },
        );
        Ok(receipt)
    }

    pub fn open(
        &mut self,
        request: OpenInteractionRequest,
        fingerprint: String,
    ) -> Result<OpenInteractionReceipt, StoreError> {
        let key = scoped_operation_key(
            "open",
            &request.interaction.common().target,
            &request.idempotency_key,
        );
        if let Some(entry) = self.idempotency.get(&key) {
            return match (&entry.receipt, entry.fingerprint == fingerprint) {
                (StoredReceipt::Open(receipt), true) => {
                    let mut receipt = receipt.clone();
                    self.canonicalize_deliveries(&mut receipt.deliveries);
                    receipt.idempotent = true;
                    Ok(receipt)
                }
                _ => Err(StoreError::IdempotencyConflict),
            };
        }

        let target = request.interaction.common().target.clone();
        let dispatch_index = self.dispatch_index(&target)?;
        let dispatch = &self.dispatches[dispatch_index];
        if dispatch.revision != request.expected_dispatch_revision {
            return Err(StoreError::RevisionConflict);
        }
        if dispatch.interaction_capability != request.write_capability {
            return Err(StoreError::CapabilityDenied);
        }
        if self.interactions.iter().any(|interaction| {
            interaction.common().id == request.interaction.common().id
                && interaction.common().target.authority == target.authority
        }) {
            return Err(StoreError::StateConflict {
                code: "interaction_id_exists",
            });
        }

        let (record, blocks_dispatch) = match request.interaction {
            InteractionDraft::Message { common, purpose } => {
                if purpose == MessagePurpose::CompletionReport {
                    return Err(StoreError::StateConflict {
                        code: "completion_message_requires_complete",
                    });
                }
                // An informational update does not reopen or revise a completed
                // task. Its live endpoint can still receive a follow-up message.
                (
                    InteractionRecord::Message {
                        common: common.into_record(request.opened_at_ms),
                        purpose,
                    },
                    false,
                )
            }
            InteractionDraft::Decision {
                common,
                response,
                reply_capability,
            } => {
                if dispatch.state != DispatchState::Active {
                    return Err(StoreError::StateConflict {
                        code: "dispatch_not_active",
                    });
                }
                (
                    InteractionRecord::Decision {
                        common: common.into_record(request.opened_at_ms),
                        response,
                        reply_capability,
                        state: DecisionState::Open,
                    },
                    true,
                )
            }
        };
        record.validate().map_err(|_| StoreError::Corrupt {
            code: "validated_record_rejected",
        })?;

        let opened_event = self.append_event(
            target.clone(),
            record.common().author.clone(),
            EventKind::InteractionOpened {
                interaction_id: record.common().id.clone(),
            },
            request.opened_at_ms,
        )?;
        let deliveries = self.queue_deliveries(&record, std::slice::from_ref(&opened_event))?;
        let mut events = vec![opened_event];
        if blocks_dispatch {
            let dispatch = &mut self.dispatches[dispatch_index];
            dispatch.state = DispatchState::Blocked;
            dispatch.blocked_by = Some(record.common().id.clone());
            dispatch.revision = next_revision(dispatch.revision)?;
            events.push(self.append_event(
                target,
                record.common().author.clone(),
                EventKind::DispatchBlocked {
                    decision_id: record.common().id.clone(),
                },
                request.opened_at_ms,
            )?);
        }

        self.interactions.push(record.clone());
        let receipt = OpenInteractionReceipt {
            interaction: record,
            dispatch_state: self.dispatches[dispatch_index].state,
            events,
            deliveries,
            idempotent: false,
        };
        self.idempotency.insert(
            key,
            IdempotencyEntry {
                fingerprint,
                receipt: StoredReceipt::Open(receipt.clone()),
            },
        );
        Ok(receipt)
    }

    pub fn answer(
        &mut self,
        request: AnswerDecisionRequest,
        fingerprint: String,
    ) -> Result<AnswerDecisionReceipt, StoreError> {
        let key = scoped_operation_key("answer", &request.target, &request.idempotency_key);
        if let Some(entry) = self.idempotency.get(&key) {
            return match (&entry.receipt, entry.fingerprint == fingerprint) {
                (StoredReceipt::Answer(receipt), true) => {
                    let mut receipt = receipt.clone();
                    self.canonicalize_deliveries(&mut receipt.deliveries);
                    receipt.idempotent = true;
                    Ok(receipt)
                }
                _ => Err(StoreError::IdempotencyConflict),
            };
        }

        let interaction_index = self
            .interactions
            .iter()
            .position(|interaction| {
                interaction.common().id == request.interaction_id
                    && interaction.common().target.authority == request.target.authority
            })
            .ok_or(StoreError::NotFound {
                resource: "interaction",
            })?;
        let dispatch_index = self.dispatch_index(&request.target)?;
        let (common, response, reply_capability, state) =
            match &self.interactions[interaction_index] {
                InteractionRecord::Decision {
                    common,
                    response,
                    reply_capability,
                    state,
                } => (common, response, reply_capability, state),
                InteractionRecord::Message { .. } => {
                    return Err(StoreError::StateConflict {
                        code: "interaction_not_decision",
                    });
                }
            };
        if common.target != request.target {
            return Err(StoreError::GenerationConflict);
        }
        if common.revision != request.expected_revision {
            return Err(StoreError::RevisionConflict);
        }
        if self.dispatches[dispatch_index].revision != request.expected_dispatch_revision {
            return Err(StoreError::RevisionConflict);
        }
        if !matches!(state, DecisionState::Open)
            || self.dispatches[dispatch_index].state != DispatchState::Blocked
            || self.dispatches[dispatch_index].blocked_by.as_ref() != Some(&request.interaction_id)
        {
            return Err(StoreError::StateConflict {
                code: "decision_not_open",
            });
        }
        let grant = common
            .audience
            .grant_for(&request.answered_by)
            .ok_or(StoreError::CapabilityDenied)?;
        if reply_capability != &request.reply_capability || !grant.grants(&request.reply_capability)
        {
            return Err(StoreError::CapabilityDenied);
        }
        response
            .validate_answer(&request.answer)
            .map_err(|error| StoreError::StateConflict { code: error.code })?;

        let (actor, target) = (request.answered_by.clone(), common.target.clone());
        let record = &mut self.interactions[interaction_index];
        let common = match record {
            InteractionRecord::Decision { common, state, .. } => {
                common.revision = next_revision(common.revision)?;
                *state = DecisionState::Answered {
                    receipt: AnswerRecord {
                        answered_by: request.answered_by.clone(),
                        answer: request.answer,
                        answered_at_ms: request.answered_at_ms,
                        idempotency_key: request.idempotency_key.clone(),
                    },
                };
                common.clone()
            }
            InteractionRecord::Message { .. } => unreachable!("record kind checked above"),
        };
        let updated_record = self.interactions[interaction_index].clone();
        let dispatch = &mut self.dispatches[dispatch_index];
        dispatch.state = DispatchState::Active;
        dispatch.blocked_by = None;
        dispatch.revision = next_revision(dispatch.revision)?;

        let answered_event = self.append_event(
            target.clone(),
            actor.clone(),
            EventKind::DecisionAnswered {
                decision_id: common.id.clone(),
            },
            request.answered_at_ms,
        )?;
        let unblocked_event = self.append_event(
            target,
            actor,
            EventKind::DispatchUnblocked {
                decision_id: common.id,
            },
            request.answered_at_ms,
        )?;
        let events = vec![answered_event, unblocked_event];
        let mut deliveries =
            self.queue_deliveries(&updated_record, std::slice::from_ref(&events[0]))?;
        if let Some(worker_delivery) = self.queue_worker_delivery(&events[0])? {
            deliveries.push(worker_delivery);
        }
        let receipt = AnswerDecisionReceipt {
            interaction: updated_record,
            dispatch_state: DispatchState::Active,
            events,
            deliveries,
            idempotent: false,
        };
        self.idempotency.insert(
            key,
            IdempotencyEntry {
                fingerprint,
                receipt: StoredReceipt::Answer(receipt.clone()),
            },
        );
        Ok(receipt)
    }

    pub fn complete(
        &mut self,
        request: CompleteDispatchRequest,
        fingerprint: String,
    ) -> Result<CompleteDispatchReceipt, StoreError> {
        let key = scoped_operation_key("complete", &request.target, &request.idempotency_key);
        if let Some(entry) = self.idempotency.get(&key) {
            return match (&entry.receipt, entry.fingerprint == fingerprint) {
                (StoredReceipt::Complete(receipt), true) => {
                    let mut receipt = receipt.clone();
                    self.canonicalize_deliveries(&mut receipt.deliveries);
                    receipt.idempotent = true;
                    Ok(receipt)
                }
                _ => Err(StoreError::IdempotencyConflict),
            };
        }

        let dispatch_index = self.dispatch_index(&request.target)?;
        let dispatch = &self.dispatches[dispatch_index];
        if dispatch.revision != request.expected_dispatch_revision {
            return Err(StoreError::RevisionConflict);
        }
        if dispatch.completion_capability != request.completion_capability {
            return Err(StoreError::CapabilityDenied);
        }
        if dispatch.worker_endpoint.participant != request.completed_by {
            return Err(StoreError::CapabilityDenied);
        }
        if !request.endpoint_fence.matches(&dispatch.worker_endpoint) {
            return Err(StoreError::CapabilityDenied);
        }
        if dispatch.state != DispatchState::Active {
            return Err(StoreError::StateConflict {
                code: "dispatch_not_active",
            });
        }
        if self.interactions.iter().any(|interaction| {
            interaction.common().id == request.message_id
                && interaction.common().target.authority == request.target.authority
        }) {
            return Err(StoreError::StateConflict {
                code: "interaction_id_exists",
            });
        }

        let message = InteractionRecord::Message {
            common: InteractionCommon {
                id: request.message_id,
                target: request.target.clone(),
                author: request.completed_by.clone(),
                audience: request.audience,
                title: request.title,
                description_markdown: request.result_markdown,
                revision: Revision::INITIAL,
                created_at_ms: request.completed_at_ms,
            },
            purpose: MessagePurpose::CompletionReport,
        };
        message.validate().map_err(|_| StoreError::Corrupt {
            code: "validated_record_rejected",
        })?;

        let dispatch = &mut self.dispatches[dispatch_index];
        dispatch.state = DispatchState::Completed;
        dispatch.revision = next_revision(dispatch.revision)?;
        let event = self.append_event(
            request.target,
            request.completed_by,
            EventKind::DispatchCompleted {
                message_id: message.common().id.clone(),
            },
            request.completed_at_ms,
        )?;
        let events = vec![event];
        let deliveries = self.queue_deliveries(&message, &events)?;
        self.interactions.push(message.clone());
        let receipt = CompleteDispatchReceipt {
            message,
            dispatch_state: DispatchState::Completed,
            events,
            deliveries,
            idempotent: false,
        };
        self.idempotency.insert(
            key,
            IdempotencyEntry {
                fingerprint,
                receipt: StoredReceipt::Complete(receipt.clone()),
            },
        );
        Ok(receipt)
    }

    pub fn transition_delivery_wake(
        &mut self,
        request: TransitionDeliveryWakeRequest,
    ) -> Result<TransitionDeliveryWakeReceipt, StoreError> {
        let delivery_index = self
            .deliveries
            .iter()
            .position(|delivery| delivery.receipt.receipt_id == request.receipt_id)
            .ok_or(StoreError::NotFound {
                resource: "delivery",
            })?;
        self.authorize_delivery_endpoint(
            &request.authority,
            &self.deliveries[delivery_index],
            &request.endpoint_fence,
            request.wake_capability.as_ref(),
        )?;
        let current = self.deliveries[delivery_index].receipt.wake.as_ref();
        let replacement = match request.transition {
            DeliveryWakeTransition::Request if current.is_none() => Some(
                request.wake_capability.map_or_else(
                    || DeliveryWakeReceipt {
                        state: DeliveryWakeState::QueuedUntilNextTurn,
                        effect_ref: None,
                        reason_code: Some(
                            WakeReasonCode::new("wake_capability_unavailable")
                                .expect("static wake reason is valid"),
                        ),
                        updated_at_ms: request.transitioned_at_ms,
                    },
                    |_| DeliveryWakeReceipt {
                        state: DeliveryWakeState::Pending,
                        effect_ref: None,
                        reason_code: None,
                        updated_at_ms: request.transitioned_at_ms,
                    },
                ),
            ),
            DeliveryWakeTransition::Claim
                if current.is_some_and(|wake| wake.state == DeliveryWakeState::Pending) =>
            {
                Some(DeliveryWakeReceipt {
                    state: DeliveryWakeState::Uncertain,
                    effect_ref: None,
                    reason_code: None,
                    updated_at_ms: request.transitioned_at_ms,
                })
            }
            DeliveryWakeTransition::Triggered { effect_ref }
                if current.is_some_and(|wake| wake.state == DeliveryWakeState::Uncertain) =>
            {
                Some(DeliveryWakeReceipt {
                    state: DeliveryWakeState::Triggered,
                    effect_ref: Some(effect_ref),
                    reason_code: None,
                    updated_at_ms: request.transitioned_at_ms,
                })
            }
            DeliveryWakeTransition::QueuedUntilNextTurn { reason_code }
                if current.is_some_and(|wake| wake.state == DeliveryWakeState::Uncertain) =>
            {
                Some(DeliveryWakeReceipt {
                    state: DeliveryWakeState::QueuedUntilNextTurn,
                    effect_ref: None,
                    reason_code: Some(reason_code),
                    updated_at_ms: request.transitioned_at_ms,
                })
            }
            DeliveryWakeTransition::Request => None,
            DeliveryWakeTransition::Claim => None,
            DeliveryWakeTransition::Triggered { effect_ref }
                if current.is_some_and(|wake| {
                    wake.state == DeliveryWakeState::Triggered
                        && wake.effect_ref.as_ref() == Some(&effect_ref)
                }) =>
            {
                None
            }
            DeliveryWakeTransition::QueuedUntilNextTurn { reason_code }
                if current.is_some_and(|wake| {
                    wake.state == DeliveryWakeState::QueuedUntilNextTurn
                        && wake.reason_code.as_ref() == Some(&reason_code)
                }) =>
            {
                None
            }
            DeliveryWakeTransition::Triggered { .. }
            | DeliveryWakeTransition::QueuedUntilNextTurn { .. } => {
                return Err(StoreError::StateConflict {
                    code: "wake_outcome_conflict",
                });
            }
        };
        if let Some(current) = current
            && replacement.is_some()
            && request.transitioned_at_ms < current.updated_at_ms
        {
            return Err(StoreError::StateConflict {
                code: "wake_timestamp_stale",
            });
        }
        let applied = replacement.is_some();
        if let Some(replacement) = replacement {
            self.deliveries[delivery_index].receipt.wake = Some(replacement);
        }
        Ok(TransitionDeliveryWakeReceipt {
            delivery: self.deliveries[delivery_index].receipt.clone(),
            applied,
        })
    }

    fn authorize_delivery_endpoint(
        &self,
        authority: &crate::domain::AuthorityScope,
        delivery: &DeliveryEntry,
        endpoint_fence: &crate::domain::WorkerEndpointFence,
        wake_capability: Option<&CapabilityRef>,
    ) -> Result<(), StoreError> {
        let event = self
            .events
            .iter()
            .find(|event| event.cursor == delivery.receipt.event_cursor)
            .ok_or(StoreError::Corrupt {
                code: "delivery_event_missing",
            })?;
        if &event.target.authority != authority
            || delivery.wake_capability.as_ref() != wake_capability
            || self.dispatches.iter().all(|dispatch| {
                dispatch.target != event.target
                    || !endpoint_fence.matches(&dispatch.worker_endpoint)
            })
        {
            return Err(StoreError::CapabilityDenied);
        }
        Ok(())
    }

    fn canonicalize_deliveries(&self, receipts: &mut [DeliveryReceipt]) {
        for receipt in receipts {
            if let Some(canonical) = self
                .deliveries
                .iter()
                .find(|delivery| delivery.receipt.receipt_id == receipt.receipt_id)
            {
                *receipt = canonical.receipt.clone();
            }
        }
    }

    fn canonicalize_context(&self, context: &mut DispatchContextReceipt) {
        let Some(dispatch) = self
            .dispatches
            .iter()
            .find(|dispatch| dispatch.target == context.target)
        else {
            return;
        };
        context.dispatch_revision = dispatch.revision;
        context.dispatch_state = dispatch.state;
        context.successor_required = dispatch.state == DispatchState::Completed
            && !self.deliveries.iter().any(|delivery| {
                delivery.receipt.state == DeliveryState::Queued
                    && ((delivery.receipt.participant == context.coordinator_grant.participant
                        && delivery.delivery_capability
                            == context.coordinator_grant.delivery_capability)
                        || (delivery.receipt.participant == context.participant
                            && delivery.delivery_capability == context.delivery_capability
                            && self.events.iter().any(|event| {
                                event.cursor == delivery.receipt.event_cursor
                                    && matches!(event.kind, EventKind::InteractionOpened { .. })
                            })))
                    && self.events.iter().any(|event| {
                        event.cursor == delivery.receipt.event_cursor
                            && event.target == context.target
                    })
            });
        context.wake_capability = dispatch.worker_endpoint.wake_capability.clone();
    }

    pub fn interaction(&self, request: &GetInteractionRequest) -> Option<InteractionRecord> {
        self.interactions
            .iter()
            .find(|interaction| {
                interaction.common().id == request.interaction_id
                    && interaction.common().target.authority == request.authority
                    && request.endpoint_fence.as_ref().map_or_else(
                        || {
                            interaction
                                .common()
                                .audience
                                .grant_for(&request.participant)
                                .is_some_and(|grant| grant.grants(&request.read_capability))
                        },
                        |fence| {
                            self.dispatches.iter().any(|dispatch| {
                                dispatch.target == interaction.common().target
                                    && dispatch.worker_endpoint.participant == request.participant
                                    && dispatch.worker_endpoint.delivery_capability
                                        == request.read_capability
                                    && fence.matches(&dispatch.worker_endpoint)
                                    && (interaction.common().author == request.participant
                                        || interaction
                                            .common()
                                            .audience
                                            .grant_for(&request.participant)
                                            .is_some_and(|grant| {
                                                grant.grants(&request.read_capability)
                                            }))
                            })
                        },
                    )
            })
            .cloned()
    }

    fn dispatch_index(&self, target: &InteractionTarget) -> Result<usize, StoreError> {
        if let Some(index) = self
            .dispatches
            .iter()
            .position(|dispatch| dispatch.target == *target)
        {
            return Ok(index);
        }
        if self.dispatches.iter().any(|dispatch| {
            dispatch.target.authority == target.authority
                && dispatch.target.run_id == target.run_id
                && dispatch.target.task_id == target.task_id
                && dispatch.target.dispatch_id == target.dispatch_id
        }) {
            return Err(StoreError::GenerationConflict);
        }
        Err(StoreError::NotFound {
            resource: "dispatch",
        })
    }

    fn append_event(
        &mut self,
        target: InteractionTarget,
        actor: crate::domain::ParticipantRef,
        kind: EventKind,
        recorded_at_ms: i64,
    ) -> Result<Event, StoreError> {
        let cursor = EventCursor::new(self.next_cursor);
        self.next_cursor = self.next_cursor.checked_add(1).ok_or(StoreError::Corrupt {
            code: "event_cursor_exhausted",
        })?;
        let event = Event {
            cursor,
            target,
            actor,
            kind,
            recorded_at_ms,
        };
        self.events.push(event.clone());
        Ok(event)
    }

    fn queue_deliveries(
        &mut self,
        interaction: &InteractionRecord,
        events: &[Event],
    ) -> Result<Vec<DeliveryReceipt>, StoreError> {
        let mut receipts = Vec::new();
        let mut receipt_ids = std::collections::BTreeSet::new();
        for event in events {
            for grant in &interaction.common().audience.grants {
                let worker_endpoint = self
                    .dispatches
                    .iter()
                    .find(|dispatch| dispatch.target == event.target)
                    .map(|dispatch| &dispatch.worker_endpoint)
                    .filter(|endpoint| endpoint.participant == grant.participant);
                let endpoint = worker_endpoint.map(delivery_endpoint_receipt);
                let delivery_capability = worker_endpoint.map_or_else(
                    || grant.delivery_capability.clone(),
                    |endpoint| endpoint.delivery_capability.clone(),
                );
                let receipt = self.queue_delivery(
                    event,
                    grant.participant.clone(),
                    delivery_capability,
                    endpoint,
                    worker_endpoint.and_then(|endpoint| endpoint.wake_capability.clone()),
                    &mut receipt_ids,
                )?;
                receipts.push(receipt);
            }
        }
        Ok(receipts)
    }

    fn queue_worker_delivery(
        &mut self,
        event: &Event,
    ) -> Result<Option<DeliveryReceipt>, StoreError> {
        let endpoint = self
            .dispatches
            .iter()
            .find(|dispatch| dispatch.target == event.target)
            .map(|dispatch| dispatch.worker_endpoint.clone())
            .ok_or(StoreError::Corrupt {
                code: "delivery_dispatch_missing",
            })?;
        let receipt_id = receipt_id(event.cursor, &endpoint.participant)?;
        if let Some(existing) = self
            .deliveries
            .iter()
            .find(|delivery| delivery.receipt.receipt_id == receipt_id)
        {
            if existing.delivery_capability != endpoint.delivery_capability
                || existing.wake_capability != endpoint.wake_capability
                || existing.receipt.endpoint.as_ref() != Some(&delivery_endpoint_receipt(&endpoint))
            {
                return Err(StoreError::Corrupt {
                    code: "delivery_receipt_conflict",
                });
            }
            return Ok(None);
        }
        let mut receipt_ids = std::collections::BTreeSet::new();
        self.queue_delivery(
            event,
            endpoint.participant.clone(),
            endpoint.delivery_capability.clone(),
            Some(delivery_endpoint_receipt(&endpoint)),
            endpoint.wake_capability.clone(),
            &mut receipt_ids,
        )
        .map(Some)
    }

    fn queue_delivery(
        &mut self,
        event: &Event,
        participant: crate::domain::ParticipantRef,
        delivery_capability: crate::domain::CapabilityRef,
        endpoint: Option<DeliveryEndpointReceipt>,
        wake_capability: Option<CapabilityRef>,
        receipt_ids: &mut std::collections::BTreeSet<DeliveryReceiptId>,
    ) -> Result<DeliveryReceipt, StoreError> {
        let receipt_id = receipt_id(event.cursor, &participant)?;
        if self
            .deliveries
            .iter()
            .any(|delivery| delivery.receipt.receipt_id == receipt_id)
            || !receipt_ids.insert(receipt_id.clone())
        {
            return Err(StoreError::Corrupt {
                code: "delivery_receipt_duplicate",
            });
        }
        let receipt = DeliveryReceipt {
            receipt_id,
            event_cursor: event.cursor,
            participant,
            endpoint,
            state: DeliveryState::Queued,
            wake: None,
        };
        self.deliveries.push(DeliveryEntry {
            observed_at_ms: None,
            acknowledged_at_ms: None,
            receipt: receipt.clone(),
            delivery_capability,
            wake_capability,
        });
        Ok(receipt)
    }
}

fn delivery_endpoint_receipt(endpoint: &crate::domain::WorkerEndpoint) -> DeliveryEndpointReceipt {
    DeliveryEndpointReceipt {
        endpoint_ref: endpoint.endpoint_ref.clone(),
        session_identity: endpoint.session_identity.clone(),
        generation: endpoint.generation,
    }
}

fn next_revision(revision: Revision) -> Result<Revision, StoreError> {
    revision.checked_next().ok_or(StoreError::Corrupt {
        code: "revision_exhausted",
    })
}

fn operation_key(operation: &str, idempotency_key: &str) -> String {
    stable_key([operation, idempotency_key])
}

fn authority_operation_key(
    operation: &str,
    authority: &crate::domain::AuthorityScope,
    idempotency_key: &str,
) -> String {
    let scope = scope_key(authority);
    let scoped_operation = stable_key([operation, scope.as_str()]);
    operation_key(&scoped_operation, idempotency_key)
}

fn scoped_operation_key(
    operation: &str,
    target: &InteractionTarget,
    idempotency_key: &str,
) -> String {
    let target_key = dispatch_key(target);
    let scoped_operation = stable_key([operation, target_key.as_str()]);
    operation_key(&scoped_operation, idempotency_key)
}

fn scope_key(authority: &crate::domain::AuthorityScope) -> String {
    stable_key([
        if authority.tenant_ref.is_some() {
            "tenant"
        } else {
            "no-tenant"
        },
        authority
            .tenant_ref
            .as_ref()
            .map_or("", crate::domain::TenantRef::as_str),
        authority.workspace_id.as_str(),
    ])
}

fn dispatch_key(target: &InteractionTarget) -> String {
    let scope = scope_key(&target.authority);
    let generation = target.generation.get().to_string();
    stable_key([
        scope.as_str(),
        target.run_id.as_str(),
        target.task_id.as_str(),
        target.dispatch_id.as_str(),
        generation.as_str(),
    ])
}

fn stable_key<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    let mut key = String::new();
    for part in parts {
        write!(&mut key, "{}:", part.len()).expect("writing to String cannot fail");
        key.push_str(part);
    }
    key
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_store_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 2_048 && !value.chars().any(char::is_control)
}

fn receipt_id(
    cursor: EventCursor,
    participant: &crate::domain::ParticipantRef,
) -> Result<DeliveryReceiptId, StoreError> {
    let digest = Sha256::digest(format!("{}:{}", cursor.get(), participant).as_bytes());
    DeliveryReceiptId::new(format!("delivery-{:x}", digest)).map_err(|_| StoreError::Corrupt {
        code: "delivery_receipt_id",
    })
}
