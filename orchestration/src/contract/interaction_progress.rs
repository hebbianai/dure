use super::*;

/// Read-only projection of committed interaction and delivery facts. Observation
/// means an authenticated inbox read, not proof of human/model comprehension.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionProgressReceipt {
    pub schema_version: u16,
    pub interaction_id: InteractionId,
    pub target: InteractionTarget,
    pub accepted_at_ms: i64,
    pub dispatch_state: DispatchState,
    pub completed_at_ms: Option<i64>,
    pub worker_endpoint: DeliveryEndpointReceipt,
    /// Provider turn IDs are not recorded by the durable inbox. Do not correlate
    /// an unrelated current turn to this message from terminal activity.
    pub worker_turn_correlation: WorkerTurnCorrelation,
    pub deliveries: Vec<InteractionDeliveryProgress>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerTurnCorrelation {
    NotRecorded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionDeliveryProgress {
    pub delivery: DeliveryReceipt,
    pub queued_at_ms: i64,
    pub observed_at_ms: Option<i64>,
    pub acknowledged_at_ms: Option<i64>,
    pub guidance: DeliveryProgressGuidance,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryProgressGuidance {
    DispatchCompleted,
    AwaitCompletion,
    AwaitAcknowledgement,
    AwaitInboxRead,
    InspectBeforeRetry,
    ResolveExactSessionThenWait,
}

impl GetInteractionRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.authority.validate()?;
        self.interaction_id.validate()?;
        self.participant.validate()?;
        self.read_capability.validate()?;
        if let Some(fence) = &self.endpoint_fence {
            fence.validate()?;
        }
        Ok(())
    }
}
