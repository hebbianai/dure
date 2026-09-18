//! One retained recovery intent linking the runtime and turn-effect journals.

use serde::{Deserialize, Serialize};

use crate::{
    AgentContinueTurnRequestV1, AgentIdV1, AgentInteractionBindingV1, AgentTimelineFailureV1,
    AgentTurnEffectReceiptV1, DomainStoreFuture, ProviderRecoveryAccountV1,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRecoveryRecordV1 {
    pub schema_version: u16,
    pub attempt_id: String,
    pub source: AgentInteractionBindingV1,
    pub source_selection_revision: i64,
    pub failure: AgentTimelineFailureV1,
    pub input: String,
    pub is_goal_continuation: bool,
    pub goal_revision: Option<u64>,
    pub policy_revision: u64,
    pub target: Option<ProviderRecoveryAccountV1>,
    /// Once present, the existing turn-effect receipt owns the send outcome.
    pub continuation: Option<AgentContinueTurnRequestV1>,
    pub stopped: Option<AgentRecoveryStopV1>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentRecoveryStopV1 {
    Exhausted,
    Superseded,
    Failed { code: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The latest recovery only while its original failure or retained turn owns
/// the current conversation boundary. Historical attempts remain in the journal.
pub struct AgentRecoveryObservationV1 {
    pub attempt_id: String,
    pub failure_item_id: crate::AgentTimelineItemIdV1,
    pub target: Option<ProviderRecoveryAccountV1>,
    pub stopped: Option<AgentRecoveryStopV1>,
    pub turn_state: Option<crate::AgentTurnEffectStateV1>,
    pub created_at_ms: i64,
}

pub trait AgentRecoveryStore: Send + Sync {
    fn latest_agent_recovery<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryObservationV1>>;

    /// Reads the current failed conversation and selects from its owning
    /// backend's explicitly configured pool in the same transaction.
    fn prepare_agent_recovery<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryRecordV1>>;

    fn agent_recovery<'a>(
        &'a self,
        attempt_id: &'a str,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryRecordV1>>;

    fn agents_with_recovery(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>>;

    /// Atomically retains the exact continuation and admits its existing
    /// turn effect. Replays never receive a fresh execution claim.
    fn prepare_agent_recovery_turn<'a>(
        &'a self,
        attempt_id: &'a str,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentTurnEffectReceiptV1>>;

    fn stop_agent_recovery<'a>(
        &'a self,
        attempt_id: &'a str,
        reason: &'a AgentRecoveryStopV1,
    ) -> DomainStoreFuture<'a, AgentRecoveryRecordV1>;
}
