use super::*;
use hmux_client::recovery_journal::{
    RecoveryCompletion, RecoveryReservation, RecoveryReservationState,
    managed_replacement::{ACTION, PreparedReplacement, identity, replay_request},
    reserve_prepared_observed,
};
use hmux_runtime_contract::{ManagedCreateGenerationFence, ManagedCreateReceipt};
use std::path::Path;

/// Pending execution resumes its frozen launch. Completed replay uses the same
/// target identity with ordinary advance, including an exited target/new policy.
pub(super) fn resume(
    request: &ManagedCreateRequest,
) -> Result<Option<ManagedCreateAdvanceBrokerResponse>, String> {
    let catalog = LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?;
    let Some(request) = replay_request(catalog.discovery_root(), request)? else {
        return Ok(None);
    };
    let reserved = {
        #[cfg(unix)]
        let timing = broker_timing::phase(Phase::ReplacementReservation);
        reserve_prepared_observed(
            catalog.discovery_root(),
            identity(&request),
            None,
            |_step| {
                #[cfg(unix)]
                {
                    timing.reservation_step(_step)
                }
            },
        )
    }?;
    match reserved {
        RecoveryReservationState::Pending(reservation) => {
            continue_pending(catalog.discovery_root(), reservation, None).map(Some)
        }
        RecoveryReservationState::Completed(_) => {
            let target = replacement_root_request(&request).map_err(|error| error.to_string())?;
            Ok(Some(launch_target(&target, false)))
        }
    }
}

pub(super) fn execute(
    request: ManagedCreateRequest,
    stop: ManagedStopRequest,
    ready: Option<Box<ManagedCreateReceipt>>,
) -> Result<ManagedCreateAdvanceBrokerResponse, String> {
    let catalog = LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?;
    let identity = identity(&request);
    let prepared = PreparedReplacement { request, stop };
    let payload = serde_json::to_string(&prepared).map_err(|error| error.to_string())?;
    let reserved = {
        #[cfg(unix)]
        let timing = broker_timing::phase(Phase::ReplacementReservation);
        reserve_prepared_observed(catalog.discovery_root(), identity, Some(payload), |_step| {
            #[cfg(unix)]
            {
                timing.reservation_step(_step)
            }
        })
    }?;
    match reserved {
        RecoveryReservationState::Pending(reservation) => {
            continue_pending(catalog.discovery_root(), reservation, ready)
        }
        RecoveryReservationState::Completed(_) => {
            let target =
                replacement_root_request(&prepared.request).map_err(|error| error.to_string())?;
            Ok(ready
                .map(ManagedCreateAdvanceBrokerResponse::Advanced)
                .unwrap_or_else(|| launch_target(&target, false)))
        }
    }
}

fn continue_pending(
    root: &Path,
    mut reservation: RecoveryReservation,
    ready: Option<Box<ManagedCreateReceipt>>,
) -> Result<ManagedCreateAdvanceBrokerResponse, String> {
    let payload = &reservation
        .operation_checkpoint()
        .ok_or("managed replacement has no prepared operation")?
        .canonical_payload;
    let prepared = PreparedReplacement::from_payload(payload, reservation.recovery_id())?;
    let source = ManagedCreateReconcileRequest::new(
        prepared.request.idempotency_key(),
        prepared.request.session_id(),
        prepared.request.workspace_id(),
    )
    .map_err(|error| error.to_string())?;
    let stop = &prepared.stop;
    let expected = ManagedCreateGenerationFence::new(
        stop.expected_runner_principal()
            .expect("validated complete fence"),
        stop.expected_runner_instance()
            .expect("validated complete fence"),
        stop.expected_channel_epoch()
            .expect("validated complete fence"),
        stop.expected_host_instance_id()
            .expect("validated complete fence"),
        stop.expected_terminal_epoch()
            .expect("validated complete fence"),
    )
    .map_err(|error| error.to_string())?;
    // Persist the complete launch before closing source admission or stopping
    // its process. Reconnects consume this journal, never new client hints.
    let closed = {
        #[cfg(unix)]
        let _phase = broker_timing::phase(Phase::SourceClose);
        managed_create_ledger::close_exact_create(root, &source, &expected)
    }
    .map_err(|error| error.to_string())?;
    if !closed {
        return Err("managed replacement source has a competing successor or generation".into());
    }
    let stopped = {
        #[cfg(unix)]
        let _phase = broker_timing::phase(Phase::SourceStop);
        stop_managed_provider(stop)
    }
    .map_err(|error| error.to_string())?;
    reservation.checkpoint_source_stop_receipt(
        serde_json::to_string(&stopped).map_err(|error| error.to_string())?,
    )?;
    let target = replacement_root_request(&prepared.request).map_err(|error| error.to_string())?;
    let result = ready
        .map(ManagedCreateAdvanceBrokerResponse::Advanced)
        .unwrap_or_else(|| launch_target(&target, true));
    if let ManagedCreateAdvanceBrokerResponse::Advanced(receipt) = &result {
        #[cfg(unix)]
        let _phase = broker_timing::phase(Phase::ReplacementCompletion);
        inject_advance_fault("replacement_after_target_ready_before_completion");
        // Publish the receipt and completion together. A separate pending
        // receipt could conflict with the same target's Reused replay outcome.
        let mut checkpoint = reservation
            .operation_checkpoint()
            .cloned()
            .expect("prepared replacement retains its operation checkpoint");
        checkpoint.replacement_receipt =
            Some(serde_json::to_string(receipt).map_err(|error| error.to_string())?);
        reservation.complete(RecoveryCompletion {
            target_session_id: receipt.session_id().into(),
            target_workspace_id: receipt.workspace_id().into(),
            target_build_id: crate::HOST_BUILD_ID.into(),
            action: ACTION.into(),
            outcome: "replaced".into(),
            resume_checkpoint: None,
            operation_checkpoint: Some(checkpoint),
        })?;
    }
    Ok(result)
}
