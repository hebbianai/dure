use hmux_client::recovery_journal::managed_create_ledger::{
    self, ManagedCreateReconcileLedgerState,
};
use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, ProcessDescriptor,
    probe_local_process_generation,
};
use hmux_host::local_discovery::{
    DiscoveryError, DiscoveryManifest, DiscoveryRoot, SessionClass, StaleDiscoveryReason,
};
use hmux_runtime_contract::{
    ManagedCreateReceipt, ManagedCreateReconcileBrokerResponse, ManagedCreateReconcileRequest,
    ManagedStopReceipt, ManagedStopReconcileRequest, read_managed_create_reconcile_request,
    write_managed_create_reconcile_response,
};
use std::io;
use std::path::Path;

const AUTHORITY_UNAVAILABLE_CODE: &str = "hmux_managed_create_reconcile_authority_unavailable";
const REQUEST_INVALID_CODE: &str = "hmux_managed_create_reconcile_request_invalid";

#[cfg(debug_assertions)]
fn inject_reconcile_fault(point: &str) {
    if std::env::var("HMUX_TEST_MANAGED_CREATE_FAULT").as_deref() == Ok(point) {
        std::process::exit(86);
    }
}

#[cfg(not(debug_assertions))]
fn inject_reconcile_fault(_point: &str) {}

pub(crate) enum ManagedCreateRetryReconcile {
    NotFound,
    Completed(Box<ManagedCreateReceipt>),
    Reopened,
    Pending,
    Retired,
}

#[derive(Clone, Copy)]
enum AbandonedCreateTransition {
    Terminalize,
    Reopen,
}

enum StartedReconcileResolution {
    NotFound,
    Completed(Box<ManagedCreateReceipt>),
    Reopened,
    Pending,
    AbandonedBeforeCompletion,
    Retired,
}

pub(crate) fn broker() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let response = match read_managed_create_reconcile_request(&mut io::stdin()) {
        Ok(request) => match LocalSessionCatalog::from_environment() {
            Ok(catalog) => reconcile(catalog.discovery_root(), &request),
            Err(error) => ManagedCreateReconcileBrokerResponse::authority_unavailable(
                AUTHORITY_UNAVAILABLE_CODE,
                error.to_string(),
            ),
        },
        Err(error) => ManagedCreateReconcileBrokerResponse::authority_unavailable(
            REQUEST_INVALID_CODE,
            error.to_string(),
        ),
    };
    #[cfg(debug_assertions)]
    if matches!(
        response,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    ) && std::env::var("HMUX_TEST_MANAGED_CREATE_RECONCILE_FAULT").as_deref()
        == Ok("after_ledger_terminal_before_broker_receipt")
    {
        std::process::exit(86);
    }
    write_managed_create_reconcile_response(&mut io::stdout(), &response)?;
    Ok(())
}

pub(crate) fn reconcile(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
) -> ManagedCreateReconcileBrokerResponse {
    match reconcile_inner(discovery_root, request) {
        Ok(response) => response,
        Err(message) => ManagedCreateReconcileBrokerResponse::authority_unavailable(
            AUTHORITY_UNAVAILABLE_CODE,
            message,
        ),
    }
}

fn reconcile_inner(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateReconcileBrokerResponse, String> {
    let state = managed_create_ledger::reconcile_identity(discovery_root, request)?;
    match state {
        ManagedCreateReconcileLedgerState::NotFound => {
            Ok(ManagedCreateReconcileBrokerResponse::NotFound)
        }
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_) => {
            reconcile_unverified(discovery_root, request)
        }
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(mut reservation) => {
            reservation.abandon_before_completion()?;
            Ok(ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion)
        }
        ManagedCreateReconcileLedgerState::SpawnReserved { .. }
        | ManagedCreateReconcileLedgerState::LaunchReleased { .. } => {
            reconcile_started(discovery_root, request)
        }
        ManagedCreateReconcileLedgerState::Completed(receipt) => Ok(
            ManagedCreateReconcileBrokerResponse::Completed(Box::new(receipt)),
        ),
        ManagedCreateReconcileLedgerState::Pending => {
            Ok(ManagedCreateReconcileBrokerResponse::Pending)
        }
        ManagedCreateReconcileLedgerState::Retiring(receipt) => {
            reconcile_stop_receipt(&receipt).map_err(|error| error.to_string())?;
            match managed_create_ledger::reconcile_identity(discovery_root, request)? {
                ManagedCreateReconcileLedgerState::Retiring(_) => Err(
                    "managed create reconcile stop journal did not finalize retirement"
                        .to_string(),
                ),
                state => project_changed_state(state),
            }
        }
        ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion => {
            Ok(ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion)
        }
        ManagedCreateReconcileLedgerState::Retired => {
            Ok(ManagedCreateReconcileBrokerResponse::Retired)
        }
    }
}

#[derive(Debug)]
pub(crate) enum ManagedCreateStopReconcileError {
    Inconsistent(String),
    Unavailable(String),
}

impl ManagedCreateStopReconcileError {
    #[must_use]
    pub(crate) fn inconsistent(&self) -> bool {
        matches!(self, Self::Inconsistent(_))
    }
}

impl std::fmt::Display for ManagedCreateStopReconcileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Inconsistent(message) | Self::Unavailable(message) => {
                formatter.write_str(message)
            }
        }
    }
}

pub(crate) fn reconcile_stop_receipt(
    expected: &ManagedStopReceipt,
) -> Result<(), ManagedCreateStopReconcileError> {
    let request = ManagedStopReconcileRequest::from_stop_receipt(expected)
        .map_err(|error| ManagedCreateStopReconcileError::Inconsistent(error.to_string()))?;
    let actual = super::reconcile_managed_stop(&request)
        .map_err(|error| ManagedCreateStopReconcileError::Unavailable(error.to_string()))?;
    if actual != *expected {
        return Err(ManagedCreateStopReconcileError::Inconsistent(
            "managed stop reconciliation changed the durable receipt".to_string(),
        ));
    }
    Ok(())
}

fn reconcile_unverified(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateReconcileBrokerResponse, String> {
    let discovery = DiscoveryRoot::open(discovery_root)
        .map_err(|error| format!("managed create reconcile discovery is unavailable: {error}"))?;
    let _maintenance = discovery.acquire_maintenance_shared().map_err(|error| {
        format!("managed create reconcile maintenance authority is unavailable: {error}")
    })?;
    let state = managed_create_ledger::reconcile_identity(discovery_root, request)?;
    let mut reservation = match state {
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(reservation) => reservation,
        other => return project_changed_state(other),
    };
    match discovery.find_manifest_by_session(request.workspace_id(), request.session_id()) {
        Err(DiscoveryError::SessionNotFound) => {}
        Ok(_) | Err(DiscoveryError::StaleDiscovery { .. }) => {
            return Ok(ManagedCreateReconcileBrokerResponse::Pending);
        }
        Err(error) => {
            return Err(format!(
                "managed create reconcile discovery is unavailable: {error}"
            ));
        }
    }
    reservation.checkpoint_pre_spawn_absence()?;
    reservation.abandon_before_completion()?;
    Ok(ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion)
}

fn project_changed_state(
    state: ManagedCreateReconcileLedgerState,
) -> Result<ManagedCreateReconcileBrokerResponse, String> {
    match state {
        ManagedCreateReconcileLedgerState::NotFound => {
            Ok(ManagedCreateReconcileBrokerResponse::NotFound)
        }
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_) => {
            Ok(ManagedCreateReconcileBrokerResponse::Pending)
        }
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(mut reservation) => {
            reservation.abandon_before_completion()?;
            Ok(ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion)
        }
        ManagedCreateReconcileLedgerState::SpawnReserved { .. }
        | ManagedCreateReconcileLedgerState::LaunchReleased { .. } => {
            Ok(ManagedCreateReconcileBrokerResponse::Pending)
        }
        ManagedCreateReconcileLedgerState::Completed(receipt) => Ok(
            ManagedCreateReconcileBrokerResponse::Completed(Box::new(receipt)),
        ),
        ManagedCreateReconcileLedgerState::Pending
        | ManagedCreateReconcileLedgerState::Retiring(_) => {
            Ok(ManagedCreateReconcileBrokerResponse::Pending)
        }
        ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion => {
            Ok(ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion)
        }
        ManagedCreateReconcileLedgerState::Retired => {
            Ok(ManagedCreateReconcileBrokerResponse::Retired)
        }
    }
}

/// Reconciles an already-observed started intent after its caller has dropped
/// every stale reservation and discovery-maintenance guard. This function
/// re-reads both authorities and is the only path allowed to reopen the exact
/// same create attempt.
pub(crate) fn reconcile_for_same_create_retry<F>(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
    recover_ready: F,
) -> Result<ManagedCreateRetryReconcile, String>
where
    F: FnMut(&ProcessDescriptor) -> Result<Option<ManagedCreateReceipt>, String>,
{
    match reconcile_started_with(
        discovery_root,
        request,
        AbandonedCreateTransition::Reopen,
        recover_ready,
    )? {
        StartedReconcileResolution::NotFound => Ok(ManagedCreateRetryReconcile::NotFound),
        StartedReconcileResolution::Completed(receipt) => {
            Ok(ManagedCreateRetryReconcile::Completed(receipt))
        }
        StartedReconcileResolution::Reopened => Ok(ManagedCreateRetryReconcile::Reopened),
        StartedReconcileResolution::Pending => Ok(ManagedCreateRetryReconcile::Pending),
        StartedReconcileResolution::AbandonedBeforeCompletion
        | StartedReconcileResolution::Retired => Ok(ManagedCreateRetryReconcile::Retired),
    }
}

fn reconcile_started(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
) -> Result<ManagedCreateReconcileBrokerResponse, String> {
    match reconcile_started_with(
        discovery_root,
        request,
        AbandonedCreateTransition::Terminalize,
        |_| Ok(None),
    )? {
        StartedReconcileResolution::NotFound => {
            Ok(ManagedCreateReconcileBrokerResponse::NotFound)
        }
        StartedReconcileResolution::Completed(receipt) => {
            Ok(ManagedCreateReconcileBrokerResponse::Completed(receipt))
        }
        StartedReconcileResolution::Pending => {
            Ok(ManagedCreateReconcileBrokerResponse::Pending)
        }
        StartedReconcileResolution::AbandonedBeforeCompletion => {
            Ok(ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion)
        }
        StartedReconcileResolution::Retired => {
            Ok(ManagedCreateReconcileBrokerResponse::Retired)
        }
        StartedReconcileResolution::Reopened => Err(
            "managed create reconcile unexpectedly reopened a public identity".to_string(),
        ),
    }
}

fn reconcile_started_with<F>(
    discovery_root: &Path,
    request: &ManagedCreateReconcileRequest,
    abandoned_transition: AbandonedCreateTransition,
    mut recover_ready: F,
) -> Result<StartedReconcileResolution, String>
where
    F: FnMut(&ProcessDescriptor) -> Result<Option<ManagedCreateReceipt>, String>,
{
    let discovery = DiscoveryRoot::open(discovery_root)
        .map_err(|error| format!("managed create reconcile discovery is unavailable: {error}"))?;
    let _maintenance = discovery.acquire_maintenance_shared().map_err(|error| {
        format!("managed create reconcile maintenance authority is unavailable: {error}")
    })?;
    let state = managed_create_ledger::reconcile_identity(discovery_root, request)?;
    let (
        mut reservation,
        host_process,
        starting_generation,
        provider_release_is_unproven,
        launch_released,
    ) = match state {
        ManagedCreateReconcileLedgerState::SpawnReserved {
            reservation,
            host_process,
        } => (reservation, host_process, None, false, false),
        ManagedCreateReconcileLedgerState::LaunchReleased {
            reservation,
            host_process,
            starting_generation,
            provider_release_guard,
        } => (
            reservation,
            host_process,
            starting_generation,
            !provider_release_guard,
            true,
        ),
        ManagedCreateReconcileLedgerState::NotFound => {
            return Ok(StartedReconcileResolution::NotFound);
        }
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_) => {
            return Ok(StartedReconcileResolution::Pending);
        }
        ManagedCreateReconcileLedgerState::PreSpawnAbsenceCheckpointed(mut reservation) => {
            if matches!(
                abandoned_transition,
                AbandonedCreateTransition::Terminalize
            ) {
                reservation.abandon_before_completion()?;
                return Ok(StartedReconcileResolution::AbandonedBeforeCompletion);
            }
            return Ok(StartedReconcileResolution::Pending);
        }
        ManagedCreateReconcileLedgerState::Completed(receipt) => {
            return Ok(StartedReconcileResolution::Completed(Box::new(receipt)));
        }
        ManagedCreateReconcileLedgerState::Pending
        | ManagedCreateReconcileLedgerState::Retiring(_) => {
            return Ok(StartedReconcileResolution::Pending);
        }
        ManagedCreateReconcileLedgerState::AbandonedBeforeCompletion => {
            return Ok(StartedReconcileResolution::AbandonedBeforeCompletion);
        }
        ManagedCreateReconcileLedgerState::Retired => {
            return Ok(StartedReconcileResolution::Retired);
        }
    };
    if launch_released {
        if let Some(receipt) = recover_ready(&host_process)? {
            let completed = super::managed_create_intent::complete_reserved_receipt(
                &mut reservation,
                &receipt,
            )?;
            return Ok(StartedReconcileResolution::Completed(Box::new(completed)));
        }
    }
    if let Some(starting_generation) = starting_generation {
        if super::managed_starting_generation::retire_if_abandoned(
            discovery_root,
            request,
            &starting_generation,
            None,
            super::managed_starting_generation::AbandonedStartingRetirement::ManagedCreate,
        )
        .map_err(|error| error.to_string())?
        {
            inject_reconcile_fault(
                "after_checkpointed_starting_retirement_before_create_ledger_transition",
            );
            return finish_abandoned_create(
                reservation,
                Some(&starting_generation),
                abandoned_transition,
            );
        }
        return Ok(StartedReconcileResolution::Pending);
    }
    if super::managed_starting_generation::retire_provider_unreleased_if_abandoned(
        discovery_root,
        request,
        &host_process,
    )? {
        return finish_abandoned_create(reservation, None, abandoned_transition);
    }
    // A guardless `LaunchReleased` record may come from an older Host that
    // executed provider effects before it disappeared. A matching sibling
    // guard proves the current broker used the pre-exec barrier; SpawnReserved
    // is inherently inert because its launch packet was never released.
    if provider_release_is_unproven {
        return Ok(StartedReconcileResolution::Pending);
    }
    if !exact_generation_is_absent(&discovery, request, &host_process)? {
        return Ok(StartedReconcileResolution::Pending);
    }
    finish_abandoned_create(reservation, None, abandoned_transition)
}

fn finish_abandoned_create(
    mut reservation: managed_create_ledger::ManagedCreateLedgerReservation,
    starting_generation: Option<&managed_create_ledger::ManagedStartingGeneration>,
    transition: AbandonedCreateTransition,
) -> Result<StartedReconcileResolution, String> {
    match transition {
        AbandonedCreateTransition::Terminalize => {
            if let Some(starting_generation) = starting_generation {
                reservation.abandon_starting_before_completion(starting_generation)?;
            } else {
                reservation.abandon_before_completion()?;
            }
            Ok(StartedReconcileResolution::AbandonedBeforeCompletion)
        }
        AbandonedCreateTransition::Reopen => {
            reservation.reset_after_definite_pre_ready_failure()?;
            Ok(StartedReconcileResolution::Reopened)
        }
    }
}

fn exact_generation_is_absent(
    discovery: &DiscoveryRoot,
    request: &ManagedCreateReconcileRequest,
    host_process: &ProcessDescriptor,
) -> Result<bool, String> {
    match discovery.find_manifest_by_session(request.workspace_id(), request.session_id()) {
        Ok(found) => {
            let common = found.manifest.common();
            if common.session_class != SessionClass::Managed
                || common.claim_linkage.kickoff_action_id.as_deref()
                    != Some(request.idempotency_key())
                || common.host_process.process_id != host_process.process_id
                || common.host_process.start_marker != host_process.start_marker
            {
                return Err(
                    "managed create reconcile discovery changed generation identity".to_string(),
                );
            }
            match found.manifest {
                DiscoveryManifest::Starting(_)
                | DiscoveryManifest::Ready(_)
                | DiscoveryManifest::Exited(_) => return Ok(false),
            }
        }
        Err(DiscoveryError::SessionNotFound)
        | Err(DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::MissingManifest,
            ..
        }) => {}
        Err(DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::NotReady,
            ..
        }) => return Ok(false),
        Err(error) => {
            return Err(format!(
                "managed create reconcile discovery is unavailable: {error}"
            ));
        }
    }
    probe_local_process_generation(host_process)
        .map(|status| status == LocalProcessGenerationStatus::Absent)
        .map_err(|error| {
            format!("managed create reconcile process authority is unavailable: {error}")
        })
}
