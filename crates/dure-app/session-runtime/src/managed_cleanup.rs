use std::path::PathBuf;

use dure_app_sqlite::SqliteDomainStore;
use hmux_client::recovery_journal::managed_create_ledger::{
    ManagedCreateAdmissionError, ManagedCreateReconcileLedgerState, ManagedCreateSuccessorChain,
    ManagedCreateSuccessorChainResolution, close_abandoned_create, closed_retired_chain,
    closed_retired_chain_receipt, reconcile_identity, resolve_successor_chain,
};
use hmux_client::{ManagedCreateReconcileRequest, ManagedSessionCreateReconciler};

use crate::{
    SessionCheckoutError,
    cleanup::{finish_checkout_cleanup, finish_retired_checkout},
    managed_identity,
};

/// Resume only an already completed logical stop. No executable, manifest GC,
/// or new process-stop admission is needed to finish its retained resources.
pub async fn reconcile_managed_close(
    store: SqliteDomainStore,
    catalog: hmux_client::LocalSessionCatalog,
    request: ManagedCreateReconcileRequest,
) -> Result<Option<hmux_client::ManagedCreateChainStopReceiptV2>, SessionCheckoutError> {
    let namespace = crate::runtime_namespace(catalog.discovery_root())?;
    let discovery = PathBuf::from(&namespace);
    let receipt =
        tokio::task::spawn_blocking(move || closed_retired_chain_receipt(&discovery, &request))
            .await??;
    if let Some(receipt) = &receipt {
        crate::cleanup::finish_managed_close(&store, &namespace, receipt).await?;
    }
    Ok(receipt)
}

enum Cleanup {
    None,
    OwnClaim,
    Retired(ManagedCreateSuccessorChain),
}

pub(super) async fn reconcile_creation(
    store: SqliteDomainStore,
    namespace: String,
    reconcile: ManagedCreateReconcileRequest,
    reconciler: impl FnOnce() -> Result<ManagedSessionCreateReconciler, SessionCheckoutError>
    + Send
    + 'static,
) -> Result<(), SessionCheckoutError> {
    let identity = managed_identity(
        &namespace,
        reconcile.idempotency_key(),
        reconcile.session_id(),
        reconcile.workspace_id(),
    );
    let root = PathBuf::from(&namespace);
    let cleanup = tokio::task::spawn_blocking(move || {
        // The ledger, not which caller failed or survived, owns the outcome.
        // A root's checkout claim may cover a successor. Follow only existing
        // lineage to finish an already-approved stop, never admit another stop.
        let pending = match reconcile_identity(&root, &reconcile)
            .map_err(ManagedCreateAdmissionError::Ledger)?
        {
            ManagedCreateReconcileLedgerState::Retired
            | ManagedCreateReconcileLedgerState::Retiring(_) => {
                match resolve_successor_chain(&root, &reconcile)
                    .map_err(ManagedCreateAdmissionError::Ledger)?
                {
                    ManagedCreateSuccessorChainResolution::Retiring { chain, .. } => {
                        Some(chain.effective().clone())
                    }
                    _ => None,
                }
            }
            ManagedCreateReconcileLedgerState::SpawnReserved { .. }
            | ManagedCreateReconcileLedgerState::LaunchReleased { .. } => Some(reconcile.clone()),
            ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion => None,
            ManagedCreateReconcileLedgerState::NotFound
            | ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_)
            | ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(_)
            | ManagedCreateReconcileLedgerState::Pending
            | ManagedCreateReconcileLedgerState::Completed(_) => return Ok(Cleanup::None),
        };
        if let Some(pending) = pending {
            reconciler()?.reconcile(pending)?;
        }
        // Final retirement releases resources only when the runtime has also
        // closed successor admission. A generation-only stop stays resumable.
        if let Some(chain) = closed_retired_chain(&root, &reconcile)? {
            return Ok(Cleanup::Retired(chain));
        }
        // Reconciliation owns process-absence proof. Only exact abandoned-slot
        // closure grants compensation, never an already-admitted successor.
        Ok::<_, SessionCheckoutError>(if close_abandoned_create(&root, &reconcile)? {
            Cleanup::OwnClaim
        } else {
            Cleanup::None
        })
    })
    .await??;
    match cleanup {
        Cleanup::None => {}
        Cleanup::OwnClaim => {
            // A failed create owns only its original claim. Transferred
            // resources remain retained for recovery or explicit logical close.
            if let Some(record) = store
                .begin_session_checkout_claim_close(&identity, &identity.owner_id())
                .await?
            {
                finish_checkout_cleanup(&store, record).await?;
            }
        }
        Cleanup::Retired(chain) => {
            for retired in chain.identities() {
                finish_retired_checkout(
                    &store,
                    managed_identity(
                        &namespace,
                        retired.idempotency_key(),
                        retired.session_id(),
                        retired.workspace_id(),
                    ),
                )
                .await?;
            }
        }
    }
    Ok(())
}
