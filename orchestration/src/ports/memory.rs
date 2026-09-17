use std::sync::Mutex;

use super::state::StoreState;
use super::{ReadEventsStoreRequest, ReadEventsStoreResult, Store, StoreError, StoreFuture};
use crate::contract::{
    AnswerDecisionReceipt, AnswerDecisionRequest, CompleteDispatchReceipt, CompleteDispatchRequest,
    CreateRunReceipt, CreateRunRequest, DispatchContextReceipt, GetInteractionRequest,
    InspectEventsRequest, OpenInteractionReceipt, OpenInteractionRequest, ReadEventsReceipt,
    ReadEventsRequest, TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest,
};
use crate::domain::AuthorityScope;
use crate::domain::{DispatchRecord, InteractionRecord, ValidationError};

/// Deterministic reference adapter used by headless clients and conformance tests.
pub struct InMemoryStore {
    state: Mutex<StoreState>,
}

impl InMemoryStore {
    pub fn new(dispatches: Vec<DispatchRecord>) -> Result<Self, ValidationError> {
        Ok(Self {
            state: Mutex::new(StoreState::seeded(dispatches)?),
        })
    }

    fn mutate<T>(
        &self,
        transition: impl FnOnce(&mut StoreState) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut guard = self.state.lock().map_err(|_| StoreError::Unavailable {
            code: "state_lock_poisoned",
        })?;
        let mut candidate = guard.clone();
        let result = transition(&mut candidate)?;
        *guard = candidate;
        Ok(result)
    }

    fn inspect<T>(
        &self,
        query: impl FnOnce(&StoreState) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let guard = self.state.lock().map_err(|_| StoreError::Unavailable {
            code: "state_lock_poisoned",
        })?;
        query(&guard)
    }
}

impl Store for InMemoryStore {
    fn create_run<'a>(
        &'a self,
        request: CreateRunRequest,
        context: DispatchContextReceipt,
        fingerprint: String,
    ) -> StoreFuture<'a, CreateRunReceipt> {
        Box::pin(
            async move { self.mutate(|state| state.create_run(request, context, fingerprint)) },
        )
    }

    fn open_interaction<'a>(
        &'a self,
        request: OpenInteractionRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, OpenInteractionReceipt> {
        Box::pin(async move { self.mutate(|state| state.open(request, fingerprint)) })
    }

    fn interaction<'a>(
        &'a self,
        request: &'a GetInteractionRequest,
    ) -> StoreFuture<'a, Option<InteractionRecord>> {
        Box::pin(async move { self.inspect(|state| Ok(state.interaction(request))) })
    }

    fn answer_decision<'a>(
        &'a self,
        request: AnswerDecisionRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, AnswerDecisionReceipt> {
        Box::pin(async move { self.mutate(|state| state.answer(request, fingerprint)) })
    }

    fn complete_dispatch<'a>(
        &'a self,
        request: CompleteDispatchRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, CompleteDispatchReceipt> {
        Box::pin(async move { self.mutate(|state| state.complete(request, fingerprint)) })
    }

    fn inspect_events<'a>(
        &'a self,
        request: InspectEventsRequest,
    ) -> StoreFuture<'a, ReadEventsReceipt> {
        Box::pin(async move { self.inspect(|state| state.inspect_events(&request)) })
    }

    fn read_events<'a>(
        &'a self,
        request: ReadEventsRequest,
        acknowledgement_fingerprint: Option<String>,
    ) -> StoreFuture<'a, ReadEventsReceipt> {
        Box::pin(async move {
            self.mutate(|state| {
                state
                    .read_events(request, acknowledgement_fingerprint)
                    .map(|(receipt, _changed)| receipt)
            })
        })
    }

    fn read_events_batch<'a>(
        &'a self,
        authority: AuthorityScope,
        requests: Vec<ReadEventsStoreRequest>,
    ) -> StoreFuture<'a, Vec<ReadEventsStoreResult>> {
        Box::pin(async move {
            self.mutate(|state| {
                state
                    .read_events_batch(&authority, requests)
                    .map(|(results, _changed)| results)
            })
        })
    }

    fn transition_delivery_wake<'a>(
        &'a self,
        request: TransitionDeliveryWakeRequest,
    ) -> StoreFuture<'a, TransitionDeliveryWakeReceipt> {
        Box::pin(async move { self.mutate(|state| state.transition_delivery_wake(request)) })
    }
}
