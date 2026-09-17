//! Explicit goal intent. Work selection belongs to the connected agent;
//! continuation reuses the conversation's durable turn-effect authority.

use serde::{Deserialize, Serialize};

use crate::{
    AgentIdV1, AgentStartTurnIntentV1, AgentTimelineCursorV1, AgentTurnEffectReceiptV1,
    DomainStoreErrorV1, DomainStoreFuture,
};

pub const AGENT_GOAL_SCHEMA_VERSION_V1: u16 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentGoalStatusV1 {
    Active,
    Paused,
    Complete,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentGoalRecordV1 {
    pub schema_version: u16,
    pub agent_id: AgentIdV1,
    pub revision: u64,
    pub objective: String,
    pub status: AgentGoalStatusV1,
    pub detail: Option<String>,
    pub activation_cursor: AgentTimelineCursorV1,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentGoalPutRequestV1 {
    pub schema_version: u16,
    pub agent_id: AgentIdV1,
    pub expected_revision: u64,
    pub idempotency_key: String,
    pub objective: String,
    pub status: AgentGoalStatusV1,
    pub detail: Option<String>,
}

impl AgentGoalPutRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_GOAL_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "unsupported goal schema"));
        }
        if self.objective.trim().is_empty() || self.objective.len() > 16 * 1024 {
            return Err(invalid(
                "objective",
                "must contain 1 to 16384 bytes of text",
            ));
        }
        if self.idempotency_key.is_empty() || self.idempotency_key.len() > 160 {
            return Err(invalid("idempotencyKey", "must contain 1 to 160 bytes"));
        }
        if self
            .detail
            .as_ref()
            .is_some_and(|detail| detail.len() > 16 * 1024)
        {
            return Err(invalid("detail", "must contain at most 16384 bytes"));
        }
        Ok(())
    }
}

fn invalid(field: &'static str, reason: &str) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

/// This request is constructed by the goal runtime from the current goal and
/// conversation. The store rechecks both in the same transaction as turn intent.
#[derive(Clone, Debug)]
pub struct AgentGoalTurnRequestV1 {
    pub agent_id: AgentIdV1,
    pub goal_revision: u64,
    pub expected_cursor: AgentTimelineCursorV1,
    pub intent: AgentStartTurnIntentV1,
}

pub trait AgentGoalStore: Send + Sync {
    fn agent_goal<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentGoalRecordV1>>;

    fn put_agent_goal<'a>(
        &'a self,
        request: &'a AgentGoalPutRequestV1,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, AgentGoalRecordV1>;

    fn active_agent_goals(&self) -> DomainStoreFuture<'_, Vec<AgentGoalRecordV1>>;

    fn prepare_agent_goal_turn<'a>(
        &'a self,
        request: &'a AgentGoalTurnRequestV1,
    ) -> DomainStoreFuture<'a, Option<AgentTurnEffectReceiptV1>>;

    fn fail_agent_goal<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
        expected_revision: u64,
        detail: &'a str,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentGoalRecordV1>>;
}
