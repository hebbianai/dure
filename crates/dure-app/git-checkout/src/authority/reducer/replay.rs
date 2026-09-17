use super::super::registration::active_claim;
use super::*;

pub(super) fn replay_request(
    state: &State,
    request: &PreparedRequest,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    let operation = find_lifecycle_operation(state, request.operation_id.as_str())
        .ok_or_else(|| state_error("replayed checkout-use operation disappeared"))?;
    match &request.action {
        PreparedAction::Reserve { .. } => {
            let reservation = reservation_from_state(&request.authority, state)?;
            use_receipt(
                &operation.operation_id,
                &operation.request_digest,
                operation.revision,
                GitCheckoutUsePhaseV1::Creating,
                GitCheckoutUseOutcomeV1::CreationReserved { reservation },
            )
        }
        PreparedAction::AbortCreation { .. } => use_receipt(
            &operation.operation_id,
            &operation.request_digest,
            operation.revision,
            GitCheckoutUsePhaseV1::Removed,
            GitCheckoutUseOutcomeV1::CreationAborted {
                reservation: reservation_from_state(&request.authority, state)?,
            },
        ),
        PreparedAction::StartCreation { .. } => Err(GitCheckoutUseError::new(
            "checkout_use_creation_reconcile_required",
            "creation already started; inspect the frozen target before reconciling",
        )),
        PreparedAction::Activate {
            instance_digest, ..
        } => {
            let reservation = reservation_from_state(&request.authority, state)?;
            let claim = active_claim(state, &reservation.claim.claim_id)?;
            use_receipt(
                &operation.operation_id,
                &operation.request_digest,
                operation.revision,
                GitCheckoutUsePhaseV1::Active,
                GitCheckoutUseOutcomeV1::CreationActivated {
                    instance_digest: instance_digest.clone(),
                    claim: claim_wire(claim)?,
                },
            )
        }
        PreparedAction::Claim {
            instance_digest, ..
        } => {
            let claim = active_claim(state, &request.operation_id)?;
            use_receipt(
                &operation.operation_id,
                &operation.request_digest,
                operation.revision,
                GitCheckoutUsePhaseV1::Active,
                GitCheckoutUseOutcomeV1::ClaimAcquired {
                    instance_digest: instance_digest.clone(),
                    claim: claim_wire(claim)?,
                },
            )
        }
        PreparedAction::Release {
            instance_digest,
            claim_id,
            ..
        } => {
            let claim = state
                .claims
                .get(claim_id.as_str())
                .ok_or_else(|| state_error("replayed release lost its claim"))?;
            use_receipt(
                &operation.operation_id,
                &operation.request_digest,
                operation.revision,
                GitCheckoutUsePhaseV1::Active,
                GitCheckoutUseOutcomeV1::ClaimReleased {
                    instance_digest: instance_digest.clone(),
                    claim: claim_wire(claim)?,
                },
            )
        }
        PreparedAction::Permit {
            instance,
            instance_digest: _,
            retiring_claim_ids: _,
            policy: _,
        } => {
            let permit_revision = operation.revision;
            let permit = permit_from_state(&request.authority, state, instance)?;
            if state.phase() == Phase::Removed {
                let terminal = state
                    .terminal()
                    .ok_or_else(|| state_error("removed state lost its terminal receipt"))?;
                return use_receipt(
                    &operation.operation_id,
                    &operation.request_digest,
                    terminal.revision,
                    GitCheckoutUsePhaseV1::Removed,
                    GitCheckoutUseOutcomeV1::Removed {
                        permit,
                        removal: physical_receipt(instance, terminal.kind)?,
                    },
                );
            }
            if state
                .last_abort()
                .is_some_and(|abort| abort.token == permit.permit_token)
            {
                let abort = state.last_abort().expect("checked last abort");
                return use_receipt(
                    &operation.operation_id,
                    &operation.request_digest,
                    abort.revision,
                    GitCheckoutUsePhaseV1::Active,
                    GitCheckoutUseOutcomeV1::RemovalAborted { permit },
                );
            }
            use_receipt(
                &operation.operation_id,
                &operation.request_digest,
                permit_revision,
                GitCheckoutUsePhaseV1::Removing,
                GitCheckoutUseOutcomeV1::RemovalPermitted { permit },
            )
        }
        PreparedAction::AbortRemoval { instance, .. } => use_receipt(
            &operation.operation_id,
            &operation.request_digest,
            operation.revision,
            GitCheckoutUsePhaseV1::Active,
            GitCheckoutUseOutcomeV1::RemovalAborted {
                permit: permit_from_state(&request.authority, state, instance)?,
            },
        ),
        // Retirement records carry derived ids, so a retirement request never
        // matches a stored lifecycle operation and cannot reach a replay.
        PreparedAction::RetireAbsent => {
            Err(state_error("absent checkout retirement is not replayed"))
        }
    }
}
