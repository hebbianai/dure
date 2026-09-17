//! The shared fresh-launch boundary for already prepared standalone operations.

use super::super::{
    RecoveryCompletion, RecoveryReservation, STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME,
    STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
};
use crate::{
    ClientError, CompletedStandaloneTarget, CreatedStandaloneSession, LocalSessionCatalog,
    StandaloneCreateRequest, StandaloneSessionCreator, validate_standalone_recovery_receipt,
};

#[derive(Debug)]
pub enum LaunchError {
    Runtime(ClientError),
    Journal(String),
}

impl From<ClientError> for LaunchError {
    fn from(error: ClientError) -> Self {
        Self::Runtime(error)
    }
}

/// The caller owns preparation and resource admission. Launch only after it has
/// resolved any existing result checkpoint; this operation guard stays held
/// until the exact result or definitive refusal is durable.
pub fn launch(
    catalog: &LocalSessionCatalog,
    creator: &StandaloneSessionCreator,
    reservation: &mut RecoveryReservation,
    request: StandaloneCreateRequest,
) -> Result<(CreatedStandaloneSession, RecoveryCompletion), LaunchError> {
    let target_session_id = request
        .recovery_identity()
        .ok_or_else(|| LaunchError::Journal("hmux_standalone_create_operation_invalid".into()))?
        .target_session_id();
    let created = match creator.create(request.clone()) {
        Ok(created) => created,
        Err(error) if error.is_standalone_recovery_terminal_refusal() => {
            let completed = super::refusal::completion(
                target_session_id,
                &reservation.record.source_workspace_id,
                error.code(),
            );
            complete(reservation, completed).map_err(LaunchError::Journal)?;
            return Err(error.into());
        }
        Err(error) => return Err(error.into()),
    };
    validate_standalone_recovery_receipt(catalog, &request, created.receipt())?;
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )?;
    let serialized = serde_json::to_string(&target).map_err(|_| {
        LaunchError::Journal(
            "hmux_standalone_create_operation_invalid: target is not serializable".into(),
        )
    })?;
    reservation
        .checkpoint_replacement_receipt(serialized)
        .map_err(LaunchError::Journal)?;
    let completed = complete(reservation, completion(&target)).map_err(LaunchError::Journal)?;
    Ok((created, completed))
}

pub fn completion(target: &CompletedStandaloneTarget) -> RecoveryCompletion {
    RecoveryCompletion {
        target_session_id: target.receipt().session_id().into(),
        target_workspace_id: target.receipt().workspace_id().into(),
        target_build_id: target.host_build_version().into(),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION.into(),
        outcome: STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME.into(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    }
}

/// Complete with the operation's current frozen inputs and result checkpoint.
/// Normal launch, recovered completion and retired-operation cleanup use the
/// same journal writer; this function does not acquire or release ownership.
pub fn complete(
    reservation: &mut RecoveryReservation,
    mut completed: RecoveryCompletion,
) -> Result<RecoveryCompletion, String> {
    completed.operation_checkpoint = reservation.operation_checkpoint().cloned();
    reservation.complete(completed.clone())?;
    Ok(completed)
}
