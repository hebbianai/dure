use super::*;

/// An immutable request outcome, separate from the runtime's mutable lifecycle.
/// A resumed intent owns effects; an unchanged selection is observation only.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentRuntimeRequestOutcomeV1 {
    Transition {
        operation_id: OperationIdV1,
    },
    Unchanged {
        selection: Box<AgentRuntimeSelectionV1>,
        authority: Box<AgentRuntimeBindingAuthorityV1>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeRequestReceiptV1 {
    pub fingerprint: String,
    pub outcome: AgentRuntimeRequestOutcomeV1,
}

pub trait AgentRuntimeTransitionStore: Send + Sync {
    fn agent_runtime_request_receipt<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeRequestReceiptV1>>;

    fn record_agent_runtime_unchanged_request<'a>(
        &'a self,
        idempotency_key: &'a str,
        fingerprint: &'a str,
        selection: &'a AgentRuntimeSelectionV1,
        authority: &'a AgentRuntimeBindingAuthorityV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeRequestReceiptV1>;

    fn initialize_agent_runtime_selection<'a>(
        &'a self,
        selection: &'a AgentRuntimeSelectionV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeSelectionV1>;

    fn agent_runtime_selection<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeSelectionV1>>;

    fn agent_runtime_startup_recovery_candidates(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>>;

    fn agent_runtime_incomplete_recovery_candidates(&self)
    -> DomainStoreFuture<'_, Vec<AgentIdV1>>;

    fn admit_agent_runtime_transition<'a>(
        &'a self,
        intent: &'a AgentRuntimeTransitionIntentV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeTransitionRecordV1>;

    fn advance_agent_runtime_transition<'a>(
        &'a self,
        request: &'a AgentRuntimeTransitionAdvanceRequestV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeTransitionRecordV1>;

    fn admit_deferred_agent_runtime_transition<'a>(
        &'a self,
        intent: &'a AgentRuntimeTransitionIntentV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeTransitionRecordV1>;

    fn authorize_agent_runtime_transition_wake<'a>(
        &'a self,
        request: &'a AgentRuntimeTransitionWakeRequestV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeTransitionEffectAuthorizationV1>;

    fn authorize_agent_runtime_transition_repair<'a>(
        &'a self,
        request: &'a AgentRuntimeTransitionRepairRequestV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeTransitionEffectAuthorizationV1>;

    fn resume_agent_runtime_transition<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
        request_key: &'a str,
        request_fingerprint: &'a str,
    ) -> DomainStoreFuture<'a, AgentRuntimeTransitionEffectAuthorizationV1>;

    fn supersede_agent_runtime_transition<'a>(
        &'a self,
        request: &'a AgentRuntimeTransitionSupersedeRequestV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeTransitionEffectAuthorizationV1>;

    fn agent_runtime_transition<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeTransitionRecordV1>>;

    fn agent_runtime_transition_by_idempotency_key<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeTransitionRecordV1>>;

    fn active_agent_runtime_transition<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeTransitionRecordV1>>;
}
