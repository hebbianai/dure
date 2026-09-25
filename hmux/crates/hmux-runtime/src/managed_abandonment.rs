use super::*;

#[derive(Debug)]
pub(crate) enum AbandonedReadyError {
    SourceChanged(String),
    Unavailable(String),
}

type AbandonedReadyResult<T> = std::result::Result<T, AbandonedReadyError>;
const LIFETIME_HANDOFF_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_ABANDONED_CREATE_RETIREMENTS_PER_ADMISSION: usize = 16;

impl std::fmt::Display for AbandonedReadyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceChanged(message) | Self::Unavailable(message) => {
                formatter.write_str(message)
            }
        }
    }
}

/// Capability-bearing proof that one exact Ready generation has lost both of
/// its recorded processes and every member of the provider POSIX session.
/// Holding the lifetime lock prevents a Host generation from appearing between
/// the final observations and the Exited publication.
pub(crate) struct AbandonedReadyGeneration {
    discovery: SessionDiscovery,
    lifetime_lock: LifetimeLock,
    ready: ReadyManifest,
}

/// Exact result of attempting to acquire mutation authority for one Ready
/// generation. Ownership and an already-published exit are distinct so a
/// bounded handoff wait never mistakes completed convergence for contention.
pub(crate) enum AbandonedReadyAcquisition {
    Acquired(Box<AbandonedReadyGeneration>),
    HostLifetimeOwned,
    AlreadyExited,
}

impl AbandonedReadyGeneration {
    pub(crate) fn publish_exited(self) -> AbandonedReadyResult<()> {
        let now = unix_time_ms();
        self.discovery
            .publish_exited(
                &self.lifetime_lock,
                ExitedManifest {
                    tombstone: Box::new(hmux_host::provider_epoch::ExitTombstone {
                        provider_conversation_identity: None,
                        fence: SessionFence {
                            workspace_id: self.ready.common.lifetime.workspace_id.clone(),
                            session_id: self.ready.common.lifetime.session_id.clone(),
                            runner_principal: self.ready.common.lifetime.runner_principal.clone(),
                            runner_instance: self.ready.common.lifetime.runner_instance.clone(),
                            channel_epoch: self.ready.common.lifetime.channel_epoch,
                            host_instance_id: self.ready.common.host_instance_id.clone(),
                            terminal_epoch: self.ready.terminal_epoch.clone(),
                        },
                        provider_process: self.ready.provider_process.clone(),
                        exit: hmux_host::local_protocol::Exit {
                            final_output_seq: self.ready.ready_output_seq,
                            exit_code: None,
                            platform_status: None,
                            reason: "abandoned_ready_generation".to_string(),
                        },
                        exit_kind: hmux_host::provider_epoch::ProviderExitKind::ProviderError,
                        created_unix_ms: now,
                        failure: None,
                    }),
                    common: self.ready.common,
                    endpoint: self.ready.endpoint,
                    capability_token: self.ready.capability_token,
                    exited_unix_ms: now,
                },
            )
            .map_err(|error| {
                AbandonedReadyError::Unavailable(format!(
                    "abandoned Ready generation could not publish Exited: {error}"
                ))
            })?;
        drop(self.lifetime_lock);
        Ok(())
    }
}

/// Retires completed managed creates whose exact Ready generation no longer
/// has a Host or provider process. Live, changing, and unproven generations
/// remain untouched; a later admission retries interrupted stop finalization.
pub(crate) fn maintain_completed_create_lifecycles(
    discovery_root: &Path,
) -> std::result::Result<usize, String> {
    if !discovery_root
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        return Ok(0);
    }
    let protected = managed_create_ledger::pending_session_paths(discovery_root)?;
    if protected.is_empty() {
        return Ok(0);
    }
    let root = DiscoveryRoot::open(discovery_root).map_err(|error| error.to_string())?;
    let sessions = root.list_sessions().map_err(|error| error.to_string())?;
    let mut retired = 0;

    for session in sessions {
        if retired >= MAX_ABANDONED_CREATE_RETIREMENTS_PER_ADMISSION {
            break;
        }
        let Ok(relative_path) = session.discovery_path.strip_prefix(root.path()) else {
            continue;
        };
        if !protected.contains(relative_path) {
            continue;
        }
        if maintain_completed_create_lifecycle(discovery_root, &session.manifest) {
            retired += 1;
        }
    }
    Ok(retired)
}

/// Retry recovery needs only its exact generation, even below the capacity
/// watermark. Use the same retirement authority as pressure-driven maintenance
/// without taking unrelated create-shard locks or scanning the whole catalog.
pub(crate) fn maintain_completed_create_lifecycle(
    discovery_root: &Path,
    manifest: &DiscoveryManifest,
) -> bool {
    if manifest.common().session_class != SessionClass::Managed {
        return false;
    }
    let Ok(request) = automatic_stop_request(manifest) else {
        return false;
    };
    let acquisition = if let DiscoveryManifest::Ready(ready) = manifest {
        let Some(create) = managed_create_ledger::completed_create_receipt(
            discovery_root,
            &ready.common.lifetime.workspace_id,
            &ready.common.lifetime.session_id,
        )
        .ok()
        .flatten() else {
            return false;
        };
        let Some(fence) = create.generation_fence() else {
            return false;
        };
        if !fence.matches_generation(
            &ready.common.lifetime.runner_principal,
            &ready.common.lifetime.runner_instance,
            &ready.common.lifetime.channel_epoch.to_string(),
            &ready.common.host_instance_id,
            &ready.terminal_epoch,
        ) {
            return false;
        }
        match acquire(discovery_root, &request, ready) {
            Ok(acquisition) => acquisition,
            Err(_) => return false,
        }
    } else {
        AbandonedReadyAcquisition::AlreadyExited
    };
    finish_abandoned_retirement(discovery_root, &request, acquisition)
}

fn finish_abandoned_retirement(
    discovery_root: &Path,
    request: &ManagedStopRequest,
    acquisition: AbandonedReadyAcquisition,
) -> bool {
    match acquisition {
        AbandonedReadyAcquisition::Acquired(abandoned) => {
            if reserve_stop_intent(discovery_root, request).is_err()
                || (*abandoned).publish_exited().is_err()
            {
                return false;
            }
        }
        AbandonedReadyAcquisition::AlreadyExited => {}
        AbandonedReadyAcquisition::HostLifetimeOwned => return false,
    }
    // Exited is not abandonment authority. Resume only the journaled stop,
    // including an exit that raced the Ready observation; never create one.
    let Ok(reconciliation) = ManagedStopReconcileRequest::from_stop_request(request) else {
        return false;
    };
    managed_stop_reconcile::reconcile_at(discovery_root, &reconciliation).is_ok()
}

pub(crate) fn reserve_stop_intent(
    discovery_root: &Path,
    request: &ManagedStopRequest,
) -> std::result::Result<(), String> {
    match managed_stop_intent::acquire(discovery_root, request)
        .map_err(|error| error.to_string())?
    {
        managed_stop_intent::ManagedStopIntent::Refused => {
            return Err("abandoned Ready source stop was durably refused".into());
        }
        managed_stop_intent::ManagedStopIntent::Pending(_)
        | managed_stop_intent::ManagedStopIntent::Checkpointed { .. }
        | managed_stop_intent::ManagedStopIntent::Resume { .. }
        | managed_stop_intent::ManagedStopIntent::Completed(_) => {}
    }
    Ok(())
}

fn automatic_stop_request(
    manifest: &DiscoveryManifest,
) -> std::result::Result<ManagedStopRequest, String> {
    let common = manifest.common();
    let generation = manifest.generation();
    let terminal_epoch = generation
        .terminal_epoch
        .as_deref()
        .ok_or_else(|| "managed session has no terminal generation".to_string())?;
    let channel_epoch = common.lifetime.channel_epoch.to_string();
    let digest = hmux_client::recovery_journal::request_fingerprint(&[
        "abandoned_ready_generation",
        &common.lifetime.workspace_id,
        &common.lifetime.session_id,
        &common.lifetime.runner_principal,
        &common.lifetime.runner_instance,
        &channel_epoch,
        &generation.host_instance_id,
        terminal_epoch,
    ]);
    ManagedStopRequest::new(
        format!("abandoned-ready-{}", &digest[..32]),
        &common.lifetime.session_id,
        &common.lifetime.workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &common.lifetime.runner_principal,
            &common.lifetime.runner_instance,
            common.lifetime.channel_epoch,
            &generation.host_instance_id,
            terminal_epoch,
        )
    })
    .map_err(|error| error.to_string())
}

/// Resolves a stale Ready manifest into a mutation capability only when its
/// exact Host and provider generations are absent. A busy lifetime lock means
/// the generation is still owned and therefore remains retryable, not dead.
pub(crate) fn acquire(
    discovery_root: &Path,
    source: &ManagedStopRequest,
    ready: &ReadyManifest,
) -> AbandonedReadyResult<AbandonedReadyAcquisition> {
    validate_managed_stop_fence(source, &DiscoveryManifest::Ready(ready.clone())).map_err(
        |error| AbandonedReadyError::SourceChanged(format!("managed source changed: {error}")),
    )?;
    let key = DiscoveryKey::new(
        source.workspace_id(),
        source.session_id(),
        &ready.common.lifetime.runner_instance,
        ready.common.lifetime.channel_epoch,
    )
    .map_err(|error| AbandonedReadyError::SourceChanged(error.to_string()))?;
    let root = DiscoveryRoot::open(discovery_root)
        .map_err(|error| AbandonedReadyError::Unavailable(error.to_string()))?;
    let discovery = root
        .open_session(key)
        .map_err(|error| AbandonedReadyError::SourceChanged(error.to_string()))?;
    let lifetime_lock = match discovery.acquire_lifetime_lock() {
        Ok(lock) => lock,
        Err(hmux_host::local_discovery::DiscoveryError::AlreadyLocked { .. }) => {
            return Ok(AbandonedReadyAcquisition::HostLifetimeOwned);
        }
        Err(error) => {
            return Err(AbandonedReadyError::Unavailable(format!(
                "Ready source lifetime cannot be observed: {error}"
            )));
        }
    };
    let current = discovery
        .read_manifest()
        .map_err(|error| AbandonedReadyError::SourceChanged(error.to_string()))?;
    if current != DiscoveryManifest::Ready(ready.clone()) {
        if matches!(&current, DiscoveryManifest::Exited(_))
            && validate_managed_stop_fence(source, &current).is_ok()
        {
            return Ok(AbandonedReadyAcquisition::AlreadyExited);
        }
        return Err(AbandonedReadyError::SourceChanged(
            "Ready source changed while acquiring its exact lifetime".to_string(),
        ));
    }

    let host_process = ProcessDescriptor {
        process_id: ready.common.host_process.process_id,
        start_marker: ready.common.host_process.start_marker.clone(),
    };
    let provider_process = ProcessDescriptor {
        process_id: ready.provider_process.process_id,
        start_marker: ready.provider_process.start_marker.clone(),
    };
    require_absent_process("Host", &host_process)?;
    require_absent_process("provider", &provider_process)?;
    match process_session::observe_process_session_presence(provider_process.process_id) {
        Ok(process_session::ProcessSessionPresence::Absent) => {}
        Ok(process_session::ProcessSessionPresence::Live) => {
            return Err(AbandonedReadyError::SourceChanged(
                "source provider session still has a live member".to_string(),
            ));
        }
        Err(error) => {
            return Err(AbandonedReadyError::Unavailable(format!(
                "source provider session absence is unproven: {error}"
            )));
        }
    }

    Ok(AbandonedReadyAcquisition::Acquired(Box::new(
        AbandonedReadyGeneration {
            discovery,
            lifetime_lock,
            ready: ready.clone(),
        },
    )))
}

/// Waits only for the exact Host lifetime authority to cross its OS release
/// boundary. Every observation re-runs the generation checks in [`acquire`];
/// changed or unavailable evidence still fails immediately.
pub(crate) fn acquire_until(
    discovery_root: &Path,
    source: &ManagedStopRequest,
    ready: &ReadyManifest,
    deadline: Instant,
) -> AbandonedReadyResult<AbandonedReadyAcquisition> {
    loop {
        let acquisition = acquire(discovery_root, source, ready)?;
        if !matches!(acquisition, AbandonedReadyAcquisition::HostLifetimeOwned) {
            return Ok(acquisition);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(acquisition);
        }
        thread::sleep(remaining.min(LIFETIME_HANDOFF_POLL_INTERVAL));
    }
}

fn require_absent_process(label: &str, process: &ProcessDescriptor) -> AbandonedReadyResult<()> {
    match probe_local_process_generation(process) {
        Ok(LocalProcessGenerationStatus::Absent) => Ok(()),
        Ok(LocalProcessGenerationStatus::Live) => Err(AbandonedReadyError::SourceChanged(format!(
            "source {label} generation is still live"
        ))),
        Err(error) => Err(AbandonedReadyError::Unavailable(format!(
            "source {label} absence is unproven: {error}"
        ))),
    }
}

#[cfg(test)]
#[path = "managed_abandonment_tests.rs"]
mod tests;
