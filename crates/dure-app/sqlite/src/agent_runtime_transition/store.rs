use super::*;
use crate::{
    AgentRuntimeTransitionStore, DomainStoreFuture, SqliteDomainStore, agent_runtime_transition,
};

impl AgentRuntimeTransitionStore for SqliteDomainStore {
    fn agent_runtime_request_receipt<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentRuntimeRequestReceiptV1>> {
        Box::pin(request_replay::receipt(&self.pool, idempotency_key))
    }

    fn record_agent_runtime_unchanged_request<'a>(
        &'a self,
        idempotency_key: &'a str,
        fingerprint: &'a str,
        selection: &'a dure_app::AgentRuntimeSelectionV1,
        authority: &'a dure_app::AgentRuntimeBindingAuthorityV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeRequestReceiptV1> {
        Box::pin(request_replay::unchanged(
            &self.pool,
            idempotency_key,
            fingerprint,
            selection,
            authority,
        ))
    }

    fn initialize_agent_runtime_selection<'a>(
        &'a self,
        selection: &'a dure_app::AgentRuntimeSelectionV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeSelectionV1> {
        Box::pin(agent_runtime_transition::initialize_selection(
            &self.pool, selection,
        ))
    }

    fn agent_runtime_selection<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentRuntimeSelectionV1>> {
        Box::pin(agent_runtime_transition::selection(&self.pool, agent_id))
    }

    fn agent_runtime_startup_recovery_candidates(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>> {
        Box::pin(agent_runtime_transition::startup_recovery_candidates(
            &self.pool,
        ))
    }

    fn agent_runtime_incomplete_recovery_candidates(
        &self,
    ) -> DomainStoreFuture<'_, Vec<AgentIdV1>> {
        Box::pin(agent_runtime_transition::incomplete_recovery_candidates(
            &self.pool,
        ))
    }

    fn admit_agent_runtime_transition<'a>(
        &'a self,
        intent: &'a dure_app::AgentRuntimeTransitionIntentV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeTransitionRecordV1> {
        Box::pin(agent_runtime_transition::admit(&self.pool, intent, false))
    }

    fn admit_deferred_agent_runtime_transition<'a>(
        &'a self,
        intent: &'a dure_app::AgentRuntimeTransitionIntentV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeTransitionRecordV1> {
        Box::pin(agent_runtime_transition::admit(&self.pool, intent, true))
    }

    fn authorize_agent_runtime_transition_wake<'a>(
        &'a self,
        request: &'a dure_app::AgentRuntimeTransitionWakeRequestV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeTransitionEffectAuthorizationV1> {
        Box::pin(agent_runtime_transition::deferred::authorize_wake(
            &self.pool, request,
        ))
    }

    fn advance_agent_runtime_transition<'a>(
        &'a self,
        request: &'a dure_app::AgentRuntimeTransitionAdvanceRequestV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeTransitionRecordV1> {
        Box::pin(agent_runtime_transition::advance(&self.pool, request))
    }

    fn authorize_agent_runtime_transition_repair<'a>(
        &'a self,
        request: &'a dure_app::AgentRuntimeTransitionRepairRequestV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeTransitionEffectAuthorizationV1> {
        Box::pin(agent_runtime_transition::authorize_repair(
            &self.pool, request,
        ))
    }

    fn supersede_agent_runtime_transition<'a>(
        &'a self,
        request: &'a dure_app::AgentRuntimeTransitionSupersedeRequestV1,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeTransitionEffectAuthorizationV1> {
        Box::pin(agent_runtime_transition::supersede(&self.pool, request))
    }

    fn resume_agent_runtime_transition<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
        request_key: &'a str,
        request_fingerprint: &'a str,
    ) -> DomainStoreFuture<'a, dure_app::AgentRuntimeTransitionEffectAuthorizationV1> {
        Box::pin(agent_runtime_transition::resume(
            &self.pool,
            operation_id,
            request_key,
            request_fingerprint,
        ))
    }

    fn agent_runtime_transition<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentRuntimeTransitionRecordV1>> {
        Box::pin(agent_runtime_transition::transition(
            &self.pool,
            operation_id,
        ))
    }

    fn agent_runtime_transition_by_idempotency_key<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentRuntimeTransitionRecordV1>> {
        Box::pin(agent_runtime_transition::transition_by_idempotency_key(
            &self.pool,
            idempotency_key,
        ))
    }

    fn active_agent_runtime_transition<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentRuntimeTransitionRecordV1>> {
        Box::pin(agent_runtime_transition::active_transition(
            &self.pool, agent_id,
        ))
    }
}
