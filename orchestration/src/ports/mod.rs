//! Persistence and negotiated capability boundaries.

mod memory;
/// Adapter-facing transaction snapshot and transition engine.
///
/// Store adapters restore one authority-scoped snapshot inside their own
/// transaction, apply exactly one transition, and persist the resulting delta
/// before commit. This keeps SQL and deployment details outside the domain
/// while preventing adapters from reimplementing workflow semantics.
pub mod state;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::contract::{
    AnswerDecisionReceipt, AnswerDecisionRequest, CompleteDispatchReceipt, CompleteDispatchRequest,
    CreateRunReceipt, CreateRunRequest, DispatchContextReceipt, GetInteractionRequest,
    InspectEventsRequest, OpenInteractionReceipt, OpenInteractionRequest, ReadEventsReceipt,
    ReadEventsRequest, TransitionDeliveryWakeReceipt, TransitionDeliveryWakeRequest,
};
use crate::domain::{AuthorityScope, DispatchRecord, InteractionRecord, ValidationError};

pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StoreError>> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadEventsStoreRequest {
    pub request: ReadEventsRequest,
    pub acknowledgement_fingerprint: Option<String>,
}

pub type ReadEventsStoreResult = Result<ReadEventsReceipt, StoreError>;

#[derive(Clone)]
pub struct StoreHandle {
    inner: Arc<dyn Store>,
}

impl StoreHandle {
    pub fn new(store: impl Store + 'static) -> Self {
        Self {
            inner: Arc::new(store),
        }
    }

    pub(crate) fn create_run(
        &self,
        request: CreateRunRequest,
        context: DispatchContextReceipt,
        fingerprint: String,
    ) -> StoreFuture<'_, CreateRunReceipt> {
        self.inner.create_run(request, context, fingerprint)
    }

    pub(crate) fn open_interaction(
        &self,
        request: OpenInteractionRequest,
        fingerprint: String,
    ) -> StoreFuture<'_, OpenInteractionReceipt> {
        self.inner.open_interaction(request, fingerprint)
    }

    pub(crate) fn interaction<'a>(
        &'a self,
        request: &'a GetInteractionRequest,
    ) -> StoreFuture<'a, Option<InteractionRecord>> {
        self.inner.interaction(request)
    }

    pub(crate) fn answer_decision(
        &self,
        request: AnswerDecisionRequest,
        fingerprint: String,
    ) -> StoreFuture<'_, AnswerDecisionReceipt> {
        self.inner.answer_decision(request, fingerprint)
    }

    pub(crate) fn complete_dispatch(
        &self,
        request: CompleteDispatchRequest,
        fingerprint: String,
    ) -> StoreFuture<'_, CompleteDispatchReceipt> {
        self.inner.complete_dispatch(request, fingerprint)
    }

    pub(crate) fn inspect_events(
        &self,
        request: InspectEventsRequest,
    ) -> StoreFuture<'_, ReadEventsReceipt> {
        self.inner.inspect_events(request)
    }

    pub(crate) fn read_events(
        &self,
        request: ReadEventsRequest,
        acknowledgement_fingerprint: Option<String>,
    ) -> StoreFuture<'_, ReadEventsReceipt> {
        self.inner.read_events(request, acknowledgement_fingerprint)
    }

    pub(crate) fn read_events_batch(
        &self,
        authority: AuthorityScope,
        requests: Vec<ReadEventsStoreRequest>,
    ) -> StoreFuture<'_, Vec<ReadEventsStoreResult>> {
        self.inner.read_events_batch(authority, requests)
    }

    pub(crate) fn transition_delivery_wake(
        &self,
        request: TransitionDeliveryWakeRequest,
    ) -> StoreFuture<'_, TransitionDeliveryWakeReceipt> {
        self.inner.transition_delivery_wake(request)
    }
}

pub fn in_memory_store(dispatches: Vec<DispatchRecord>) -> Result<StoreHandle, ValidationError> {
    Ok(StoreHandle {
        inner: Arc::new(memory::InMemoryStore::new(dispatches)?),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StoreError {
    NotFound { resource: &'static str },
    IdempotencyConflict,
    GenerationConflict,
    RevisionConflict,
    CapabilityDenied,
    StateConflict { code: &'static str },
    Unavailable { code: &'static str },
    Corrupt { code: &'static str },
}

/// Adapter contract. Mutation methods are invoked only by [`crate::service::InteractionService`].
/// Each mutation commits every canonical record, receipt, and Event or none of them.
pub trait Store: Send + Sync {
    fn create_run<'a>(
        &'a self,
        request: CreateRunRequest,
        context: DispatchContextReceipt,
        fingerprint: String,
    ) -> StoreFuture<'a, CreateRunReceipt>;

    fn open_interaction<'a>(
        &'a self,
        request: OpenInteractionRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, OpenInteractionReceipt>;

    fn interaction<'a>(
        &'a self,
        request: &'a GetInteractionRequest,
    ) -> StoreFuture<'a, Option<InteractionRecord>>;

    fn answer_decision<'a>(
        &'a self,
        request: AnswerDecisionRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, AnswerDecisionReceipt>;

    fn complete_dispatch<'a>(
        &'a self,
        request: CompleteDispatchRequest,
        fingerprint: String,
    ) -> StoreFuture<'a, CompleteDispatchReceipt>;

    fn inspect_events<'a>(
        &'a self,
        request: InspectEventsRequest,
    ) -> StoreFuture<'a, ReadEventsReceipt>;

    fn read_events<'a>(
        &'a self,
        request: ReadEventsRequest,
        acknowledgement_fingerprint: Option<String>,
    ) -> StoreFuture<'a, ReadEventsReceipt>;

    fn read_events_batch<'a>(
        &'a self,
        authority: AuthorityScope,
        requests: Vec<ReadEventsStoreRequest>,
    ) -> StoreFuture<'a, Vec<ReadEventsStoreResult>>;

    fn transition_delivery_wake<'a>(
        &'a self,
        request: TransitionDeliveryWakeRequest,
    ) -> StoreFuture<'a, TransitionDeliveryWakeReceipt>;
}
