use super::super::{
    launch_managed, managed_create_failure, managed_create_intent, managed_create_reconcile,
    stop_managed_provider,
};
use super::*;
use hmux_client::managed_replacement_root_request as replacement_root_request;

#[path = "replacement/retirement.rs"]
mod retirement;

/// Exact Resume is a target-first transaction. The target identity is derived
/// by Hmux and launched as an independent root, so an absent or pre-ledger
/// source cannot reject the attempt. A live writer is the only launch outcome
/// that requires exact source retirement before replaying the same target.
pub(super) fn execute(source_request: ManagedCreateRequest) -> ManagedCreateAdvanceBrokerResponse {
    let replay = {
        #[cfg(unix)]
        let _phase = broker_timing::phase(Phase::ReplacementReplay);
        retirement::resume(&source_request)
    };
    match replay {
        Ok(Some(response)) => return response,
        Ok(None) => {}
        Err(error) => return retirement_failure(error),
    }
    let target_request = match replacement_root_request(&source_request) {
        Ok(request) => request,
        Err(error) => return admission_failure(error, false),
    };
    let writer_conflict = match launch_target(&target_request, false) {
        ManagedCreateAdvanceBrokerResponse::Advanced(ready) => {
            return match replacement_source_stop_request(&source_request) {
                Ok(Some(stop)) => retirement::execute(source_request, stop, Some(ready))
                    .unwrap_or_else(retirement_failure),
                _ => {
                    // Compatibility for an already-finalized source written
                    // before replacement intents existed. No successor is followed.
                    if let Ok(catalog) = LocalSessionCatalog::from_environment() {
                        if let Ok(identity) = ManagedCreateReconcileRequest::new(
                            source_request.idempotency_key(),
                            source_request.session_id(),
                            source_request.workspace_id(),
                        ) {
                            let _ = managed_create_ledger::close_finalized_create(
                                catalog.discovery_root(),
                                &identity,
                            );
                        }
                    }
                    ManagedCreateAdvanceBrokerResponse::Advanced(ready)
                }
            };
        }
        ManagedCreateAdvanceBrokerResponse::Refused(failure)
            if failure.code == MANAGED_CONVERSATION_WRITER_CONFLICT_CODE =>
        {
            failure.message
        }
        other => return other,
    };

    let stop_request = match replacement_source_stop_request(&source_request) {
        Ok(Some(request)) => request,
        Ok(None) | Err(_) => {
            return ManagedCreateAdvanceBrokerResponse::refused(
                MANAGED_CONVERSATION_WRITER_CONFLICT_CODE,
                writer_conflict,
            );
        }
    };
    // Retiring this source can release only its own conversation writer claim.
    // A conflict on another conversation must preserve both live generations.
    if !matches!(
        (stop_request.expected_conversation(), target_request.conversation_identity()),
        (Some(source), Some(target))
            if source.provider_id() == target.provider_id()
                && source.conversation_id() == Some(target.conversation_id())
    ) {
        return ManagedCreateAdvanceBrokerResponse::refused(
            MANAGED_CONVERSATION_WRITER_CONFLICT_CODE,
            writer_conflict,
        );
    }
    retirement::execute(source_request, stop_request, None).unwrap_or_else(retirement_failure)
}

fn retirement_failure(error: String) -> ManagedCreateAdvanceBrokerResponse {
    ManagedCreateAdvanceBrokerResponse::authority_unavailable(AUTHORITY_UNAVAILABLE_CODE, error)
}

/// A replacement root is durable too: retries after its exit must follow the
/// existing ledger successor, never invent another root or reuse a tombstone.
fn launch_target(
    target_request: &ManagedCreateRequest,
    durable_effect: bool,
) -> ManagedCreateAdvanceBrokerResponse {
    #[cfg(unix)]
    let _phase = broker_timing::phase(Phase::TargetLaunch);
    let launched = launch_managed(target_request.clone()).or_else(|error| {
        if managed_create_failure::admission_code(error.as_ref())
            == Some(MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE)
        {
            if let Some(receipt) = completed_replacement_root_receipt(target_request) {
                return managed_create_intent::replay_completed_receipt(
                    receipt.discovery_root(),
                    receipt.clone(),
                );
            }
        }
        Err(error)
    });
    let error = match launched {
        Ok(receipt) => return ManagedCreateAdvanceBrokerResponse::Advanced(Box::new(receipt)),
        Err(error) => error,
    };
    if managed_create_failure::admission_code(error.as_ref())
        == Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
    {
        let prepared = match target_is_prepared(target_request) {
            Ok(prepared) => prepared,
            Err(error) => return admission_failure(error, durable_effect),
        };
        // A resource-prepared target has not attempted execution. Preserve its
        // identity and return the writer conflict to the target-first executor;
        // absence reconciliation here would abandon the target before the
        // executor can retire its exact source and retry this same root.
        if prepared {
            return ManagedCreateAdvanceBrokerResponse::refused(
                MANAGED_CONVERSATION_WRITER_CONFLICT_CODE,
                error.to_string(),
            );
        }
    }
    // A living successor can own the writer claim while this root is retired.
    // The existing advance authority distinguishes that replay from an unrelated writer.
    if managed_create_failure::exact_exited_generation(error.as_ref()).is_some()
        || matches!(
            managed_create_failure::admission_code(error.as_ref()),
            Some(MANAGED_CREATE_RETIRED_EXACT_CODE | MANAGED_CONVERSATION_WRITER_CONFLICT_CODE)
        )
    {
        return match execute_advance(target_request.clone()) {
            ManagedCreateAdvanceBrokerResponse::Current(receipt) => {
                ManagedCreateAdvanceBrokerResponse::Advanced(receipt)
            }
            other => other,
        };
    }
    if let Some(code) = managed_create_failure::admission_code(error.as_ref()) {
        admission_launch_failure(durable_effect, code, error.to_string())
    } else {
        transient_launch_failure(
            durable_effect,
            managed_create_failure::failure_code(error.as_ref())
                .unwrap_or("hmux_managed_launch_failed"),
            error.to_string(),
        )
    }
}

fn target_is_prepared(target: &ManagedCreateRequest) -> Result<bool, ManagedCreateAdmissionError> {
    use managed_create_ledger::ManagedCreateReconcileLedgerState;
    let catalog = LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?;
    let identity = ManagedCreateReconcileRequest::new(
        target.idempotency_key(),
        target.session_id(),
        target.workspace_id(),
    )
    .map_err(|error| error.to_string())?;
    Ok(matches!(
        managed_create_ledger::reconcile_identity(catalog.discovery_root(), &identity)?,
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_)
            | ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(_)
    ))
}

/// A launch-policy change may race a response-loss retry after the target is
/// already Ready. Only after the real launch attempt reports an identity-local
/// digest conflict may the broker recover that exact target. Conversation and
/// provider evidence prevent an identity collision from becoming adoption.
fn completed_replacement_root_receipt(
    target_request: &ManagedCreateRequest,
) -> Option<hmux_runtime_contract::ManagedCreateReceipt> {
    let catalog = LocalSessionCatalog::from_environment().ok()?;
    let target_identity = ManagedCreateReconcileRequest::new(
        target_request.idempotency_key(),
        target_request.session_id(),
        target_request.workspace_id(),
    )
    .ok()?;
    let evidence = managed_create_ledger::completed_generation_evidence(
        catalog.discovery_root(),
        &target_identity,
    )
    .ok()??;
    let receipt = evidence.receipt();
    if receipt.provider_id() != target_request.provider_id()
        || receipt.discovery_root() != catalog.discovery_root()
        || receipt.generation_fence().is_none()
        || evidence.conversation_identity() != target_request.conversation_identity()
    {
        return None;
    }
    Some(receipt.clone())
}

fn replacement_source_stop_request(
    source_request: &ManagedCreateRequest,
) -> Result<Option<ManagedStopRequest>, String> {
    #[cfg(unix)]
    let _phase = broker_timing::phase(Phase::SourceLookup);
    let catalog = LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?;
    let source_identity = ManagedCreateReconcileRequest::new(
        source_request.idempotency_key(),
        source_request.session_id(),
        source_request.workspace_id(),
    )
    .map_err(|error| error.to_string())?;
    match managed_create_reconcile::reconcile(catalog.discovery_root(), &source_identity) {
        ManagedCreateReconcileBrokerResponse::Completed(receipt) => completed_source_stop_request(
            catalog.discovery_root(),
            &source_identity,
            receipt.as_ref(),
        )
        .map(Some),
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
        | ManagedCreateReconcileBrokerResponse::Retired => Ok(None),
        ManagedCreateReconcileBrokerResponse::Pending => {
            Err("managed replace-current source is still pending".into())
        }
        ManagedCreateReconcileBrokerResponse::NotFound => {
            Err("managed replace-current source is absent".into())
        }
        ManagedCreateReconcileBrokerResponse::AuthorityUnavailable(authority) => {
            Err(authority.message)
        }
    }
}
