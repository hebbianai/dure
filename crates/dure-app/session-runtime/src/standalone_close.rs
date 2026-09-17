use std::time::{Duration, Instant};

use dure_app::{SessionCheckoutAdmissionV1, SessionCheckoutOwnerV1, SessionCheckoutRecordV1};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::recovery_journal::standalone_upgrade::{self, StandaloneUpgradeProgress};
use hmux_client::{
    CompletedStandaloneTargetLifecycle, ExitedSessionRetirementGeneration, LocalSession,
    LocalSessionCatalog, ProcessDescriptor, SessionClass, SessionLifecycle, SessionSelector,
};
use serde::{Deserialize, Serialize};

use crate::SessionCheckoutError;
use crate::cleanup::finish_checkout_cleanup;
use crate::namespace::runtime_namespace;
use crate::standalone::standalone_identity;
use crate::standalone_handoff::{
    StandaloneHandoff, handoff_if_replaced, visit_standalone_successors,
};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StandaloneCloseOutcome {
    Terminated,
    AlreadyExited,
}

/// The runtime command, not a projection of process liveness. Persisted before
/// any stop/retirement can remove the descriptor needed for forward cleanup.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StandaloneCloseRequest {
    generation: ExitedSessionRetirementGeneration,
    provider_process: ProcessDescriptor,
}

pub(crate) fn close_target_payload(
    generation: &ExitedSessionRetirementGeneration,
    provider_process: &ProcessDescriptor,
) -> Result<serde_json::Value, SessionCheckoutError> {
    Ok(serde_json::to_value(StandaloneCloseRequest {
        generation: generation.clone(),
        provider_process: provider_process.clone(),
    })?)
}

pub(crate) async fn remember_standalone_close_target(
    store: &SqliteDomainStore,
    session: &LocalSession,
) -> Result<(), SessionCheckoutError> {
    let descriptor = session.descriptor();
    let namespace = runtime_namespace(
        session
            .discovery_root()
            .ok_or(SessionCheckoutError::MissingCreateIdentity)?,
    )?;
    let identity = standalone_identity(
        &namespace,
        session
            .create_idempotency_key()
            .ok_or(SessionCheckoutError::MissingCreateIdentity)?,
        &descriptor.session_id,
        &descriptor.workspace_id,
    );
    let payload = close_target_payload(
        &ExitedSessionRetirementGeneration::from_descriptor(descriptor)?,
        &descriptor.provider_process,
    )?;
    store
        .remember_session_checkout_close_target(&identity, &payload)
        .await?;
    Ok(())
}

/// Close a local standalone lifetime without resolving a managed executable.
/// An optional observed epoch fences an exact UI action. A missing descriptor
/// can only use a previously retained exact target, never invent stop authority.
pub async fn close_standalone_session(
    store: SqliteDomainStore,
    catalog: LocalSessionCatalog,
    workspace_id: String,
    session_id: String,
    terminal_epoch: Option<String>,
    timeout: Duration,
) -> Result<StandaloneCloseOutcome, SessionCheckoutError> {
    tokio::spawn(async move {
        let deadline = Instant::now() + timeout;
        let selector = SessionSelector::new(&session_id, Some(workspace_id.clone()));
        let session = match catalog.open(&selector) {
            Ok(session) => session,
            Err(error) if error.is_session_absent() => {
                for root in catalog.discovery_paths() {
                    let namespace = runtime_namespace(root)?;
                    for record in store
                        .session_checkout_close_targets(&namespace, &workspace_id, &session_id)
                        .await?
                    {
                        let request = request_for_record(&record)?;
                        if terminal_epoch
                            .as_ref()
                            .is_some_and(|epoch| *epoch != request.generation.fence.terminal_epoch)
                        {
                            continue;
                        }
                        match handoff_if_replaced(
                            &store,
                            &catalog,
                            &record,
                            &request.generation,
                            &request.provider_process,
                            retire_before(deadline),
                        )
                        .await?
                        {
                            StandaloneHandoff::PendingTransfer
                                if record.admission == SessionCheckoutAdmissionV1::Open =>
                            {
                                return Err(SessionCheckoutError::ClosePending);
                            }
                            StandaloneHandoff::Transferred => continue,
                            StandaloneHandoff::PendingTransfer
                            | StandaloneHandoff::Replacing
                            | StandaloneHandoff::Unchanged => {}
                        }
                        if let Some(current) = store
                            .begin_session_checkout_claim_close(
                                &record.binding.identity,
                                &record.binding.claim_id,
                            )
                            .await?
                        {
                            retire_and_cleanup(&store, &catalog, request, current, deadline)
                                .await?;
                        }
                    }
                }
                return Ok(StandaloneCloseOutcome::AlreadyExited);
            }
            Err(error) => return Err(error.into()),
        };
        let descriptor = session.descriptor();
        if descriptor.session_class != SessionClass::Standalone
            || terminal_epoch
                .as_ref()
                .is_some_and(|epoch| *epoch != descriptor.terminal_epoch)
        {
            return Err(SessionCheckoutError::CloseTargetChanged);
        }
        let outcome = if descriptor.lifecycle == SessionLifecycle::Exited {
            StandaloneCloseOutcome::AlreadyExited
        } else {
            StandaloneCloseOutcome::Terminated
        };
        let request = StandaloneCloseRequest {
            generation: ExitedSessionRetirementGeneration::from_descriptor(descriptor)?,
            provider_process: descriptor.provider_process.clone(),
        };
        let record = if let Some(key) = session.create_idempotency_key() {
            let namespace =
                runtime_namespace(session.discovery_root().unwrap_or(catalog.discovery_root()))?;
            let identity = standalone_identity(&namespace, key, &session_id, &workspace_id);
            if let Some(record) = store.session_checkout(&identity).await? {
                match handoff_if_replaced(
                    &store,
                    &catalog,
                    &record,
                    &request.generation,
                    &request.provider_process,
                    retire_before(deadline),
                )
                .await?
                {
                    StandaloneHandoff::PendingTransfer
                        if record.admission == SessionCheckoutAdmissionV1::Open =>
                    {
                        // The source already has a completed successor. Its old
                        // pane cannot close that successor's pending transition.
                        return Err(SessionCheckoutError::ClosePending);
                    }
                    StandaloneHandoff::Transferred => {
                        return Ok(StandaloneCloseOutcome::AlreadyExited);
                    }
                    StandaloneHandoff::PendingTransfer
                    | StandaloneHandoff::Replacing
                    | StandaloneHandoff::Unchanged => {}
                }
            }
            store
                .begin_session_checkout_close_with(&identity, &serde_json::to_value(&request)?)
                .await?
        } else {
            None
        };
        if let Some(record) = record {
            retire_and_cleanup(&store, &catalog, request, record, deadline).await?;
        } else {
            // Legacy or already transferred owners have no product resource to
            // release. Preserve their existing process-only termination path.
            tokio::task::spawn_blocking(move || session.terminate_standalone(&catalog, timeout))
                .await??;
        }
        Ok(outcome)
    })
    .await?
}

fn request_for_record(
    record: &SessionCheckoutRecordV1,
) -> Result<StandaloneCloseRequest, SessionCheckoutError> {
    let request: StandaloneCloseRequest = serde_json::from_value(
        record
            .close_payload
            .clone()
            .ok_or(SessionCheckoutError::CloseTargetChanged)?,
    )?;
    match &record.binding.identity.owner {
        SessionCheckoutOwnerV1::Standalone {
            workspace_id,
            session_id,
            ..
        } if *workspace_id == request.generation.fence.workspace_id
            && *session_id == request.generation.fence.session_id =>
        {
            Ok(request)
        }
        _ => Err(SessionCheckoutError::CloseTargetChanged),
    }
}

pub(crate) async fn resume_standalone_checkout_close(
    store: &SqliteDomainStore,
    catalog: &LocalSessionCatalog,
    record: SessionCheckoutRecordV1,
) -> Result<(), SessionCheckoutError> {
    let request = if record.close_payload.is_none() {
        let SessionCheckoutOwnerV1::Standalone {
            workspace_id,
            session_id,
            recovery_id,
        } = &record.binding.identity.owner
        else {
            return Err(SessionCheckoutError::CloseTargetChanged);
        };
        let Some(session) = catalog.find_creation(workspace_id, session_id, recovery_id)? else {
            // Missing history cannot prove that a launch was absent or ended.
            return Ok(());
        };
        if session.descriptor().session_class != SessionClass::Standalone
            || runtime_namespace(
                session
                    .discovery_root()
                    .ok_or(SessionCheckoutError::MissingCreateIdentity)?,
            )? != record.binding.identity.runtime_namespace
        {
            return Err(SessionCheckoutError::CloseTargetChanged);
        }
        StandaloneCloseRequest {
            generation: ExitedSessionRetirementGeneration::from_descriptor(session.descriptor())?,
            provider_process: session.descriptor().provider_process.clone(),
        }
    } else {
        request_for_record(&record)?
    };
    let observed_catalog = catalog.clone();
    let observed = request.clone();
    let lifecycle = tokio::task::spawn_blocking(move || {
        observed_catalog
            .resolve_completed_standalone_target(&observed.generation, &observed.provider_process)
    })
    .await?;
    if lifecycle == CompletedStandaloneTargetLifecycle::Retired {
        // Read the successor only after exact retirement. A replacement can
        // complete while the preceding observation is retiring its source.
        if !matches!(
            handoff_if_replaced(
                store,
                catalog,
                &record,
                &request.generation,
                &request.provider_process,
                LocalSessionCatalog::resolve_completed_standalone_target,
            )
            .await?,
            StandaloneHandoff::Unchanged
        ) {
            return Ok(());
        }
        // Runtime observation can race a transfer. Acquire close admission for
        // the observed owner and claim, then use only the binding it returns.
        if let Some(current) = store
            .begin_session_checkout_claim_close(&record.binding.identity, &record.binding.claim_id)
            .await?
        {
            // Close admission excludes a concurrent ownership transfer before
            // recovering a missing cleanup input. A crash here retains the
            // claim and the runtime's already archived retirement evidence.
            let current = store
                .begin_session_checkout_close_with(
                    &current.binding.identity,
                    &serde_json::to_value(request)?,
                )
                .await?
                .ok_or(SessionCheckoutError::CloseTargetChanged)?;
            finish_checkout_cleanup(store, current).await?;
        }
    }
    // Removal admission never stops a live target or treats uncertainty as
    // cleanup permission. Its retained Git claim continues to block removal.
    Ok(())
}

async fn retire_and_cleanup(
    store: &SqliteDomainStore,
    catalog: &LocalSessionCatalog,
    request: StandaloneCloseRequest,
    record: SessionCheckoutRecordV1,
    deadline: Instant,
) -> Result<(), SessionCheckoutError> {
    let catalog = catalog.clone();
    let retired = tokio::task::spawn_blocking(move || {
        let retire = retire_before(deadline);
        let mut retirement_catalog = catalog.clone();
        let mut targets = vec![(request.generation.clone(), request.provider_process.clone())];
        let resolved = visit_standalone_successors(
            &catalog,
            request.generation,
            request.provider_process,
            |catalog, generation, provider| {
                let observed = standalone_upgrade::read_successor(catalog, generation, provider)?;
                match observed {
                    Some(StandaloneUpgradeProgress::Pending(pending)) => {
                        Ok(Some(pending.settle_for_close(catalog)?))
                    }
                    current => Ok(current),
                }
            },
            |catalog, _, _, next| {
                retirement_catalog = catalog.clone();
                targets.push((
                    next.target.generation().clone(),
                    next.target.provider_process().clone(),
                ));
                true
            },
        )?;
        Ok::<_, SessionCheckoutError>(
            resolved
                && targets.iter().all(|(generation, provider)| {
                    retire(&retirement_catalog, generation, provider)
                        == CompletedStandaloneTargetLifecycle::Retired
                }),
        )
    })
    .await??;
    if !retired {
        return Err(SessionCheckoutError::ClosePending);
    }
    finish_checkout_cleanup(store, record).await?;
    Ok(())
}

/// Explicit close owns retirement and one deadline across all completed
/// ancestors. Passive checkout reconciliation never receives this resolver.
fn retire_before(
    deadline: Instant,
) -> impl Fn(
    &LocalSessionCatalog,
    &ExitedSessionRetirementGeneration,
    &ProcessDescriptor,
) -> CompletedStandaloneTargetLifecycle {
    move |catalog, generation, provider| {
        catalog.retire_completed_standalone_target(
            generation,
            provider,
            deadline.saturating_duration_since(Instant::now()),
        )
    }
}
