use crate::catalog::validate_create_request;
use crate::{
    CatalogError, RemoteStandaloneCreateReceipt, RemoteStandaloneCreateRequest, SshExecConfig,
    create_standalone_over_ssh,
};
use hmux_client::recovery_journal::{
    RecoveryCompletion, RecoveryIdentity, RecoveryOperationPayload, RecoveryReservationState,
    request_fingerprint, reserve,
};
use std::path::Path;
use std::time::Duration;

const ACTION: &str = "remote_standalone_create_v1";

/// The adapter retains the original private proof until presentation consumes it.
/// It must never serialize this wrapper into a client receipt or pane binding.
pub struct RetainedRemoteStandaloneCreation {
    pub receipt: RemoteStandaloneCreateReceipt,
    pub launch_owner_proof: String,
}

impl std::fmt::Debug for RetainedRemoteStandaloneCreation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RetainedRemoteStandaloneCreation")
            .field("receipt", &self.receipt)
            .field("launch_owner_proof", &"<redacted>")
            .finish()
    }
}

/// Retain one complete request before crossing SSH. The caller supplies a stable
/// operation and a scope binding its destination and logical owner. Reopening
/// after caller/transport loss uses the first request and its private proof.
pub fn create_standalone_durably_over_ssh(
    discovery_root: &Path,
    scope: &str,
    ssh: SshExecConfig,
    request: RemoteStandaloneCreateRequest,
    timeout: Duration,
) -> Result<RetainedRemoteStandaloneCreation, CatalogError> {
    execute(discovery_root, scope, request, |prepared| {
        create_standalone_over_ssh(ssh, prepared, timeout)
    })
}

fn execute(
    discovery_root: &Path,
    scope: &str,
    request: RemoteStandaloneCreateRequest,
    create: impl FnOnce(
        RemoteStandaloneCreateRequest,
    ) -> Result<RemoteStandaloneCreateReceipt, CatalogError>,
) -> Result<RetainedRemoteStandaloneCreation, CatalogError> {
    validate_create_request(&request)?;
    if scope.is_empty() || scope.len() > 256 {
        return Err(CatalogError::Request(
            "remote create scope is invalid".into(),
        ));
    }
    // Geometry is replaceable after attachment. A retry cannot replace the
    // initial geometry or private proof, but must preserve every launch input.
    let semantic = serde_json::to_string(&(
        &request.target_session_id,
        &request.session_name,
        &request.bridge_nonce,
        &request.cwd,
        &request.command_intercepts,
        request.retirement_policy,
    ))
    .map_err(|_| journal_error())?;
    let digest = request_fingerprint(&[&request.request_id]);
    let identity = RecoveryIdentity {
        recovery_id: format!("remote-create-{digest}"),
        source_session_id: format!("operation-{digest}"),
        source_workspace_id: ACTION.into(),
        request_fingerprint: request_fingerprint(&[scope, &semantic]),
        action: ACTION,
    };
    let mut reservation = match reserve(discovery_root, identity).map_err(CatalogError::Request)? {
        RecoveryReservationState::Completed(completed) => {
            let checkpoint = completed.operation_checkpoint.ok_or_else(journal_error)?;
            let request: RemoteStandaloneCreateRequest =
                serde_json::from_str(&checkpoint.canonical_payload).map_err(|_| journal_error())?;
            let receipt = serde_json::from_str(
                checkpoint
                    .replacement_receipt
                    .as_deref()
                    .ok_or_else(journal_error)?,
            )
            .map_err(|_| journal_error())?;
            return Ok(RetainedRemoteStandaloneCreation {
                receipt,
                launch_owner_proof: request.launch_owner_proof,
            });
        }
        RecoveryReservationState::Pending(reservation) => reservation,
    };
    let prepared = match reservation.operation_checkpoint() {
        Some(checkpoint) => {
            serde_json::from_str(&checkpoint.canonical_payload).map_err(|_| journal_error())?
        }
        None => {
            let payload = serde_json::to_string(&request).map_err(|_| journal_error())?;
            reservation
                .prepare_operation_payload(
                    RecoveryOperationPayload::new(payload).map_err(CatalogError::Request)?,
                )
                .map_err(CatalogError::Request)?;
            request
        }
    };
    validate_create_request(&prepared)?;
    let proof = prepared.launch_owner_proof.clone();
    let receipt = create(prepared)?;
    reservation
        .checkpoint_replacement_receipt(
            serde_json::to_string(&receipt).map_err(|_| journal_error())?,
        )
        .map_err(CatalogError::Request)?;
    reservation
        .complete(RecoveryCompletion {
            target_session_id: receipt.session.session_id.clone(),
            target_workspace_id: receipt.session.workspace_id.clone(),
            // Gateway create-v1 does not report its build. No build claim is made.
            target_build_id: receipt
                .session
                .gateway_build_id
                .clone()
                .unwrap_or_else(|| "unreported".into()),
            action: ACTION.into(),
            outcome: "created".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .map_err(CatalogError::Request)?;
    Ok(RetainedRemoteStandaloneCreation {
        receipt,
        launch_owner_proof: proof,
    })
}

fn journal_error() -> CatalogError {
    CatalogError::Request("the retained remote create record is invalid".into())
}

#[cfg(test)]
mod tests;
