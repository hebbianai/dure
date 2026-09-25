use hmux_client::recovery_journal::managed_create_ledger::{
    self, ManagedStartingGeneration, ManagedStartingProviderContainment,
};
use hmux_client::{
    LocalProcessGenerationStatus, ProcessDescriptor, probe_local_process_generation,
};
use hmux_host::local_discovery::{
    DiscoveryError, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ExitedManifest,
    ManifestCommon, ManifestGeneration, SessionClass, SessionDiscovery,
};
use hmux_host::local_protocol::{Exit, ProcessProof, SessionFence};
use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};
use hmux_runtime_contract::ManagedCreateReconcileRequest;
use std::path::Path;

pub(crate) const PROVIDER_RELEASE_BARRIER_CAPABILITY: &str =
    "managed_starting_provider_release_barrier_v1";

#[derive(Clone, Copy)]
pub(crate) enum AbandonedStartingRetirement {
    ManagedCreate,
    #[cfg(unix)]
    RehostReplacement,
}

#[derive(Debug)]
pub(crate) enum AbandonedStartingRetirementError {
    Conflict(String),
    Unavailable(String),
    OutcomeUnknown(String),
}

impl std::fmt::Display for AbandonedStartingRetirementError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Conflict(message) | Self::Unavailable(message) | Self::OutcomeUnknown(message) => {
                message
            }
        };
        formatter.write_str(message)
    }
}

impl AbandonedStartingRetirement {
    const fn reason(self) -> &'static str {
        match self {
            Self::ManagedCreate => "abandoned_managed_create",
            #[cfg(unix)]
            Self::RehostReplacement => "abandoned_rehost_replacement",
        }
    }
}

/// Retire a `Starting` manifest whose provider effect was still fenced by the
/// runtime-owned release barrier. The manifest capability is the durable proof
/// for a pre-checkpoint crash; the exact Host generation and lifetime lock
/// fence the only process that could have published the provider checkpoint or
/// released that barrier.
pub(crate) fn retire_provider_unreleased_if_abandoned(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
    host_process: &ProcessDescriptor,
) -> Result<bool, String> {
    identity
        .validate()
        .map_err(|error| format!("managed Starting identity is invalid: {error}"))?;
    let root = DiscoveryRoot::open(discovery_root)
        .map_err(|error| format!("managed Starting discovery is unavailable: {error}"))?;
    let found = match root
        .find_current_manifest_by_session(identity.workspace_id(), identity.session_id())
    {
        Ok(found) => found,
        Err(DiscoveryError::SessionNotFound)
        | Err(DiscoveryError::StaleDiscovery { .. }) => return Ok(false),
        Err(error) => {
            return Err(format!(
                "managed Starting discovery is unavailable: {error}"
            ));
        }
    };
    let DiscoveryManifest::Starting(starting) = found.manifest else {
        return Ok(false);
    };
    let common = &starting.common;
    if common.session_class != SessionClass::Managed
        || common.lifetime.workspace_id != identity.workspace_id()
        || common.lifetime.session_id != identity.session_id()
        || common.claim_linkage.kickoff_action_id.as_deref() != Some(identity.idempotency_key())
        || common.host_process.process_id != host_process.process_id
        || common.host_process.start_marker != host_process.start_marker
    {
        return Err("managed Starting manifest changed generation identity".to_string());
    }
    if !common
        .capabilities
        .iter()
        .any(|capability| capability == PROVIDER_RELEASE_BARRIER_CAPABILITY)
    {
        return Ok(false);
    }
    let discovery = root
        .open_session(found.key)
        .map_err(|error| format!("managed Starting discovery is unavailable: {error}"))?;
    let lifetime_lock = match discovery.acquire_lifetime_lock() {
        Ok(lock) => lock,
        Err(DiscoveryError::AlreadyLocked { .. }) => return Ok(false),
        Err(error) => {
            return Err(format!(
                "managed Starting lifetime authority is unavailable: {error}"
            ));
        }
    };
    let expected = DiscoveryManifest::Starting(starting);
    if discovery
        .read_manifest()
        .map_err(|error| format!("managed Starting manifest is unavailable: {error}"))?
        != expected
    {
        return Ok(false);
    }
    match probe_local_process_generation(host_process) {
        Ok(LocalProcessGenerationStatus::Absent) => {}
        Ok(LocalProcessGenerationStatus::Live) => return Ok(false),
        Err(error) => {
            return Err(format!(
                "managed Starting Host absence is unproven: {error}"
            ));
        }
    }
    // A Host may have checkpointed and released its provider after the caller
    // first inspected the ledger but before it acquired the lifetime lock.
    // Re-read after exact Host absence; only the no-checkpoint state authorizes
    // cleanup through the release-barrier capability.
    if managed_create_ledger::starting_generation(
        discovery_root,
        identity.workspace_id(),
        identity.session_id(),
    )?
    .is_some()
    {
        return Ok(false);
    }
    discovery
        .cleanup_current(&lifetime_lock, &expected.generation())
        .map_err(|error| format!("retire provider-unreleased Starting failed: {error}"))?;
    Ok(true)
}

/// Retires one exact pre-Ready discovery generation only after every process
/// authority proves it absent. `false` means the generation is live, Ready, or
/// currently locked by its owner; callers must keep recovery pending.
pub(crate) fn retire_if_abandoned(
    discovery_root: &Path,
    identity: &ManagedCreateReconcileRequest,
    generation: &ManagedStartingGeneration,
    expected_provider_id: Option<&str>,
    retirement: AbandonedStartingRetirement,
) -> Result<bool, AbandonedStartingRetirementError> {
    identity
        .validate()
        .map_err(|error| {
            AbandonedStartingRetirementError::Conflict(format!(
                "managed Starting identity is invalid: {error}"
            ))
        })?;
    if generation.idempotency_key() != identity.idempotency_key() {
        return Err(AbandonedStartingRetirementError::Conflict(
            "managed Starting ledger identity changed".to_string(),
        ));
    }
    let fence = generation.generation_fence();
    let key = DiscoveryKey::new(
        identity.workspace_id(),
        identity.session_id(),
        fence.runner_instance(),
        fence.channel_epoch(),
    )
    .map_err(|error| {
        AbandonedStartingRetirementError::Conflict(format!(
            "managed Starting discovery identity is invalid: {error}"
        ))
    })?;
    let root = DiscoveryRoot::open(discovery_root).map_err(|error| {
        AbandonedStartingRetirementError::Unavailable(format!(
            "managed Starting discovery is unavailable: {error}"
        ))
    })?;
    let discovery = match root.open_session(key) {
        Ok(discovery) => discovery,
        Err(DiscoveryError::SessionNotFound) => return Ok(false),
        Err(error) => {
            return Err(AbandonedStartingRetirementError::Unavailable(format!(
                "managed Starting discovery is unavailable: {error}"
            )));
        }
    };
    let lifetime_lock = match discovery.acquire_lifetime_lock() {
        Ok(lock) => lock,
        Err(DiscoveryError::AlreadyLocked { .. }) => return Ok(false),
        Err(error) => {
            return Err(AbandonedStartingRetirementError::Unavailable(format!(
                "managed Starting lifetime authority is unavailable: {error}"
            )));
        }
    };
    let Some(current) = discovery
        .read_manifest_if_present()
        .map_err(|error| {
            AbandonedStartingRetirementError::Unavailable(format!(
                "managed Starting manifest is unavailable: {error}"
            ))
        })?
    else {
        return exact_retirement_is_archived(
            &discovery,
            identity,
            generation,
            expected_provider_id,
            retirement,
        );
    };
    let common = current.common();
    if !common_matches_checkpoint(common, identity, generation, expected_provider_id) {
        return Err(AbandonedStartingRetirementError::Conflict(
            "managed Starting manifest changed generation identity".to_string(),
        ));
    }
    if matches!(current, DiscoveryManifest::Ready(_)) {
        return Ok(false);
    }
    inject_retirement_error("process_observation_unavailable", || {
        AbandonedStartingRetirementError::Unavailable(
            "managed Starting process observation is fault-injected unavailable".to_string(),
        )
    })?;
    if !exact_processes_are_absent(generation)? {
        return Ok(false);
    }
    let exited = match current {
        DiscoveryManifest::Starting(starting) => {
            let now = super::unix_time_ms();
            let exited = ExitedManifest {
                common: starting.common,
                tombstone: Box::new(ExitTombstone {
                    provider_conversation_identity: None,
                    fence: SessionFence {
                        workspace_id: identity.workspace_id().to_string(),
                        session_id: identity.session_id().to_string(),
                        runner_principal: fence.runner_principal().to_string(),
                        runner_instance: fence.runner_instance().to_string(),
                        channel_epoch: fence.channel_epoch(),
                        host_instance_id: fence.host_instance_id().to_string(),
                        terminal_epoch: fence.terminal_epoch().to_string(),
                    },
                    provider_process: ProcessProof {
                        process_id: generation.provider_process().process_id,
                        start_marker: generation.provider_process().start_marker.clone(),
                    },
                    exit: Exit {
                        final_output_seq: 0,
                        exit_code: None,
                        platform_status: None,
                        reason: retirement.reason().to_string(),
                    },
                    exit_kind: ProviderExitKind::ProviderError,
                    created_unix_ms: now,
                    failure: None,
                }),
                endpoint: generation.endpoint().clone(),
                capability_token: generation.capability_token().to_string(),
                exited_unix_ms: now,
            };
            discovery
                .publish_exited(&lifetime_lock, exited.clone())
                .map_err(|error| {
                    AbandonedStartingRetirementError::OutcomeUnknown(format!(
                        "publish abandoned Starting exit failed: {error}"
                    ))
                })?;
            inject_retirement_error("publish_exited_outcome_unknown", || {
                AbandonedStartingRetirementError::OutcomeUnknown(
                    "publish abandoned Starting exit result is fault-injected unknown".to_string(),
                )
            })?;
            exited
        }
        DiscoveryManifest::Exited(exited)
            if abandoned_retirement_matches_checkpoint(&exited, generation, retirement) => exited,
        DiscoveryManifest::Exited(_) => {
            return Err(AbandonedStartingRetirementError::Conflict(
                "managed Starting exited tombstone changed".to_string(),
            ));
        }
        DiscoveryManifest::Ready(_) => unreachable!("Ready returned before absence cleanup"),
    };
    discovery
        .retire_exited_current(
            &lifetime_lock,
            &DiscoveryManifest::Exited(exited).generation(),
        )
        .map_err(|error| {
            AbandonedStartingRetirementError::OutcomeUnknown(format!(
                "retire abandoned Starting discovery failed: {error}"
            ))
        })?;
    inject_retirement_error("retire_exited_outcome_unknown", || {
        AbandonedStartingRetirementError::OutcomeUnknown(
            "retire abandoned Starting discovery result is fault-injected unknown".to_string(),
        )
    })?;
    Ok(true)
}

fn exact_retirement_is_archived(
    discovery: &SessionDiscovery,
    identity: &ManagedCreateReconcileRequest,
    generation: &ManagedStartingGeneration,
    expected_provider_id: Option<&str>,
    retirement: AbandonedStartingRetirement,
) -> Result<bool, AbandonedStartingRetirementError> {
    let fence = generation.generation_fence();
    let expected = ManifestGeneration {
        host_instance_id: fence.host_instance_id().to_string(),
        host_process: ProcessProof {
            process_id: generation.host_process().process_id,
            start_marker: generation.host_process().start_marker.clone(),
        },
        terminal_epoch: Some(fence.terminal_epoch().to_string()),
    };
    let Some(exited) = discovery
        .find_retired_exited_generation(&expected)
        .map_err(|error| {
            AbandonedStartingRetirementError::Unavailable(format!(
                "managed Starting retirement proof is unavailable: {error}"
            ))
        })?
    else {
        return Ok(false);
    };
    if !common_matches_checkpoint(&exited.common, identity, generation, expected_provider_id)
        || !abandoned_retirement_matches_checkpoint(&exited, generation, retirement)
    {
        return Err(AbandonedStartingRetirementError::Conflict(
            "managed Starting retired generation identity changed".to_string(),
        ));
    }
    Ok(true)
}

fn common_matches_checkpoint(
    common: &ManifestCommon,
    identity: &ManagedCreateReconcileRequest,
    generation: &ManagedStartingGeneration,
    expected_provider_id: Option<&str>,
) -> bool {
    let fence = generation.generation_fence();
    common.session_class == SessionClass::Managed
        && common.lifetime.workspace_id == identity.workspace_id()
        && common.lifetime.session_id == identity.session_id()
        && common.lifetime.runner_principal == fence.runner_principal()
        && common.lifetime.runner_instance == fence.runner_instance()
        && common.lifetime.channel_epoch == fence.channel_epoch()
        && common.host_instance_id == fence.host_instance_id()
        && common.host_process.process_id == generation.host_process().process_id
        && common.host_process.start_marker == generation.host_process().start_marker
        && common.claim_linkage.kickoff_action_id.as_deref()
            == Some(generation.idempotency_key())
        && expected_provider_id.is_none_or(|expected| common.provider_id == expected)
        && generation
            .conversation_identity()
            .is_none_or(|conversation| conversation.provider_id() == common.provider_id)
}

fn exited_matches_checkpoint(
    exited: &ExitedManifest,
    generation: &ManagedStartingGeneration,
) -> bool {
    let fence = generation.generation_fence();
    fence.matches_generation(
        &exited.common.lifetime.runner_principal,
        &exited.common.lifetime.runner_instance,
        &exited.common.lifetime.channel_epoch.to_string(),
        &exited.common.host_instance_id,
        &exited.tombstone.fence.terminal_epoch,
    ) && exited.tombstone.provider_process.process_id
        == generation.provider_process().process_id
        && exited.tombstone.provider_process.start_marker
            == generation.provider_process().start_marker
        && exited.endpoint == *generation.endpoint()
        && exited.capability_token == generation.capability_token()
}

fn abandoned_retirement_matches_checkpoint(
    exited: &ExitedManifest,
    generation: &ManagedStartingGeneration,
    retirement: AbandonedStartingRetirement,
) -> bool {
    exited_matches_checkpoint(exited, generation)
        && exited.tombstone.exit_kind == ProviderExitKind::ProviderError
        && exited.tombstone.exit.final_output_seq == 0
        && exited.tombstone.exit.exit_code.is_none()
        && exited.tombstone.exit.platform_status.is_none()
        && exited.tombstone.exit.reason == retirement.reason()
        && exited.tombstone.failure.is_none()
        && exited.tombstone.created_unix_ms == exited.exited_unix_ms
}

fn exact_processes_are_absent(
    generation: &ManagedStartingGeneration,
) -> Result<bool, AbandonedStartingRetirementError> {
    for (label, process) in [
        ("Host", generation.host_process()),
        ("provider", generation.provider_process()),
    ] {
        match probe_local_process_generation(process) {
            Ok(LocalProcessGenerationStatus::Absent) => {}
            Ok(LocalProcessGenerationStatus::Live) => return Ok(false),
            Err(error) => {
                return Err(AbandonedStartingRetirementError::Unavailable(format!(
                    "managed Starting {label} absence is unproven: {error}"
                )));
            }
        }
    }
    #[cfg(unix)]
    {
        if generation.provider_containment()
            == Some(ManagedStartingProviderContainment::WindowsKillOnJobCloseV1)
        {
            return Err(AbandonedStartingRetirementError::Conflict(
                "managed Starting provider containment changed platform authority".to_string(),
            ));
        }
        match super::process_session::observe_process_session_presence(
            generation.provider_process().process_id,
        ) {
            Ok(super::process_session::ProcessSessionPresence::Absent) => Ok(true),
            Ok(super::process_session::ProcessSessionPresence::Live) => Ok(false),
            Err(error) => Err(AbandonedStartingRetirementError::Unavailable(format!(
                "managed Starting provider session absence is unproven: {error}"
            ))),
        }
    }
    #[cfg(windows)]
    {
        if generation.provider_containment()
            != Some(ManagedStartingProviderContainment::WindowsKillOnJobCloseV1)
        {
            return Ok(false);
        }
        // The provider was checkpointed only after CreateProcessW returned a
        // suspended primary process assigned to a KILL_ON_JOB_CLOSE Job. Exact
        // Host absence closes the sole Job handle, so exact leader absence now
        // proves the contained generation has drained.
        Ok(true)
    }
}

#[cfg(debug_assertions)]
fn inject_retirement_error(
    point: &str,
    error: impl FnOnce() -> AbandonedStartingRetirementError,
) -> Result<(), AbandonedStartingRetirementError> {
    if std::env::var("HMUX_TEST_MANAGED_STARTING_RETIREMENT_ERROR").as_deref() == Ok(point) {
        return Err(error());
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn inject_retirement_error(
    _point: &str,
    _error: impl FnOnce() -> AbandonedStartingRetirementError,
) -> Result<(), AbandonedStartingRetirementError> {
    Ok(())
}
