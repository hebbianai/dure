use super::{
    RecoveryCompletion, RecoveryOperationCheckpoint, RecoveryOperationPayload, RecoveryReservation,
};
use crate::StandaloneCreateRequest;

#[cfg(feature = "local-runtime")]
pub mod execution;
pub mod refusal;

#[cfg(test)]
mod tests;

/// Full launch inputs and optional completion capacity to persist before creation.
pub struct PreparedStandaloneCreate {
    request: StandaloneCreateRequest,
    payload: RecoveryOperationPayload,
    completion_capacity: Option<RecoveryCompletion>,
}

impl PreparedStandaloneCreate {
    pub fn new(request: StandaloneCreateRequest) -> Result<Self, String> {
        let canonical_payload = serde_json::to_string(&request)
            .map_err(|_| "standalone create request is not serializable".to_string())?;
        let payload = RecoveryOperationPayload::new(canonical_payload)?;
        Ok(Self {
            request,
            payload,
            completion_capacity: None,
        })
    }

    pub fn with_completion_capacity(
        mut self,
        mut completion: RecoveryCompletion,
        replacement_receipt: String,
    ) -> Self {
        completion.operation_checkpoint = Some(RecoveryOperationCheckpoint {
            canonical_payload: self.payload.as_str().to_string(),
            source_stop_receipt: None,
            replacement_receipt: Some(replacement_receipt),
        });
        self.completion_capacity = Some(completion);
        self
    }
}

/// Replay the immutable saved request, or durably publish it before returning.
/// The preparation callback runs only when the journal has no saved request.
pub fn load_or_prepare<F>(
    reservation: &mut RecoveryReservation,
    prepare: F,
) -> Result<StandaloneCreateRequest, String>
where
    F: FnOnce() -> Result<PreparedStandaloneCreate, String>,
{
    if let Some(checkpoint) = reservation.operation_checkpoint() {
        return read_request(checkpoint);
    }

    let prepared = prepare()?;
    if let Some(completion) = prepared.completion_capacity {
        reservation.prepare_operation_payload_for_completion(prepared.payload, completion)?;
    } else {
        reservation.prepare_operation_payload(prepared.payload)?;
    }
    Ok(prepared.request)
}

/// Decode the same immutable request for replay and later replacement.
pub fn read_request(
    checkpoint: &RecoveryOperationCheckpoint,
) -> Result<StandaloneCreateRequest, String> {
    let request: StandaloneCreateRequest = serde_json::from_str(&checkpoint.canonical_payload)
        .map_err(|_| "saved standalone create request is malformed".to_string())?;
    request
        .validate()
        .map_err(|_| "saved standalone create request is invalid".to_string())?;
    Ok(request)
}
