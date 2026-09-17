use dure_app::{SessionCheckoutAdmissionV1, SessionCheckoutRecordV1};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{
    CompletedStandaloneTargetLifecycle, ExitedSessionRetirementGeneration, LocalSessionCatalog,
    ProcessDescriptor,
    recovery_journal::standalone_upgrade::{
        self, StandaloneUpgradeProgress, StandaloneUpgradeSuccessor,
    },
};

use crate::{SessionCheckoutError, namespace::runtime_namespace, standalone::standalone_identity};

pub(crate) enum StandaloneHandoff {
    Unchanged,
    Replacing,
    PendingTransfer,
    Transferred,
}

/// The existing Git claim remains active while the neutral runtime journal
/// owns a replacement. A completed edge transfers that same claim and its
/// exact close target in one SQL transaction; it never releases/reacquires it.
pub(crate) async fn handoff_if_replaced(
    store: &SqliteDomainStore,
    catalog: &LocalSessionCatalog,
    record: &SessionCheckoutRecordV1,
    generation: &ExitedSessionRetirementGeneration,
    provider: &ProcessDescriptor,
    resolve_ancestor: impl Fn(
        &LocalSessionCatalog,
        &ExitedSessionRetirementGeneration,
        &ProcessDescriptor,
    ) -> CompletedStandaloneTargetLifecycle
    + Send
    + 'static,
) -> Result<StandaloneHandoff, SessionCheckoutError> {
    let catalog = catalog.clone();
    let source = generation.clone();
    let provider = provider.clone();
    let closing = record.admission != SessionCheckoutAdmissionV1::Open;
    let (complete, source_replaced, successor) = tokio::task::spawn_blocking(move || {
        let mut latest = None;
        let mut source_replaced = false;
        let complete = visit_standalone_successors(
            &catalog,
            source,
            provider,
            standalone_upgrade::read_successor,
            |catalog, source, provider, next| {
                source_replaced = true;
                if closing {
                    // Passive reconciliation cannot stop an active successor. A
                    // durable user close is resumed by the close service itself.
                    catalog.resolve_completed_standalone_target(
                        next.target.generation(),
                        next.target.provider_process(),
                    ) == CompletedStandaloneTargetLifecycle::Retired
                } else if resolve_ancestor(catalog, source, provider)
                    == CompletedStandaloneTargetLifecycle::Retired
                {
                    // Every skipped ancestor is retired before the same immutable
                    // claim and close payload advance directly to the latest tip.
                    latest = Some(next.clone());
                    true
                } else {
                    false
                }
            },
        )?;
        Ok::<_, SessionCheckoutError>((complete, source_replaced, latest))
    })
    .await??;
    if !complete {
        return Ok(if source_replaced {
            StandaloneHandoff::PendingTransfer
        } else {
            StandaloneHandoff::Replacing
        });
    }
    let Some(successor) = successor else {
        return Ok(StandaloneHandoff::Unchanged);
    };
    let target = standalone_identity(
        &runtime_namespace(successor.target.receipt().discovery_root())?,
        &successor.creation_key,
        successor.target.receipt().session_id(),
        successor.target.receipt().workspace_id(),
    );
    let close_payload = crate::standalone_close::close_target_payload(
        successor.target.generation(),
        successor.target.provider_process(),
    )?;
    store
        .transfer_session_checkout_with_target(
            &record.binding,
            &target,
            Some(&close_payload),
            || async { Ok::<_, SessionCheckoutError>(()) },
        )
        .await?;
    Ok(StandaloneHandoff::Transferred)
}

/// Visit each exact completed edge once. Observation, transfer and an admitted
/// close share traversal without sharing mutation authority. Pending intent or
/// an unresolved visit retains the caller's original durable checkout owner.
pub(crate) fn visit_standalone_successors(
    catalog: &LocalSessionCatalog,
    mut generation: ExitedSessionRetirementGeneration,
    mut provider: ProcessDescriptor,
    mut read_next: impl FnMut(
        &LocalSessionCatalog,
        &ExitedSessionRetirementGeneration,
        &ProcessDescriptor,
    ) -> Result<Option<StandaloneUpgradeProgress>, String>,
    mut visit: impl FnMut(
        &LocalSessionCatalog,
        &ExitedSessionRetirementGeneration,
        &ProcessDescriptor,
        &StandaloneUpgradeSuccessor,
    ) -> bool,
) -> Result<bool, SessionCheckoutError> {
    let mut catalog = catalog.clone();
    let mut visited = std::collections::BTreeSet::new();
    loop {
        let fence = &generation.fence;
        if !visited.insert((
            fence.workspace_id.clone(),
            fence.session_id.clone(),
            fence.terminal_epoch.clone(),
        )) {
            return Err(SessionCheckoutError::Journal(
                "hmux_recovery_journal_invalid: upgrade lineage contains a cycle".into(),
            ));
        }
        match read_next(&catalog, &generation, &provider).map_err(SessionCheckoutError::Journal)? {
            None | Some(StandaloneUpgradeProgress::Cancelled) => return Ok(true),
            Some(StandaloneUpgradeProgress::Pending(_)) => return Ok(false),
            Some(StandaloneUpgradeProgress::Completed(next)) => {
                catalog = catalog.including_completed_standalone_target(&next.target);
                if !visit(&catalog, &generation, &provider, &next) {
                    return Ok(false);
                }
                generation = next.target.generation().clone();
                provider = next.target.provider_process().clone();
            }
        }
    }
}
