use super::{
    PreparedRecoveryIdentity,
    existing_operation::{self, RecoveryOperationObservation},
    request_fingerprint,
};
use hmux_runtime_contract::{ManagedCreateRequest, ManagedStopRequest};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[cfg(test)]
mod tests;

pub const ACTION: &str = "managed_replace_current_v1";

#[derive(Deserialize, Serialize)]
pub struct PreparedReplacement {
    pub request: ManagedCreateRequest,
    pub stop: ManagedStopRequest,
}

pub fn identity(request: &ManagedCreateRequest) -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: format!(
            "managed-replacement-{}",
            request_fingerprint(&[
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            ])
        ),
        source_session_id: request.session_id().into(),
        source_workspace_id: request.workspace_id().into(),
        action: ACTION,
        legacy_request_fingerprint: None,
    }
}

impl PreparedReplacement {
    /// Parse the immutable operation at its journal boundary. Destructive
    /// generation admission remains with the existing create and stop ledgers.
    pub fn from_payload(payload: &str, recovery_id: &str) -> Result<Self, String> {
        let prepared: Self = serde_json::from_str(payload).map_err(|error| error.to_string())?;
        prepared
            .request
            .validate()
            .map_err(|error| error.to_string())?;
        prepared
            .stop
            .validate_complete_fence()
            .map_err(|error| error.to_string())?;
        if identity(&prepared.request).recovery_id != recovery_id
            || prepared.stop.session_id() != prepared.request.session_id()
            || prepared.stop.workspace_id() != prepared.request.workspace_id()
        {
            return Err("managed replacement source identity changed".into());
        }
        Ok(prepared)
    }
}

/// Pending execution retains its complete launch. A completed operation retains
/// target identity while allowing new launch policy for ordinary replay/advance.
/// This read neither reserves execution nor grants source-stop authority.
pub fn replay_request(
    root: &Path,
    request: &ManagedCreateRequest,
) -> Result<Option<ManagedCreateRequest>, String> {
    let expected = identity(request);
    let Some(observation) = existing_operation::read(root, &expected.recovery_id, ACTION)? else {
        return Ok(None);
    };
    let (identity, checkpoint, completed) = match observation {
        RecoveryOperationObservation::Pending {
            identity,
            checkpoint,
        } => (identity, checkpoint, false),
        RecoveryOperationObservation::Completed {
            identity,
            completion,
        } => (identity, completion.operation_checkpoint, true),
    };
    let checkpoint = checkpoint.ok_or("managed replacement has no prepared operation")?;
    if identity.source_session_id != expected.source_session_id
        || identity.source_workspace_id != expected.source_workspace_id
        || identity.request_fingerprint != request_fingerprint(&[&checkpoint.canonical_payload])
    {
        return Err("managed replacement journal identity changed".into());
    }
    let prepared =
        PreparedReplacement::from_payload(&checkpoint.canonical_payload, &expected.recovery_id)?;
    if !completed {
        return Ok(Some(prepared.request));
    }
    if request.provider_id() != prepared.request.provider_id()
        || request.conversation_identity().is_some()
            && request.conversation_identity() != prepared.request.conversation_identity()
    {
        return Err("managed replacement target identity changed".into());
    }
    let request = match prepared.request.conversation_identity() {
        Some(conversation) => request
            .clone()
            .with_conversation_identity(conversation.clone())
            .map_err(|error| error.to_string())?,
        None => request.clone(),
    };
    Ok(Some(request))
}
