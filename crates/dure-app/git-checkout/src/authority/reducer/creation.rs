use super::*;

pub(super) fn abort(
    current: Option<&State>,
    request: &PreparedRequest,
    reservation_token: &str,
    quiescent_start: Option<&(OperationIdV1, String)>,
) -> Result<Plan, GitCheckoutUseError> {
    let state =
        current.ok_or_else(|| phase_conflict("checkout creation has no reservation to abort"))?;
    if state.phase() != Phase::Creating {
        return Err(phase_conflict(
            "checkout creation cannot be aborted in the current phase",
        ));
    }
    let slot = state
        .reservation()
        .ok_or_else(|| state_error("creating state lost its reservation"))?;
    if slot.token != reservation_token {
        return Err(GitCheckoutUseError::new(
            "checkout_use_operation_conflict",
            "creation abort did not consume the exact reservation",
        ));
    }
    match (state.creation_start(), quiescent_start) {
        (None, None) => {}
        (Some(start), Some((id, digest)))
            if start.operation_id == id.as_str() && start.request_digest == *digest => {}
        _ => {
            return Err(GitCheckoutUseError::new(
                "checkout_use_creation_reconcile_required",
                "creation abort requires the exact quiescent execution, or an unstarted reservation",
            ));
        }
    }
    let reservation = reservation_from_state(&request.authority, state)?;
    let new_revision = next_revision(state.revision)?;
    let mut next = state.clone();
    next.revision = new_revision;
    let terminal = TerminalOperation {
        operation_id: request.operation_id.as_str().to_string(),
        request_digest: request.request_digest.clone(),
    };
    next.lifecycle = Lifecycle::Removed(RemovedState::CreationAborted {
        reservation: slot.clone(),
        terminal: terminal.clone(),
    });
    Ok(Plan {
        state: Some(next),
        receipt: use_receipt(
            &terminal.operation_id,
            &terminal.request_digest,
            new_revision,
            GitCheckoutUsePhaseV1::Removed,
            GitCheckoutUseOutcomeV1::CreationAborted { reservation },
        )?,
        validate_instance: None,
        validate_absent_target: true,
    })
}
