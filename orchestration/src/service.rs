//! Sole workflow state-transition authority.

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::contract::{
    AnswerDecisionReceipt, AnswerDecisionRequest, CompleteDispatchReceipt, CompleteDispatchRequest,
    CreateRunReceipt, CreateRunRequest, DispatchContextReceipt, GetInteractionRequest,
    InspectEventsRequest, OpenInteractionReceipt, OpenInteractionRequest,
    ReadEventsBatchItemOutcome, ReadEventsBatchItemReceipt, ReadEventsBatchReceipt,
    ReadEventsBatchRequest, ReadEventsReceipt, ReadEventsRequest, ServiceError,
    TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest, validate_schema,
};
use crate::domain::{
    DispatchId, DispatchState, Generation, InteractionRecord, InteractionTarget, RunId,
    SessionIdentityRef, TaskId, WorkerSessionGeneration,
};
use crate::ports::{ReadEventsStoreRequest, StoreError, StoreHandle};

enum PreparedReadEventsBatchItem {
    Ready,
    Failed(ServiceError),
}

pub struct InteractionService {
    store: StoreHandle,
}

impl InteractionService {
    pub fn new(store: StoreHandle) -> Self {
        Self { store }
    }

    pub async fn create_run(
        &self,
        request: CreateRunRequest,
        context: DispatchContextReceipt,
    ) -> Result<CreateRunReceipt, ServiceError> {
        request.validate()?;
        context.validate()?;
        let fingerprint = create_run_fingerprint(&request)?;
        let target = target_from_fingerprint(&request, &fingerprint)?;
        if context.target != target
            || context.dispatch_revision != crate::domain::Revision::INITIAL
            || context.dispatch_state != DispatchState::Active
            || context.successor_required
            || context.integration_receipt != request.integration_receipt
            || context.endpoint_fence.session_identity != worker_session_identity(&request.session)?
        {
            return Err(ServiceError::Invalid {
                field: "context",
                code: "run_mismatch",
            });
        }
        self.store
            .create_run(request, context, fingerprint)
            .await
            .map_err(ServiceError::from)
    }

    pub async fn open(
        &self,
        request: OpenInteractionRequest,
    ) -> Result<OpenInteractionReceipt, ServiceError> {
        request.validate()?;
        let fingerprint = fingerprint(&request)?;
        self.store
            .open_interaction(request, fingerprint)
            .await
            .map_err(ServiceError::from)
    }

    pub async fn transition_delivery_wake(
        &self,
        request: TransitionDeliveryWakeRequest,
    ) -> Result<TransitionDeliveryWakeReceipt, ServiceError> {
        request.validate()?;
        self.store
            .transition_delivery_wake(request)
            .await
            .map_err(ServiceError::from)
    }

    pub async fn get(
        &self,
        request: GetInteractionRequest,
    ) -> Result<InteractionRecord, ServiceError> {
        validate_schema(request.schema_version)?;
        request.authority.validate()?;
        request.interaction_id.validate()?;
        request.participant.validate()?;
        request.read_capability.validate()?;
        if let Some(fence) = &request.endpoint_fence {
            fence.validate()?;
        }
        self.store
            .interaction(&request)
            .await
            .map_err(ServiceError::from)?
            .ok_or(ServiceError::NotFound {
                resource: "interaction",
            })
    }

    pub async fn answer(
        &self,
        request: AnswerDecisionRequest,
    ) -> Result<AnswerDecisionReceipt, ServiceError> {
        request.validate()?;
        let fingerprint = fingerprint(&request)?;
        self.store
            .answer_decision(request, fingerprint)
            .await
            .map_err(ServiceError::from)
    }

    pub async fn complete(
        &self,
        request: CompleteDispatchRequest,
    ) -> Result<CompleteDispatchReceipt, ServiceError> {
        request.validate()?;
        let fingerprint = fingerprint(&request)?;
        self.store
            .complete_dispatch(request, fingerprint)
            .await
            .map_err(ServiceError::from)
    }

    pub async fn inspect_events(
        &self,
        request: InspectEventsRequest,
    ) -> Result<ReadEventsReceipt, ServiceError> {
        self.store
            .inspect_events(request)
            .await
            .map_err(ServiceError::from)
    }

    pub async fn read_events(
        &self,
        request: ReadEventsRequest,
    ) -> Result<ReadEventsReceipt, ServiceError> {
        request.validate()?;
        let acknowledgement_fingerprint = request
            .acknowledgement
            .as_ref()
            .map(|_| fingerprint(&request))
            .transpose()?;
        self.store
            .read_events(request, acknowledgement_fingerprint)
            .await
            .map_err(ServiceError::from)
    }

    pub async fn read_events_batch(
        &self,
        request: ReadEventsBatchRequest,
    ) -> Result<ReadEventsBatchReceipt, ServiceError> {
        request.validate_envelope()?;
        let ReadEventsBatchRequest {
            schema_version,
            authority,
            requests,
        } = request;
        let mut prepared = Vec::with_capacity(requests.len());
        let mut store_requests = Vec::with_capacity(requests.len());
        for item in requests {
            let outcome = if item.request.authority != authority {
                PreparedReadEventsBatchItem::Failed(ServiceError::Invalid {
                    field: "request.authority",
                    code: "scope_mismatch",
                })
            } else if let Err(error) = item.request.validate() {
                PreparedReadEventsBatchItem::Failed(error.into())
            } else {
                let acknowledgement_fingerprint = item
                    .request
                    .acknowledgement
                    .as_ref()
                    .map(|_| fingerprint(&item.request))
                    .transpose()?;
                let store_request = ReadEventsStoreRequest {
                    request: item.request,
                    acknowledgement_fingerprint,
                };
                store_requests.push(store_request);
                PreparedReadEventsBatchItem::Ready
            };
            prepared.push((item.correlation_id, outcome));
        }
        let store_results = if store_requests.is_empty() {
            Vec::new()
        } else {
            self.store
                .read_events_batch(authority.clone(), store_requests)
                .await
                .map_err(ServiceError::from)?
        };
        let mut store_results = store_results.into_iter();
        let mut results = Vec::with_capacity(prepared.len());
        for (correlation_id, item) in prepared {
            let outcome = match item {
                PreparedReadEventsBatchItem::Failed(error) => {
                    ReadEventsBatchItemOutcome::Failed(error)
                }
                PreparedReadEventsBatchItem::Ready => {
                    let Some(result) = store_results.next() else {
                        return Err(ServiceError::StorageCorrupt {
                            code: "event_read_batch_alignment_invalid",
                        });
                    };
                    match result {
                        Ok(receipt) => ReadEventsBatchItemOutcome::Read(receipt),
                        Err(StoreError::Unavailable { code }) => {
                            return Err(ServiceError::StorageUnavailable { code });
                        }
                        Err(StoreError::Corrupt { code }) => {
                            return Err(ServiceError::StorageCorrupt { code });
                        }
                        Err(error) => ReadEventsBatchItemOutcome::Failed(error.into()),
                    }
                }
            };
            results.push(ReadEventsBatchItemReceipt {
                correlation_id,
                outcome,
            });
        }
        if store_results.next().is_some() {
            return Err(ServiceError::StorageCorrupt {
                code: "event_read_batch_alignment_invalid",
            });
        }
        Ok(ReadEventsBatchReceipt {
            schema_version,
            authority,
            results,
        })
    }
}

pub fn create_run_target(request: &CreateRunRequest) -> Result<InteractionTarget, ServiceError> {
    request.validate()?;
    let fingerprint = create_run_fingerprint(request)?;
    target_from_fingerprint(request, &fingerprint)
}

pub fn worker_session_identity(
    session: &WorkerSessionGeneration,
) -> Result<SessionIdentityRef, ServiceError> {
    session.validate()?;
    let bytes = serde_json::to_vec(session).map_err(|_| ServiceError::StorageCorrupt {
        code: "serialization",
    })?;
    SessionIdentityRef::new(format!("session-{:x}", Sha256::digest(bytes)))
        .map_err(ServiceError::from)
}

fn target_from_fingerprint(
    request: &CreateRunRequest,
    fingerprint: &str,
) -> Result<InteractionTarget, ServiceError> {
    Ok(InteractionTarget {
        authority: request.authority.clone(),
        run_id: RunId::new(format!("run.{fingerprint}"))?,
        task_id: TaskId::new(format!("task.{fingerprint}"))?,
        dispatch_id: DispatchId::new(format!("dispatch.{fingerprint}"))?,
        generation: Generation::new(1)?,
    })
}

impl From<StoreError> for ServiceError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound { resource } => Self::NotFound { resource },
            StoreError::IdempotencyConflict => Self::IdempotencyConflict,
            StoreError::GenerationConflict => Self::GenerationConflict,
            StoreError::RevisionConflict => Self::RevisionConflict,
            StoreError::CapabilityDenied => Self::CapabilityDenied,
            StoreError::StateConflict { code } => Self::StateConflict { code },
            StoreError::Unavailable { code } => Self::StorageUnavailable { code },
            StoreError::Corrupt { code } => Self::StorageCorrupt { code },
        }
    }
}

fn fingerprint(value: &impl Serialize) -> Result<String, ServiceError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ServiceError::StorageCorrupt {
        code: "serialization",
    })?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn create_run_fingerprint(request: &CreateRunRequest) -> Result<String, ServiceError> {
    fingerprint(&(
        request.schema_version,
        &request.authority,
        &request.workflow_kind_ref,
        &request.task,
        &request.session,
        &request.integration_receipt,
        &request.runtime_ref,
        &request.target_reference,
        &request.idempotency_key,
    ))
}
