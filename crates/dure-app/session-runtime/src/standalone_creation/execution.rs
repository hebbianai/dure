use super::*;
use hmux_client::StandaloneSessionCreator;
use hmux_client::recovery_journal::prepared_standalone_create::execution as prepared_execution;

pub(super) fn execute(
    catalog: LocalSessionCatalog,
    creator: StandaloneSessionCreator,
    mut reservation: RecoveryReservation,
    request: StandaloneCreateRequest,
) -> Result<CreatedStandaloneSession, SessionCheckoutError> {
    let (created, target) = match reservation
        .operation_checkpoint()
        .and_then(|checkpoint| checkpoint.replacement_receipt.as_deref())
    {
        Some(saved) => {
            let target =
                CompletedStandaloneTarget::from_recovery_checkpoint(&catalog, &request, saved)?;
            (
                CreatedStandaloneSession::from_completed_target(&target)?,
                target,
            )
        }
        None => {
            return prepared_execution::launch(&catalog, &creator, &mut reservation, request)
                .map(|(created, _)| created)
                .map_err(Into::into);
        }
    };
    prepared_execution::complete(&mut reservation, completion(&target))
        .map_err(SessionCheckoutError::Journal)?;
    Ok::<_, SessionCheckoutError>(created)
}
