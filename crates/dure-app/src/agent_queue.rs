//! Accepted future input belongs to the conversation, independently of its views.

use serde::{Deserialize, Serialize};

use crate::{
    AgentClientMessageIdV1, AgentIdV1, AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1,
    AgentStartTurnIntentV1, AgentTimelineCursorV1, AgentTurnEffectReceiptV1, DomainStoreFuture,
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentQueuedTurnStateV1 {
    Queued,
    Dispatched,
    Canceled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentQueuedTurnRecordV1 {
    /// Immutable admission input. Dispatch binds the same conversation's current
    /// runtime in the existing turn-effect transaction, retaining this receipt.
    pub intent: AgentStartTurnIntentV1,
    pub state: AgentQueuedTurnStateV1,
    pub timeline_cursor: AgentTimelineCursorV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCancelQueuedTurnV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub client_message_id: AgentClientMessageIdV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentQueuedInputV1 {
    pub client_message_id: AgentClientMessageIdV1,
    pub sequence: i64,
    pub preview: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentQueuedInputPageV1 {
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub inputs: Vec<AgentQueuedInputV1>,
    pub next_after: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentQueueReadRequestV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub after_sequence: i64,
}

/// Read-only admission evidence; never grants provider execution authority.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentInputReceiptV1 {
    Queued { receipt: AgentQueuedTurnRecordV1 },
    Turn { receipt: AgentTurnEffectReceiptV1 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInputReadRequestV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub client_message_id: AgentClientMessageIdV1,
}

pub trait AgentQueuedTurnStore: Send + Sync {
    fn inspect_agent_input<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
        message: &'a AgentClientMessageIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentInputReceiptV1>>;

    fn enqueue_agent_turn<'a>(
        &'a self,
        intent: &'a AgentStartTurnIntentV1,
    ) -> DomainStoreFuture<'a, AgentQueuedTurnRecordV1>;

    fn cancel_queued_agent_turn<'a>(
        &'a self,
        request: &'a AgentCancelQueuedTurnV1,
        canceled_at_ms: i64,
    ) -> DomainStoreFuture<'a, AgentQueuedTurnRecordV1>;

    fn read_queued_agent_turns<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
        after_sequence: i64,
    ) -> DomainStoreFuture<'a, AgentQueuedInputPageV1>;

    fn has_queued_agent_turns<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
    ) -> DomainStoreFuture<'a, bool>;

    fn agents_with_queued_turns(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>>;

    /// Atomically claims the oldest input and prepares its existing turn effect.
    /// A replay never obtains permission to execute that effect again.
    fn prepare_queued_agent_turn<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
        runtime: &'a AgentProviderRuntimeFenceV1,
        dispatched_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentTurnEffectReceiptV1>>;
}
