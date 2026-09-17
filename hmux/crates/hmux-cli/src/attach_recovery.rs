use super::{CliError, resurrection};
use hmux_client::recovery_journal::{
    PreparedRecoveryIdentity, RecoveryCompletion, RecoveryReservationState, RecoverySourceLock,
    RecoverySourceLockState, SAVED_RECIPE_RECOVERY_NAMESPACE, prepared_standalone_create,
    record_prepared_replay_terminal_outcome, request_fingerprint, reserve_prepared,
    try_lock_source,
};
use hmux_client::{
    CatalogCensusWorker, LocalProcessGenerationStatus, LocalSession, LocalSessionCatalog,
    PresentationCheckpointPredecessor, SessionClass, SessionDescriptor, SessionLifecycle,
    SessionProbeStatus, SessionSelector, StandaloneCreateReceipt, StandaloneCreateRequest,
    StandaloneRecoveryCreateIdentity, StandaloneSessionCreator, list_local_sessions_isolated,
    probe_local_process_generation, probe_local_session_exact,
};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const SOURCE_LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const SOURCE_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(25);
const RECOVERY_ACTION: &str = "restore_plain_shell_for_attach";
const MISSING_SOURCE_RECOVERY_ACTION: &str = "restore_saved_plain_shell_for_attach";
const ATTACH_RECOVERY_COORDINATION_NAMESPACE: &str = "attach_recovery_by_saved_name_v1";
const REPLACEMENT_CENSUS_BUDGET: Duration = Duration::from_millis(1_500);

pub(crate) fn recover_missing_named_attach(
    catalog: &LocalSessionCatalog,
    session_name: &str,
    runtime: &Path,
) -> Result<Option<LocalSession>, Box<dyn std::error::Error>> {
    let Some(recipe) = resurrection::resolve_if_saved(catalog.discovery_root(), session_name)?
    else {
        return Ok(None);
    };
    if recipe.requires_operator_confirmation() {
        return Err(Box::new(explicit_replay_refusal(session_name)));
    }

    let _recipe_lock = wait_for_source_lock(
        catalog.discovery_root(),
        ATTACH_RECOVERY_COORDINATION_NAMESPACE,
        session_name,
    )?;
    if let Some(replacement) = find_healthy_named_replacement(catalog, session_name, None)? {
        return Ok(Some(replacement));
    }

    let resolved = resurrection::resolve_and_migrate(catalog.discovery_root(), session_name)?;
    let recipe = resolved.recipe();
    if recipe.requires_operator_confirmation() {
        return Err(Box::new(explicit_replay_refusal(session_name)));
    }
    let recipe_payload = serde_json::to_string(recipe)
        .map_err(|_| CliError("saved Hmux recipe could not be fingerprinted".into()))?;
    let recovery_id = format!("attach_restore_missing_v1_{session_name}");
    let identity = PreparedRecoveryIdentity {
        recovery_id: recovery_id.clone(),
        source_session_id: format!("saved_recipe_{session_name}"),
        source_workspace_id: SAVED_RECIPE_RECOVERY_NAMESPACE.into(),
        action: MISSING_SOURCE_RECOVERY_ACTION,
        legacy_request_fingerprint: Some(request_fingerprint(&[session_name, &recipe_payload])),
    };
    let state = reserve_prepared_create(catalog, identity.clone(), recipe, &recovery_id, None)?;
    let mut reservation = match state {
        RecoveryReservationState::Completed(completion) => {
            return replay_missing_source_completion(
                catalog,
                session_name,
                &identity,
                completion,
                runtime,
            )
            .map(Some);
        }
        RecoveryReservationState::Pending(reservation) => reservation,
    };

    let request = prepared_standalone_create::load_or_prepare(&mut reservation, || {
        let request =
            create_request(recipe, &recovery_id, None).map_err(|error| error.to_string())?;
        prepared_standalone_create::PreparedStandaloneCreate::new(request)
    })?;
    let created = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(catalog.discovery_root())
        .create(request)?;
    let replacement = created.session().clone();
    if !valid_replacement(catalog, &replacement, session_name, None) {
        return Err(Box::new(CliError(
            "automatic attach recovery target did not pass its fresh handshake; retry attach"
                .into(),
        )));
    }
    reservation.checkpoint_replacement_receipt(
        serde_json::to_string(created.receipt())
            .map_err(|_| CliError("standalone recovery receipt is not serializable".into()))?,
    )?;
    reservation.complete(missing_source_completion_for(&replacement))?;
    Ok(Some(replacement))
}

pub(crate) fn recover_stale_attach(
    catalog: &LocalSessionCatalog,
    source: &LocalSession,
    runtime: &Path,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    let source_descriptor = source.descriptor();
    if source_descriptor.session_class != SessionClass::Standalone
        || source_descriptor.provider_id != "local-shell"
        || source_descriptor.lifecycle != SessionLifecycle::Ready
    {
        return Err(Box::new(CliError(format!(
            "Hmux session `{}` is not a recoverable standalone shell",
            source_descriptor.session_id
        ))));
    }
    let session_name = source_descriptor.session_name.as_deref().ok_or_else(|| {
        CliError("automatic attach recovery requires a saved session name".into())
    })?;
    let resolved = resurrection::resolve_and_migrate(catalog.discovery_root(), session_name)?;
    let recipe = resolved.recipe();
    if recipe.requires_operator_confirmation() {
        return Err(Box::new(explicit_replay_refusal(session_name)));
    }

    // The stable recipe-name lock spans both the manifest-present and
    // manifest-missing recovery paths. Without it, an attach that observes
    // the source just before retirement can race one that observes it just
    // after retirement and publish two replacements.
    let _recipe_lock = wait_for_source_lock(
        catalog.discovery_root(),
        ATTACH_RECOVERY_COORDINATION_NAMESPACE,
        session_name,
    )?;
    let _source_lock = wait_for_source_lock(
        catalog.discovery_root(),
        &source_descriptor.workspace_id,
        &source_descriptor.session_id,
    )?;
    let source_retirement = if let Some(current) = reopen_source(catalog, source)? {
        match probe(catalog, &current) {
            SessionProbeStatus::Healthy => return Ok(current),
            SessionProbeStatus::IncompatibleProtocol => {
                return Err(Box::new(CliError(format!(
                    "Hmux session `{session_name}` is live but uses an incompatible protocol; \
                     automatic recovery was refused"
                ))));
            }
            SessionProbeStatus::StaleTransport => {}
            SessionProbeStatus::Exited | SessionProbeStatus::GenerationChanged => {
                return Err(Box::new(CliError(format!(
                    "Hmux session `{session_name}` changed generation during recovery; retry attach"
                ))));
            }
        }
        match catalog.reserve_stale_exact(source)? {
            Some(retirement) => Some(retirement),
            None => {
                return Err(Box::new(CliError(format!(
                    "stale Hmux source `{session_name}` disappeared before recovery"
                ))));
            }
        }
    } else {
        return Err(Box::new(CliError(format!(
            "stale Hmux source `{session_name}` disappeared before its durable recovery target \
             was prepared"
        ))));
    };
    // The runtime repeats the same lifetime-lock and generation check while
    // reclaiming the stale named source. Holding this preflight guard across
    // broker creation would block that authoritative cleanup.
    drop(source_retirement);

    let recipe_payload = serde_json::to_string(recipe)
        .map_err(|_| CliError("saved Hmux recipe could not be fingerprinted".into()))?;
    let generation_fingerprint = request_fingerprint(&[
        &source_descriptor.workspace_id,
        &source_descriptor.session_id,
        &source_descriptor.host_instance_id,
        &source_descriptor.terminal_epoch,
    ]);
    let recovery_id = format!("attach_restore_v2_{}", &generation_fingerprint[..32]);
    let identity = PreparedRecoveryIdentity {
        recovery_id: recovery_id.clone(),
        source_session_id: source_descriptor.session_id.clone(),
        source_workspace_id: source_descriptor.workspace_id.clone(),
        action: RECOVERY_ACTION,
        legacy_request_fingerprint: Some(request_fingerprint(&[
            session_name,
            &source_descriptor.host_instance_id,
            &source_descriptor.terminal_epoch,
            &recipe_payload,
        ])),
    };
    let state = reserve_prepared_create(
        catalog,
        identity.clone(),
        recipe,
        &recovery_id,
        Some(source_descriptor),
    )?;
    let mut reservation = match state {
        RecoveryReservationState::Completed(completion) => {
            return replay_completed_recovery(
                catalog,
                source,
                session_name,
                &identity,
                completion,
                runtime,
            );
        }
        RecoveryReservationState::Pending(reservation) => reservation,
    };

    let request = prepared_standalone_create::load_or_prepare(&mut reservation, || {
        let request = create_request(recipe, &recovery_id, Some(source_descriptor))
            .map_err(|error| error.to_string())?;
        prepared_standalone_create::PreparedStandaloneCreate::new(request)
    })?;
    let created = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(catalog.discovery_root())
        .create(request)?;
    let replacement = created.session().clone();
    if !valid_replacement(
        catalog,
        &replacement,
        session_name,
        Some(&source_descriptor.session_id),
    ) {
        return Err(Box::new(CliError(
            "automatic attach recovery target did not pass its fresh handshake; retry attach"
                .into(),
        )));
    }

    cleanup_source(catalog, source, &replacement)?;
    reservation.checkpoint_replacement_receipt(
        serde_json::to_string(created.receipt())
            .map_err(|_| CliError("standalone recovery receipt is not serializable".into()))?,
    )?;
    reservation.complete(completion_for(&replacement))?;
    Ok(replacement)
}

fn wait_for_source_lock(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<RecoverySourceLock, Box<dyn std::error::Error>> {
    let deadline = Instant::now() + SOURCE_LOCK_TIMEOUT;
    loop {
        match try_lock_source(discovery_root, workspace_id, session_id)? {
            RecoverySourceLockState::Acquired(lock) => return Ok(lock),
            RecoverySourceLockState::Busy if Instant::now() < deadline => {
                thread::sleep(SOURCE_LOCK_POLL_INTERVAL);
            }
            RecoverySourceLockState::Busy => {
                return Err(Box::new(CliError(
                    "another recovery still owns this Hmux session; retry attach".into(),
                )));
            }
        }
    }
}

fn reopen_source(
    catalog: &LocalSessionCatalog,
    expected: &LocalSession,
) -> Result<Option<LocalSession>, Box<dyn std::error::Error>> {
    let descriptor = expected.descriptor();
    let selector = SessionSelector::new(
        descriptor.session_id.clone(),
        Some(descriptor.workspace_id.clone()),
    );
    match catalog.open(&selector) {
        Ok(current)
            if current.descriptor().host_instance_id == descriptor.host_instance_id
                && current.descriptor().terminal_epoch == descriptor.terminal_epoch =>
        {
            Ok(Some(current))
        }
        Ok(_) => Err(Box::new(CliError(
            "Hmux source generation changed during automatic attach recovery".into(),
        ))),
        Err(error) if error.is_session_absent() => Ok(None),
        Err(error) => Err(Box::new(error)),
    }
}

fn find_healthy_named_replacement(
    catalog: &LocalSessionCatalog,
    session_name: &str,
    source: Option<&hmux_client::SessionDescriptor>,
) -> Result<Option<LocalSession>, Box<dyn std::error::Error>> {
    let mut healthy = Vec::new();
    let mut incompatible = 0_usize;
    let mut unstable = 0_usize;
    let worker = CatalogCensusWorker::new(std::env::current_exe()?);
    let descriptors = list_local_sessions_isolated(catalog, &worker, REPLACEMENT_CENSUS_BUDGET)?;
    for descriptor in descriptors.into_iter().filter(|candidate| {
        candidate.session_class == SessionClass::Standalone
            && candidate.lifecycle == SessionLifecycle::Ready
            && candidate.provider_id == "local-shell"
            && candidate.session_name.as_deref() == Some(session_name)
            && source.is_none_or(|source| {
                candidate.session_id != source.session_id
                    || candidate.workspace_id != source.workspace_id
            })
    }) {
        let session = catalog.open(&SessionSelector::new(
            descriptor.session_id,
            Some(descriptor.workspace_id),
        ))?;
        match probe(catalog, &session) {
            SessionProbeStatus::Healthy => healthy.push(session),
            SessionProbeStatus::IncompatibleProtocol => incompatible += 1,
            SessionProbeStatus::StaleTransport => {}
            SessionProbeStatus::Exited | SessionProbeStatus::GenerationChanged => unstable += 1,
        }
    }
    if incompatible > 0 || unstable > 0 || healthy.len() > 1 {
        return Err(Box::new(CliError(format!(
            "Hmux name `{session_name}` has conflicting replacement sessions; automatic \
             recovery was refused"
        ))));
    }
    Ok(healthy.pop())
}

fn replay_completed_recovery(
    catalog: &LocalSessionCatalog,
    source: &LocalSession,
    session_name: &str,
    identity: &PreparedRecoveryIdentity,
    completion: RecoveryCompletion,
    runtime: &Path,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    if completion.outcome.starts_with("failed_") {
        return Err(Box::new(saved_replay_failure(session_name, &completion)));
    }
    if completion.action != RECOVERY_ACTION || completion.outcome != "restored" {
        return persist_replay_failure(
            catalog,
            session_name,
            identity,
            &completion,
            "failed_recovery_journal_invalid",
        );
    }
    let replacement =
        match reopen_or_recreate_completed_replacement(catalog, session_name, &completion, runtime)
        {
            Ok(replacement) => replacement,
            Err(CompletedReplayError::Terminal(outcome)) => {
                return persist_replay_failure(
                    catalog,
                    session_name,
                    identity,
                    &completion,
                    outcome,
                );
            }
            Err(CompletedReplayError::Retryable(error)) => return Err(error),
        };
    cleanup_source(catalog, source, &replacement)?;
    Ok(replacement)
}

fn replay_missing_source_completion(
    catalog: &LocalSessionCatalog,
    session_name: &str,
    identity: &PreparedRecoveryIdentity,
    completion: RecoveryCompletion,
    runtime: &Path,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    if completion.outcome.starts_with("failed_") {
        return Err(Box::new(saved_replay_failure(session_name, &completion)));
    }
    if completion.action != MISSING_SOURCE_RECOVERY_ACTION || completion.outcome != "restored" {
        return persist_replay_failure(
            catalog,
            session_name,
            identity,
            &completion,
            "failed_recovery_journal_invalid",
        );
    }
    match reopen_or_recreate_completed_replacement(catalog, session_name, &completion, runtime) {
        Ok(replacement) => Ok(replacement),
        Err(CompletedReplayError::Terminal(outcome)) => {
            persist_replay_failure(catalog, session_name, identity, &completion, outcome)
        }
        Err(CompletedReplayError::Retryable(error)) => Err(error),
    }
}

enum CompletedReplayError {
    Terminal(&'static str),
    Retryable(Box<dyn std::error::Error>),
}

fn persist_replay_failure<T>(
    catalog: &LocalSessionCatalog,
    session_name: &str,
    identity: &PreparedRecoveryIdentity,
    completion: &RecoveryCompletion,
    outcome: &'static str,
) -> Result<T, Box<dyn std::error::Error>> {
    let persisted = record_prepared_replay_terminal_outcome(
        catalog.discovery_root(),
        identity,
        completion,
        outcome,
    )?;
    Err(Box::new(saved_replay_failure(session_name, &persisted)))
}

fn saved_replay_failure(session_name: &str, completion: &RecoveryCompletion) -> CliError {
    CliError(format!(
        "saved replacement for `{session_name}` has terminal replay outcome {}",
        completion.outcome
    ))
}

fn validate_completed_replacement_identity(
    catalog: &LocalSessionCatalog,
    completion: &RecoveryCompletion,
    session_name: &str,
) -> Result<Option<StandaloneCreateRequest>, Box<dyn std::error::Error>> {
    let Some(checkpoint) = completion.operation_checkpoint.as_ref() else {
        return Ok(None);
    };
    let request: StandaloneCreateRequest = serde_json::from_str(&checkpoint.canonical_payload)
        .map_err(|_| CliError("saved standalone recovery request is malformed".into()))?;
    request.validate()?;
    let target = request
        .recovery_identity()
        .ok_or_else(|| CliError("saved standalone recovery target identity is missing".into()))?;
    let receipt: StandaloneCreateReceipt =
        serde_json::from_str(checkpoint.replacement_receipt.as_deref().ok_or_else(|| {
            CliError("saved standalone recovery replacement receipt is missing".into())
        })?)
        .map_err(|_| {
            CliError("saved standalone recovery replacement receipt is malformed".into())
        })?;
    receipt.validate()?;
    if target.target_session_id() != completion.target_session_id
        || receipt.session_id() != completion.target_session_id
        || receipt.workspace_id() != completion.target_workspace_id
        || receipt.session_name() != session_name
        || request.session_name() != Some(session_name)
        || receipt.launch_owner_proof() != target.launch_owner_proof()
        || receipt.discovery_root() != catalog.discovery_root()
    {
        return Err(Box::new(CliError(
            "saved standalone recovery replacement identity changed".into(),
        )));
    }
    Ok(Some(request))
}

fn reopen_or_recreate_completed_replacement(
    catalog: &LocalSessionCatalog,
    session_name: &str,
    completion: &RecoveryCompletion,
    runtime: &Path,
) -> Result<LocalSession, CompletedReplayError> {
    let request = validate_completed_replacement_identity(catalog, completion, session_name)
        .map_err(|_| CompletedReplayError::Terminal("failed_recovery_journal_invalid"))?;
    let selector = SessionSelector::new(
        &completion.target_session_id,
        Some(completion.target_workspace_id.clone()),
    );
    let request = request.ok_or(CompletedReplayError::Terminal(
        "failed_recovery_journal_invalid",
    ))?;
    let target_present = match catalog.open(&selector) {
        Ok(replacement) => {
            if !completed_replacement_structure_matches(&replacement, session_name, completion) {
                return Err(CompletedReplayError::Terminal(
                    "failed_recovery_identity_conflict",
                ));
            }
            let status = probe(catalog, &replacement);
            match status {
                SessionProbeStatus::Healthy => true,
                SessionProbeStatus::StaleTransport => {
                    let descriptor = replacement.descriptor();
                    let host_absent = probe_local_process_generation(&descriptor.host_process)
                        .map_err(|error| CompletedReplayError::Retryable(Box::new(error)))?
                        == LocalProcessGenerationStatus::Absent;
                    let provider_absent =
                        probe_local_process_generation(&descriptor.provider_process)
                            .map_err(|error| CompletedReplayError::Retryable(Box::new(error)))?
                            == LocalProcessGenerationStatus::Absent;
                    if host_absent && provider_absent {
                        false
                    } else {
                        return Err(completed_target_transient(status));
                    }
                }
                _ => return Err(completed_target_transient(status)),
            }
        }
        Err(error) if error.is_session_absent() => false,
        Err(error) => return Err(CompletedReplayError::Retryable(Box::new(error))),
    };
    if !target_present {
        let runtime_build = super::runtime_build_id(runtime)
            .map_err(|error| CompletedReplayError::Retryable(Box::new(error)))?;
        if runtime_build != completion.target_build_id {
            return Err(CompletedReplayError::Retryable(Box::new(CliError(
                format!(
                    "saved standalone recovery build {} is not currently installed",
                    completion.target_build_id
                ),
            ))));
        }
    }
    let recreated = StandaloneSessionCreator::new(runtime)
        .with_discovery_root(catalog.discovery_root())
        .create(request)
        .map_err(|error| {
            if error.is_standalone_recovery_terminal_refusal() {
                CompletedReplayError::Terminal("failed_recovery_identity_conflict")
            } else {
                CompletedReplayError::Retryable(Box::new(error))
            }
        })?;
    let replacement = recreated.session().clone();
    if !completed_replacement_structure_matches(&replacement, session_name, completion) {
        return Err(CompletedReplayError::Terminal(
            "failed_recovery_identity_conflict",
        ));
    }
    let status = probe(catalog, &replacement);
    if status != SessionProbeStatus::Healthy {
        return Err(completed_target_transient(status));
    }
    Ok(replacement)
}

fn completed_replacement_structure_matches(
    replacement: &LocalSession,
    session_name: &str,
    completion: &RecoveryCompletion,
) -> bool {
    let descriptor = replacement.descriptor();
    descriptor.lifecycle == SessionLifecycle::Ready
        && descriptor.session_id == completion.target_session_id
        && descriptor.workspace_id == completion.target_workspace_id
        && descriptor.host_build_version == completion.target_build_id
        && descriptor.session_class == SessionClass::Standalone
        && descriptor.provider_id == "local-shell"
        && descriptor.session_name.as_deref() == Some(session_name)
}

fn completed_target_transient(status: SessionProbeStatus) -> CompletedReplayError {
    CompletedReplayError::Retryable(Box::new(CliError(format!(
        "saved standalone recovery target is temporarily unavailable ({status:?})"
    ))))
}

fn cleanup_source(
    catalog: &LocalSessionCatalog,
    source: &LocalSession,
    replacement: &LocalSession,
) -> Result<(), Box<dyn std::error::Error>> {
    if source.descriptor().session_id == replacement.descriptor().session_id
        || source.descriptor().workspace_id == replacement.descriptor().workspace_id
            && source.descriptor().host_instance_id == replacement.descriptor().host_instance_id
    {
        return Err(Box::new(CliError(
            "automatic attach recovery refused to retire its replacement".into(),
        )));
    }
    match catalog.cleanup_stale_exact(source) {
        Ok(true) => Ok(()),
        Ok(false) if reopen_source(catalog, source)?.is_none() => Ok(()),
        Ok(false) => Err(Box::new(CliError(
            "stale Hmux source remained discoverable after recovery".into(),
        ))),
        Err(error) => Err(Box::new(CliError(format!(
            "replacement was ready but exact stale-source retirement failed ({}: {error})",
            error.code()
        )))),
    }
}

fn completion_for(replacement: &LocalSession) -> RecoveryCompletion {
    let descriptor = replacement.descriptor();
    RecoveryCompletion {
        target_session_id: descriptor.session_id.clone(),
        target_workspace_id: descriptor.workspace_id.clone(),
        target_build_id: descriptor.host_build_version.clone(),
        action: RECOVERY_ACTION.to_string(),
        outcome: "restored".to_string(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    }
}

fn missing_source_completion_for(replacement: &LocalSession) -> RecoveryCompletion {
    let mut completion = completion_for(replacement);
    completion.action = MISSING_SOURCE_RECOVERY_ACTION.to_string();
    completion
}

fn create_request(
    recipe: &hmux_client::StandaloneResurrectionRecipe,
    recovery_id: &str,
    source: Option<&SessionDescriptor>,
) -> Result<StandaloneCreateRequest, Box<dyn std::error::Error>> {
    let mut digest = Sha256::new();
    digest.update(b"hmux_attach_recovery_target_v1");
    digest.update(recovery_id.len().to_le_bytes());
    digest.update(recovery_id.as_bytes());
    let target_session_id = format!(
        "standalone_{}",
        format!("{:x}", digest.finalize())
            .chars()
            .take(12)
            .collect::<String>()
    );
    let mut recovery_identity =
        StandaloneRecoveryCreateIdentity::new(target_session_id, Uuid::new_v4().to_string())?;
    if let Some(source) = source {
        let channel_epoch = source
            .channel_epoch
            .parse::<u64>()
            .map_err(|_| CliError("standalone recovery source channel epoch is invalid".into()))?;
        recovery_identity =
            recovery_identity.with_source_predecessor(PresentationCheckpointPredecessor::new(
                &source.session_id,
                &source.runner_principal,
                &source.runner_instance,
                channel_epoch,
                &source.host_instance_id,
                &source.terminal_epoch,
            )?)?;
    }
    Ok(recipe
        .to_create_request()?
        .with_recovery_identity(recovery_identity)?)
}

fn reserve_prepared_create(
    catalog: &LocalSessionCatalog,
    identity: PreparedRecoveryIdentity,
    recipe: &hmux_client::StandaloneResurrectionRecipe,
    recovery_id: &str,
    source: Option<&SessionDescriptor>,
) -> Result<RecoveryReservationState, Box<dyn std::error::Error>> {
    match reserve_prepared(catalog.discovery_root(), identity.clone(), None) {
        Ok(state) => Ok(state),
        Err(error) if error.starts_with("hmux_recovery_prepare_required:") => {
            let request = create_request(recipe, recovery_id, source)?;
            let canonical_payload = serde_json::to_string(&request)
                .map_err(|_| CliError("standalone recovery request is not serializable".into()))?;
            Ok(reserve_prepared(
                catalog.discovery_root(),
                identity,
                Some(canonical_payload),
            )?)
        }
        Err(error) => Err(error.into()),
    }
}

fn valid_replacement(
    catalog: &LocalSessionCatalog,
    replacement: &LocalSession,
    session_name: &str,
    source_session_id: Option<&str>,
) -> bool {
    let descriptor = replacement.descriptor();
    descriptor.session_class == SessionClass::Standalone
        && descriptor.provider_id == "local-shell"
        && descriptor.session_name.as_deref() == Some(session_name)
        && source_session_id.is_none_or(|source| descriptor.session_id != source)
        && probe(catalog, replacement) == SessionProbeStatus::Healthy
}

fn explicit_replay_refusal(session_name: &str) -> CliError {
    CliError(format!(
        "Hmux session `{session_name}` is not live and its saved recipe uses an explicit \
         command; automatic replay was refused. Run `hmux restore {session_name} --run \
         --foreground` to confirm it"
    ))
}

fn probe(catalog: &LocalSessionCatalog, session: &LocalSession) -> SessionProbeStatus {
    probe_local_session_exact(catalog, session.descriptor())
}
