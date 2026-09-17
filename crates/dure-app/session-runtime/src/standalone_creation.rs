use dure_app::OperationIdV1;
use hmux_client::recovery_journal::prepared_standalone_create::execution::completion;
use hmux_client::recovery_journal::prepared_standalone_create::{
    PreparedStandaloneCreate, load_or_prepare,
};
use hmux_client::recovery_journal::{
    RecoveryIdentity, RecoveryOperationCheckpoint, RecoveryReservation, RecoveryReservationState,
    STANDALONE_CREATE_OPERATION_RECOVERY_ACTION, request_fingerprint, reserve,
};
use hmux_client::{
    CompletedStandaloneTarget, CreatedStandaloneSession, LocalSessionCatalog,
    StandaloneCreateRequest, StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity,
};

use crate::{CheckoutSessionRuntime, SessionCheckoutError};

mod execution;
mod retention;
pub(crate) use retention::reconcile_retention;

const CREATION_NAMESPACE: &str = "standalone-create";

#[cfg(all(test, unix))]
mod tests;

enum Creation {
    Pending(Box<(RecoveryReservation, StandaloneCreateRequest)>),
    Completed(Box<(String, CompletedStandaloneTarget)>),
    Refused { recovery_id: String, code: String },
}

impl CheckoutSessionRuntime {
    /// Freeze a caller's complete intent once, retain its checkout, then launch.
    /// Replays reopen the exact completed generation without issuing a create.
    pub async fn create_standalone(
        &self,
        operation: OperationIdV1,
        request: StandaloneCreateRequest,
    ) -> Result<CreatedStandaloneSession, SessionCheckoutError> {
        let runtime = self.clone();
        tokio::spawn(async move {
            let catalog = LocalSessionCatalog::new(&runtime.discovery_root);
            let preparation_catalog = catalog.clone();
            let creation = tokio::task::spawn_blocking(move || {
                prepare(&preparation_catalog, &operation, request)
            })
            .await??;
            let (recovery_id, result) = match creation {
                Creation::Pending(pending) => {
                    let (reservation, request) = *pending;
                    let recovery_id = reservation.recovery_id().to_owned();
                    let result = async {
                        runtime
                            .retain_creation_request(&recovery_id, &request)
                            .await?;
                        let creator = runtime.standalone_creator.clone();
                        tokio::task::spawn_blocking(move || {
                            execution::execute(catalog, creator, reservation, request)
                        })
                        .await?
                    }
                    .await;
                    (recovery_id, result)
                }
                Creation::Completed(completed) => {
                    let (recovery_id, target) = *completed;
                    let result = async {
                        Ok(tokio::task::spawn_blocking(move || {
                            CreatedStandaloneSession::from_completed_target(&target)
                        })
                        .await??)
                    }
                    .await;
                    (recovery_id, result)
                }
                Creation::Refused { recovery_id, code } => {
                    (recovery_id, Err(SessionCheckoutError::Journal(code)))
                }
            };
            let created = match result {
                Ok(created) => created,
                Err(error) => {
                    runtime.reconcile_creation_retention(&recovery_id).await?;
                    return Err(error);
                }
            };
            runtime
                .publish_creation_session(&recovery_id, &created)
                .await?;
            Ok(created)
        })
        .await?
    }
}

fn prepare(
    catalog: &LocalSessionCatalog,
    operation: &OperationIdV1,
    request: StandaloneCreateRequest,
) -> Result<Creation, SessionCheckoutError> {
    let digest = request_fingerprint(&[operation.as_str()]);
    let payload = serde_json::to_string(&request)?;
    let identity = RecoveryIdentity {
        recovery_id: format!("standalone-create-{digest}"),
        source_session_id: format!("intent-{digest}"),
        source_workspace_id: CREATION_NAMESPACE.into(),
        request_fingerprint: request_fingerprint(&[&payload]),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    };
    let recovery_id = identity.recovery_id.clone();
    match reserve(catalog.discovery_root(), identity).map_err(SessionCheckoutError::Journal)? {
        RecoveryReservationState::Completed(completed) => {
            let checkpoint = completed
                .operation_checkpoint
                .as_ref()
                .ok_or(SessionCheckoutError::MissingCreateIdentity)?;
            let request: StandaloneCreateRequest =
                serde_json::from_str(&checkpoint.canonical_payload)?;
            let target = request
                .recovery_identity()
                .ok_or(SessionCheckoutError::MissingCreateIdentity)?
                .target_session_id();
            if let Some(code) =
                hmux_client::recovery_journal::prepared_standalone_create::refusal::code(
                    &completed,
                    target,
                    CREATION_NAMESPACE,
                )
                .map_err(SessionCheckoutError::Journal)?
            {
                return Ok(Creation::Refused {
                    recovery_id,
                    code: code.into(),
                });
            }
            Ok(Creation::Completed(Box::new((
                recovery_id,
                completed_target(catalog, checkpoint)?,
            ))))
        }
        RecoveryReservationState::Pending(mut reservation) => {
            let prepared = load_or_prepare(&mut reservation, || {
                let mut proof = [0_u8; 32];
                getrandom::fill(&mut proof)
                    .map_err(|error| format!("session_checkout_random: {error}"))?;
                let proof: String = proof.iter().map(|byte| format!("{byte:02x}")).collect();
                let identity =
                    StandaloneRecoveryCreateIdentity::new(format!("standalone_{digest}"), proof)
                        .map_err(|error| error.to_string())?
                        .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound);
                let request = request
                    .with_recovery_identity(identity)
                    .map_err(|error| error.to_string())?;
                let target = CompletedStandaloneTarget::capacity_witness(catalog, &request)
                    .map_err(|error| error.to_string())?;
                let receipt = serde_json::to_string(&target).map_err(|error| error.to_string())?;
                Ok(PreparedStandaloneCreate::new(request)?
                    .with_completion_capacity(completion(&target), receipt))
            })
            .map_err(SessionCheckoutError::Journal)?;
            Ok(Creation::Pending(Box::new((reservation, prepared))))
        }
    }
}

fn completed_target(
    catalog: &LocalSessionCatalog,
    checkpoint: &RecoveryOperationCheckpoint,
) -> Result<CompletedStandaloneTarget, SessionCheckoutError> {
    let request: StandaloneCreateRequest = serde_json::from_str(&checkpoint.canonical_payload)?;
    Ok(CompletedStandaloneTarget::from_recovery_checkpoint(
        catalog,
        &request,
        checkpoint
            .replacement_receipt
            .as_deref()
            .ok_or(SessionCheckoutError::MissingCreateIdentity)?,
    )?)
}
