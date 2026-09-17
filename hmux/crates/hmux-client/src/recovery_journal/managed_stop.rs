//! Exact stop intent decoding shared by execution replay and completed-only observation.

use super::*;
use hmux_runtime_contract::{ManagedStopReconcileRequest, ManagedStopRequest};

#[cfg(all(test, feature = "local-runtime"))]
mod tests;

pub fn identity(stop_id: &str, session_id: &str, workspace_id: &str) -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: format!("managed-stop-v1:{workspace_id}:{session_id}:{stop_id}"),
        source_session_id: session_id.to_string(),
        source_workspace_id: workspace_id.to_string(),
        action: MANAGED_STOP_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    }
}

/// Read the exact completed generation, without continuing a pending stop or
/// closing its logical session. The permanent ledger survives journal compaction.
pub fn read_completed(
    discovery_root: &Path,
    request: &ManagedStopReconcileRequest,
) -> Result<Option<ManagedStopReceipt>, String> {
    request.validate().map_err(|error| error.to_string())?;
    let identity = identity(
        request.stop_id(),
        request.session_id(),
        request.workspace_id(),
    );
    let Some(record) =
        existing_operation::read_existing_record(discovery_root, &identity.recovery_id)?
    else {
        return managed_create_ledger::final_stop_receipt(discovery_root, request);
    };
    validate_prepared_record(&record, &identity, None)?;
    if matches!(record.state, RecoveryRecordState::Reserved { .. }) {
        // Retirement commits before the bounded journal completion. A crash
        // between them leaves a pending journal, not an unfinished provider stop.
        return managed_create_ledger::final_stop_receipt(discovery_root, request);
    }
    let completion = completed_from_record(&record)?;
    validate_reconcile_request(request, &decode_completed_request(&completion)?)?;
    if completion.outcome == "refused_precondition" {
        return Ok(None);
    }
    let receipt = completed_receipt(&completion)?;
    validate_reconcile_receipt(request, &receipt)?;
    Ok(Some(receipt))
}

pub fn decode_completed_request(
    completion: &RecoveryCompletion,
) -> Result<ManagedStopRequest, String> {
    let serialized = completion
        .operation_checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.canonical_payload.as_str())
        .ok_or_else(|| "completed managed stop request is missing".to_string())?;
    let request: ManagedStopRequest = serde_json::from_str(serialized)
        .map_err(|error| format!("decode durable managed stop request failed: {error}"))?;
    request
        .validate_complete_fence()
        .map_err(|error| format!("durable managed stop request is invalid: {error}"))?;
    Ok(request)
}

pub fn completed_receipt(completion: &RecoveryCompletion) -> Result<ManagedStopReceipt, String> {
    if completion.action != MANAGED_STOP_RECOVERY_ACTION {
        return Err("completed managed stop action changed".into());
    }
    let serialized = completion
        .operation_checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint.source_stop_receipt.as_deref())
        .ok_or_else(|| "completed managed stop receipt is missing".to_string())?;
    decode_receipt(serialized)
}

pub fn decode_receipt(serialized: &str) -> Result<ManagedStopReceipt, String> {
    let receipt: ManagedStopReceipt = serde_json::from_str(serialized)
        .map_err(|error| format!("decode completed managed stop receipt failed: {error}"))?;
    receipt
        .validate()
        .map_err(|error| format!("completed managed stop receipt is invalid: {error}"))?;
    Ok(receipt)
}

pub fn validate_reconcile_receipt(
    request: &ManagedStopReconcileRequest,
    receipt: &ManagedStopReceipt,
) -> Result<(), String> {
    if ManagedStopReconcileRequest::from_stop_receipt(receipt).map_err(|error| error.to_string())?
        != *request
    {
        return Err(
            "managed stop reconcile receipt does not match the durable operation identity".into(),
        );
    }
    Ok(())
}

pub fn validate_reconcile_request(
    reconciliation: &ManagedStopReconcileRequest,
    stored: &ManagedStopRequest,
) -> Result<(), String> {
    if ManagedStopReconcileRequest::from_stop_request(stored).map_err(|error| error.to_string())?
        != *reconciliation
    {
        return Err("pending managed stop request changed durable operation identity".into());
    }
    Ok(())
}
