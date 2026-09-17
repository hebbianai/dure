use super::{
    HmuxManager, StandaloneUpgradeReceipt, StandaloneUpgradeRequest, project_known_healthy_session,
    recovery, runtime,
};
use dure_session_runtime::StandaloneReplacementSource;
use hmux_client::recovery_journal::RecoverySourceLock;
use hmux_client::recovery_journal::standalone_upgrade::{
    self, CURRENT_BUILD_ACTION, PreparedStandaloneUpgrade, StandaloneUpgradeOperation,
    StandaloneUpgradeReplacement,
};
use hmux_client::{
    CompletedStandaloneTarget, CreatedStandaloneSession, LocalSessionCatalog, SessionClass,
    SessionDescriptor, SessionLifecycle, SessionProbeStatus, SessionSelector,
    StandaloneCreateRequest, probe_local_session_exact,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

mod prepare;

#[cfg(all(test, unix))]
mod tests;

const ACTION: &str = CURRENT_BUILD_ACTION;

type PreparedUpgrade = PreparedStandaloneUpgrade<CheckoutContext>;
type PreparedReplacement = StandaloneUpgradeReplacement<CheckoutContext>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckoutContext {
    checkout: Option<dure_app::SessionCheckoutBindingV1>,
}

enum Preparation {
    Prepared(Box<PreparedUpgrade>, RecoverySourceLock),
    Refused(Box<StandaloneUpgradeReceipt>),
}

pub(super) fn execute<R: tauri::Runtime>(
    manager: &HmuxManager,
    app: &AppHandle<R>,
    catalog: &LocalSessionCatalog,
    request: StandaloneUpgradeRequest,
) -> Result<StandaloneUpgradeReceipt, String> {
    let observation = standalone_upgrade::read_operation(catalog, &request.upgrade_id, ACTION)?;
    let pending_root = match observation {
        Some(StandaloneUpgradeOperation::Rehosted(completed)) => {
            let source = &completed.source.generation().fence;
            if source.session_id != request.session_id || source.workspace_id != request.workspace_id {
                return Err("hmux_recovery_idempotency_conflict: upgrade source differs".into());
            }
            let created = CreatedStandaloneSession::from_completed_target(&completed.successor.target)
                .map_err(message)?;
            let descriptor = created.session().descriptor().clone();
            verify(
                &LocalSessionCatalog::new(completed.successor.target.receipt().discovery_root()),
                &descriptor,
                completed.successor.target.host_build_version(),
            )?;
            return Ok(receipt(
                &request,
                Some(completed.source_build_id),
                descriptor,
                "rehosted",
                true,
            ));
        }
        Some(StandaloneUpgradeOperation::Pending(pending)) => {
            Some(pending.operation_root().to_path_buf())
        }
        Some(StandaloneUpgradeOperation::Cancelled) => {
            return Err(format!(
                "{}: upgrade was cancelled",
                standalone_upgrade::CANCELLED_CODE,
            ));
        }
        None => None,
    };
    // Confirmation is authorization for first preparation, not a second
    // identity. Retries consume the accepted private payload without hints.
    let mut fingerprint_request = request.clone();
    fingerprint_request.confirmed = true;
    let serialized = serde_json::to_string(&fingerprint_request).map_err(message)?;
    let identity = recovery::PreparedRecoveryIdentity {
        recovery_id: request.upgrade_id.clone(),
        source_session_id: request.session_id.clone(),
        source_workspace_id: request.workspace_id.clone(),
        action: ACTION,
        legacy_request_fingerprint: Some(recovery::request_fingerprint(&[&serialized])),
    };
    let state = match recovery::reserve_prepared(
        pending_root.as_deref().unwrap_or(catalog.discovery_root()),
        identity.clone(),
        None,
    ) {
        Ok(state) => state,
        Err(error) if pending_root.is_none() && error.starts_with("hmux_recovery_prepare_required:") => {
            let (payload, _source_lock) = match prepare::prepare(app, catalog, &request, None)? {
                Preparation::Prepared(payload, source_lock) => (payload, source_lock),
                Preparation::Refused(receipt) => return Ok(*receipt),
            };
            recovery::reserve_prepared(
                catalog.discovery_root(),
                identity,
                Some(serde_json::to_string(&payload).map_err(message)?),
            )?
        }
        Err(error) => return Err(error),
    };
    let mut reservation = match state {
        recovery::RecoveryReservationState::Completed(completion) => {
            return replay(catalog, &request, completion);
        }
        recovery::RecoveryReservationState::Pending(reservation) => reservation,
    };
    let replayed = reservation.was_existing();
    let payload = match reservation.operation_checkpoint() {
        Some(checkpoint) => PreparedUpgrade::read(checkpoint)?,
        None => {
            // A legacy pending record may be upgraded only while its actual
            // source and launch inputs remain available. A name is not proof
            // of the process generation that a lost old operation stopped.
            let operation_root = pending_root.as_deref().unwrap_or(catalog.discovery_root());
            let (payload, _source_lock) =
                match prepare::prepare(app, catalog, &request, Some(operation_root))? {
                    Preparation::Prepared(payload, source_lock) => (*payload, source_lock),
                    Preparation::Refused(receipt) => return Ok(*receipt),
                };
            reservation.prepare_operation_payload(recovery::RecoveryOperationPayload::new(
                serde_json::to_string(&payload).map_err(message)?,
            )?)?;
            payload
        }
    };
    let (descriptor, outcome) = if let Some(replacement) = &payload.replacement {
        let target_catalog = LocalSessionCatalog::new(
            replacement.discovery_root(pending_root.as_deref().unwrap_or(catalog.discovery_root())),
        );
        let saved = reservation
            .operation_checkpoint()
            .and_then(|checkpoint| checkpoint.replacement_receipt.as_deref());
        let created = match saved {
            Some(saved) => open_saved(&target_catalog, replacement, saved)?,
            None => {
                let build = runtime::resolve_installed_build(&payload.target_build_id)?;
                let created = crate::session_checkout::create_standalone_replacement(
                    build.runtime,
                    target_catalog.discovery_root().to_path_buf(),
                    replacement.context.checkout.clone(),
                    replacement.create.clone(),
                    Some(payload.source.clone()),
                )
                .map_err(message)?;
                let target = CompletedStandaloneTarget::from_created(
                    created.receipt().clone(),
                    created.session().descriptor(),
                )
                .map_err(message)?;
                // Persist actual creation before any projection or handshake
                // can lose its result. Never overwrite a legacy saved receipt.
                reservation.checkpoint_replacement_receipt(
                    serde_json::to_string(&target).map_err(message)?,
                )?;
                created
            }
        };
        let descriptor = created.session().descriptor().clone();
        verify(&target_catalog, &descriptor, &payload.target_build_id)?;
        manager
            .pending_created
            .lock()
            .expect("Hmux pending create registry poisoned")
            .insert(descriptor.session_id.clone(), created);
        (descriptor, "rehosted")
    } else {
        let descriptor = payload.source.open().map_err(message)?.descriptor().clone();
        verify(
            &LocalSessionCatalog::new(payload.source.discovery_root()),
            &descriptor,
            &payload.target_build_id,
        )?;
        (descriptor, "already_current")
    };
    reservation.complete(recovery::RecoveryCompletion {
        target_session_id: descriptor.session_id.clone(),
        target_workspace_id: descriptor.workspace_id.clone(),
        target_build_id: payload.target_build_id.clone(),
        action: ACTION.into(),
        outcome: outcome.into(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    })?;
    Ok(receipt(
        &request,
        Some(payload.source_build_id),
        descriptor,
        outcome,
        replayed,
    ))
}

fn open_saved(
    catalog: &LocalSessionCatalog,
    replacement: &PreparedReplacement,
    saved: &str,
) -> Result<CreatedStandaloneSession, String> {
    let target_catalog = replacement.discovery_root.as_ref().map(LocalSessionCatalog::new);
    let catalog = target_catalog.as_ref().unwrap_or(catalog);
    let target =
        CompletedStandaloneTarget::from_recovery_checkpoint(catalog, &replacement.create, saved)
            .map_err(message)?;
    CreatedStandaloneSession::from_completed_target(&target).map_err(message)
}

fn replay(
    catalog: &LocalSessionCatalog,
    request: &StandaloneUpgradeRequest,
    completion: recovery::RecoveryCompletion,
) -> Result<StandaloneUpgradeReceipt, String> {
    let outcome = match (completion.action.as_str(), completion.outcome.as_str()) {
        (ACTION, "already_current") => "already_current",
        (ACTION, "rehosted") => "rehosted",
        _ => return Err("hmux_recovery_journal_invalid: unsupported upgrade completion".into()),
    };
    let (descriptor, source_build, target_catalog) = if let Some(checkpoint) = &completion.operation_checkpoint {
        let payload = PreparedUpgrade::read(checkpoint)?;
        let (descriptor, target_catalog) = match &payload.replacement {
            Some(replacement) => {
                let saved = checkpoint.replacement_receipt.as_deref().ok_or_else(|| {
                    "hmux_recovery_journal_invalid: upgrade target checkpoint missing".to_string()
                })?;
                let created = open_saved(catalog, replacement, saved)?;
                (
                    created.session().descriptor().clone(),
                    LocalSessionCatalog::new(created.receipt().discovery_root()),
                )
            }
            None => (
                payload.source.open().map_err(message)?.descriptor().clone(),
                LocalSessionCatalog::new(payload.source.discovery_root()),
            ),
        };
        (descriptor, Some(payload.source_build_id), target_catalog)
    } else {
        // Old receipts authorize only a read-only projection, never a launch.
        let descriptor = catalog
            .find(&SessionSelector::new(
                &completion.target_session_id,
                Some(completion.target_workspace_id.clone()),
            ))
            .map_err(message)?;
        (descriptor, None, catalog.clone())
    };
    if descriptor.session_id != completion.target_session_id
        || descriptor.workspace_id != completion.target_workspace_id
    {
        return Err("hmux_recovery_journal_invalid: upgrade completion target differs".into());
    }
    verify(&target_catalog, &descriptor, &completion.target_build_id)?;
    Ok(receipt(request, source_build, descriptor, outcome, true))
}

fn verify(
    catalog: &LocalSessionCatalog,
    descriptor: &SessionDescriptor,
    build: &str,
) -> Result<(), String> {
    if descriptor.session_class != SessionClass::Standalone
        || descriptor.host_build_version != build
        || descriptor.lifecycle != SessionLifecycle::Ready
        || probe_local_session_exact(catalog, descriptor) != SessionProbeStatus::Healthy
    {
        return Err(
            "hmux_upgrade_receipt_target_unhealthy: completed target failed its handshake".into(),
        );
    }
    Ok(())
}

fn receipt(
    request: &StandaloneUpgradeRequest,
    source_build_id: Option<String>,
    descriptor: SessionDescriptor,
    outcome: &'static str,
    replayed: bool,
) -> StandaloneUpgradeReceipt {
    StandaloneUpgradeReceipt {
        source_session_id: request.session_id.clone(),
        source_workspace_id: request.workspace_id.clone(),
        source_build_id,
        target_build_id: descriptor.host_build_version.clone(),
        action: ACTION,
        outcome,
        replayed,
        reason: None,
        requires_confirmation: false,
        replacement_session: Some(project_known_healthy_session(descriptor)),
    }
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
