use super::*;

/// Resume a journal-owned stop in an already resolved discovery root. Missing
/// authority stays missing: only explicit stop admission may create an intent.
pub(crate) fn reconcile_at(
    discovery_root: &Path,
    request: &ManagedStopReconcileRequest,
) -> std::result::Result<ManagedStopReceipt, ManagedStopProviderError> {
    let reconciliation = managed_stop_intent::reconcile(discovery_root, request)
        .map_err(managed_stop_intent_error)?;
    match reconciliation {
        managed_stop_intent::ManagedStopIntent::Completed(receipt) => {
            finalize_completed_managed_stop(discovery_root, &receipt)?;
            Ok(receipt)
        }
        managed_stop_intent::ManagedStopIntent::Checkpointed { receipt, intent } => {
            finalize_checkpointed_managed_stop(discovery_root, receipt, intent)
        }
        managed_stop_intent::ManagedStopIntent::Refused => Err(managed_stop_refused(
            "managed stop was previously refused before provider termination",
        )),
        managed_stop_intent::ManagedStopIntent::Resume { request, intent } => {
            continue_reserved_managed_stop(discovery_root, &request, intent, false)
        }
        managed_stop_intent::ManagedStopIntent::Pending(_) => Err(managed_stop_outcome_unknown(
            "managed stop reconcile unexpectedly created a fresh intent",
        )),
    }
}
