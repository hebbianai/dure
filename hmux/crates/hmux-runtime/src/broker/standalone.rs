//! Standalone session creation, exact recovery, and broker framing.

use crate::host::{HOST_PACKET_SCHEMA, HostLaunchPacket, HostSpawnFailure, spawn_host};
use crate::recovery::{
    read_optional_resurrection_recipe, remove_resurrection_recipe_exact, save_resurrection_recipe,
};
use crate::server::resolve_command;
use crate::{DynError, Result, unix_time_ms};
use hmux_client::recovery_journal::standalone_broker_admission::StandaloneBrokerAdmission;
use hmux_client::recovery_journal::{SAVED_RECIPE_RECOVERY_NAMESPACE, lock_source};
use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, SessionClass as ClientSessionClass,
    SessionDescriptor, SessionProbeStatus, probe_local_process_generation,
    probe_local_session_exact, standalone_create_idempotency_key,
};
use hmux_host::local_discovery::{
    DiscoveryManifest, DiscoveryRoot, LocalEndpointKind, PresentationCheckpointSource,
    SessionClass, StaleDiscoveryReason, workspace_id_for_path,
};
use hmux_runtime_contract::{
    ProviderStateEnvironment, StandaloneCreateBrokerResponse, StandaloneCreateReceipt,
    StandaloneCreateRequest, StandaloneRecipeRequirement, StandaloneResurrectionRecipe,
    read_standalone_create_request, write_standalone_create_response,
};
use std::fs;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug)]
struct StandaloneRecoveryRefusal {
    code: &'static str,
    message: String,
}

impl std::fmt::Display for StandaloneRecoveryRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StandaloneRecoveryRefusal {}

fn recovery_refusal(code: &'static str, message: impl Into<String>) -> DynError {
    Box::new(StandaloneRecoveryRefusal {
        code,
        message: message.into(),
    })
}

fn create_failure_code(error: &DynError) -> &str {
    if let Some(failure) = error.downcast_ref::<hmux_client::ClientError>() {
        return failure.code();
    }
    if let Some(failure) = error.downcast_ref::<HostSpawnFailure>() {
        return failure.code();
    }
    error
        .downcast_ref::<StandaloneRecoveryRefusal>()
        .map_or("hmux_standalone_launch_failed", |failure| failure.code)
}

pub(crate) fn run() -> Result<()> {
    let response = match read_standalone_create_request(&mut io::stdin()) {
        Ok(request) => match launch(request) {
            Ok(receipt) => {
                crate::capacity_maintenance::schedule(receipt.discovery_root());
                StandaloneCreateBrokerResponse::Created(receipt)
            }
            Err(error) => StandaloneCreateBrokerResponse::refused(
                create_failure_code(&error),
                error.to_string(),
            ),
        },
        Err(error) => StandaloneCreateBrokerResponse::refused(
            "hmux_standalone_request_invalid",
            error.to_string(),
        ),
    };
    write_standalone_create_response(&mut io::stdout(), &response)?;
    Ok(())
}

fn launch(request: StandaloneCreateRequest) -> Result<StandaloneCreateReceipt> {
    request.validate()?;
    let request_provider_cwd = fs::canonicalize(request.provider_cwd())?;
    if !request_provider_cwd.is_dir() {
        return Err("provider cwd is not a directory".into());
    }
    let random = Uuid::new_v4().simple().to_string();
    let deterministic_identity = request.recovery_identity().is_some();
    let recipe_requirement = request
        .recovery_identity()
        .map(|identity| identity.recipe_requirement());
    let requires_existing_recipe =
        recipe_requirement == Some(StandaloneRecipeRequirement::Existing);
    let request_bound_recipe =
        recipe_requirement == Some(StandaloneRecipeRequirement::RequestBound);
    let session_id = request
        .recovery_identity()
        .map(|identity| identity.target_session_id().to_string())
        .unwrap_or_else(|| format!("standalone_{}", &random[..12]));
    let session_name = request
        .session_name()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("hmux-{}", &random[..6]));
    let workspace_id = workspace_id_for_path(&request_provider_cwd);
    let discovery_catalog = LocalSessionCatalog::from_environment()?;
    let discovery_root = discovery_catalog.discovery_root().to_path_buf();
    let launch_owner_proof = request
        .recovery_identity()
        .map(|identity| identity.launch_owner_proof().to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let idempotency_key = request
        .recovery_identity()
        .map(standalone_create_idempotency_key);
    DiscoveryRoot::create(&discovery_root)?;
    crate::prepare_host_admission_capacity(&discovery_root);
    let _launch = StandaloneBrokerAdmission::acquire(&discovery_root)?.admit(&request)?;
    refuse_read_only_name_conflict(&discovery_catalog, &session_name)?;
    let _recipe_lock = lock_source(
        &discovery_root,
        SAVED_RECIPE_RECOVERY_NAMESPACE,
        &session_name,
    )?;
    let previous_recipe = read_optional_resurrection_recipe(&discovery_root, &session_name)?;
    if request_bound_recipe && previous_recipe.is_some() {
        return Err(recovery_refusal(
            "hmux_standalone_recipe_conflict",
            "a general saved recipe already owns this standalone session name",
        ));
    }
    let recipe = if let Some(canonical) = previous_recipe.as_ref() {
        if !request_matches_recipe(&request, &request_provider_cwd, &session_name, canonical) {
            return Err(recovery_refusal(
                "hmux_standalone_recipe_conflict",
                "standalone create request does not match the canonical saved recipe",
            ));
        }
        canonical.clone()
    } else if requires_existing_recipe {
        return Err(recovery_refusal(
            "hmux_standalone_recovery_target_unavailable",
            "standalone recovery recipe is unavailable; no replacement was started",
        ));
    } else {
        recipe_from_request(&request, &request_provider_cwd, &session_name)?
    };
    if deterministic_identity {
        let state = reusable_session(
            &discovery_root,
            &workspace_id,
            &session_id,
            &session_name,
            idempotency_key.as_deref(),
        )?;
        if require_recoverable_target_state(state)? {
            return receipt(
                session_id,
                workspace_id,
                session_name,
                discovery_root,
                launch_owner_proof,
            );
        }
    }
    let presentation_source = refuse_duplicate_name(
        &discovery_root,
        &session_name,
        request.recovery_identity(),
        idempotency_key.as_deref(),
    )?;
    let provider_cwd = recipe.provider_cwd().to_path_buf();
    let (provider_program, provider_args) = resolve_command(recipe.command());
    let packet = HostLaunchPacket {
        schema: HOST_PACKET_SCHEMA.to_string(),
        discovery_root: discovery_root.clone(),
        provider_program,
        provider_args,
        provider_cwd,
        workspace_id: workspace_id.clone(),
        session_id: session_id.clone(),
        session_class: SessionClass::Standalone,
        provider_id: "local-shell".to_string(),
        session_name: Some(session_name.clone()),
        idempotency_key,
        initial_rows: recipe.initial_rows(),
        initial_columns: recipe.initial_columns(),
        terminal_default_colors: recipe.terminal_default_colors().unwrap_or_default(),
        terminal_environment: recipe.terminal_environment().clone(),
        provider_state_environment: ProviderStateEnvironment::default(),
        launch_owner_proof: Some(launch_owner_proof.clone()),
        retirement_policy: recipe.retirement_policy(),
        resurrection_recipe: (!request_bound_recipe).then(|| recipe.clone()),
        presentation_source,
        presentation_handoff: None,
        conversation_identity: None,
    };

    // The Host may publish Ready as soon as it starts, and Ready is an external
    // attach boundary. Make reboot recovery durable before crossing it so a
    // recipe fault can never revoke a generation another client has already
    // observed or written to.
    let published_recipe = !request_bound_recipe && previous_recipe.is_none();
    if published_recipe {
        if let Err(save_error) = save_resurrection_recipe(&discovery_root, &recipe) {
            let rollback_error = remove_resurrection_recipe_exact(&discovery_root, &recipe).err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "could not save standalone resurrection recipe: {save_error}; \
                 exact recipe rollback also failed: {rollback_error}"
                )
                .into(),
                None => format!(
                    "could not save standalone resurrection recipe; no Host was launched: \
                     {save_error}"
                )
                .into(),
            });
        }
    }

    if let Err(launch_error) = spawn_host(&packet) {
        if deterministic_identity {
            let state = reusable_session(
                &discovery_root,
                &workspace_id,
                &session_id,
                &session_name,
                packet.idempotency_key.as_deref(),
            );
            match state {
                Ok(StandaloneRecoveryTargetState::Reusable) => {
                    return receipt(
                        session_id,
                        workspace_id,
                        session_name,
                        discovery_root,
                        launch_owner_proof,
                    );
                }
                Ok(StandaloneRecoveryTargetState::Absent)
                | Ok(StandaloneRecoveryTargetState::Transient)
                | Err(_) => {
                    return Err(recovery_refusal(
                        "hmux_standalone_recovery_target_unavailable",
                        format!(
                            "standalone recovery Host did not become ready; the exact request \
                             remains retryable: {launch_error}"
                        ),
                    ));
                }
            }
        }
        if launch_error.is_uncertain() {
            return Err(Box::new(launch_error));
        }
        if !published_recipe {
            return Err(Box::new(launch_error));
        }
        let rollback_error = remove_resurrection_recipe_exact(&discovery_root, &recipe).err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "{launch_error}; exact resurrection recipe rollback also failed: {rollback_error}"
            )
            .into(),
            None => Box::new(launch_error),
        });
    }

    receipt(
        session_id,
        workspace_id,
        session_name,
        discovery_root,
        launch_owner_proof,
    )
}

fn refuse_read_only_name_conflict(catalog: &LocalSessionCatalog, session_name: &str) -> Result<()> {
    if catalog
        .list_read_only_migration_sessions_named(session_name)?
        .iter()
        .any(|session| {
            session.session_class == ClientSessionClass::Standalone
                && session.session_name.as_deref() == Some(session_name)
        })
    {
        return Err(recovery_refusal(
            "hmux_standalone_read_only_name_conflict",
            format!(
                "standalone session name `{session_name}` remains reserved by read-only legacy discovery"
            ),
        ));
    }
    Ok(())
}

fn receipt(
    session_id: String,
    workspace_id: String,
    session_name: String,
    discovery_root: PathBuf,
    launch_owner_proof: String,
) -> Result<StandaloneCreateReceipt> {
    Ok(StandaloneCreateReceipt::new(
        session_id,
        workspace_id,
        session_name,
        discovery_root,
        launch_owner_proof,
    )?)
}

fn recipe_from_request(
    request: &StandaloneCreateRequest,
    canonical_provider_cwd: &Path,
    session_name: &str,
) -> Result<StandaloneResurrectionRecipe> {
    let recipe = StandaloneResurrectionRecipe::new(
        session_name.to_string(),
        canonical_provider_cwd.to_path_buf(),
        request.command().to_vec(),
        request.initial_rows(),
        request.initial_columns(),
        unix_time_ms(),
    )?
    .with_resurrection_replay_policy(request.resurrection_replay_policy())?
    .with_terminal_environment(request.terminal_environment().clone())?
    .with_terminal_default_colors_option(request.terminal_default_colors())?;
    match request.retirement_policy() {
        Some(policy) => Ok(recipe.with_retirement_policy(policy)?),
        None => Ok(recipe),
    }
}

fn request_matches_recipe(
    request: &StandaloneCreateRequest,
    canonical_provider_cwd: &Path,
    session_name: &str,
    recipe: &StandaloneResurrectionRecipe,
) -> bool {
    request.session_name() == Some(session_name)
        && recipe.session_name() == session_name
        && recipe.provider_cwd() == canonical_provider_cwd
        && recipe.command() == request.command()
        && recipe.initial_rows() == request.initial_rows()
        && recipe.initial_columns() == request.initial_columns()
        && (request.terminal_environment().is_empty()
            || recipe.terminal_environment() == request.terminal_environment())
        && request
            .explicit_resurrection_replay_policy()
            .is_none_or(|policy| recipe.resurrection_replay_policy() == policy)
        && request
            .retirement_policy()
            .is_none_or(|policy| recipe.retirement_policy() == Some(policy))
}

enum StandaloneRecoveryTargetState {
    Reusable,
    Absent,
    Transient,
}

fn reusable_session(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    session_name: &str,
    idempotency_key: Option<&str>,
) -> Result<StandaloneRecoveryTargetState> {
    if !discovery_root.try_exists()? {
        return Ok(StandaloneRecoveryTargetState::Absent);
    }
    let root = DiscoveryRoot::open(discovery_root)?;
    let found = match root.find_manifest_by_session(workspace_id, session_id) {
        Ok(found) => found,
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound)
        | Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::MissingManifest,
            ..
        }) => {
            let Some(create_key) = idempotency_key else {
                return Ok(StandaloneRecoveryTargetState::Absent);
            };
            match root.find_retired_creation(workspace_id, session_id, create_key)? {
                Some(retired) => retired,
                None => return Ok(StandaloneRecoveryTargetState::Absent),
            }
        }
        Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::NotReady,
            ..
        }) => return Ok(StandaloneRecoveryTargetState::Transient),
        Err(error) => return Err(error.into()),
    };
    let common = found.manifest.common();
    if common.session_class != SessionClass::Standalone
        || common.provider_id != "local-shell"
        || common.session_name.as_deref() != Some(session_name)
        || common.claim_linkage.kickoff_action_id.as_deref() != idempotency_key
    {
        return Err(recovery_refusal(
            "hmux_standalone_recovery_identity_conflict",
            "standalone recovery target identity conflicts with existing state",
        ));
    }
    let descriptor = SessionDescriptor::from(found.clone());
    if !matches!(found.manifest, DiscoveryManifest::Ready(_)) {
        return Err(recovery_refusal(
            "hmux_standalone_recovery_target_exited",
            "standalone recovery target already exited",
        ));
    }
    let catalog = LocalSessionCatalog::new(discovery_root);
    match probe_local_session_exact(&catalog, &descriptor) {
        SessionProbeStatus::Healthy => Ok(StandaloneRecoveryTargetState::Reusable),
        SessionProbeStatus::StaleTransport => {
            let host_absent = probe_local_process_generation(&descriptor.host_process)?
                == LocalProcessGenerationStatus::Absent;
            let provider_absent = probe_local_process_generation(&descriptor.provider_process)?
                == LocalProcessGenerationStatus::Absent;
            if host_absent && provider_absent {
                Err(recovery_refusal(
                    "hmux_standalone_recovery_target_exited",
                    "the recorded standalone generation ended before publishing its exit",
                ))
            } else {
                Ok(StandaloneRecoveryTargetState::Transient)
            }
        }
        SessionProbeStatus::IncompatibleProtocol
        | SessionProbeStatus::Exited
        | SessionProbeStatus::GenerationChanged => Ok(StandaloneRecoveryTargetState::Transient),
    }
}

fn require_recoverable_target_state(state: StandaloneRecoveryTargetState) -> Result<bool> {
    match state {
        StandaloneRecoveryTargetState::Reusable => Ok(true),
        StandaloneRecoveryTargetState::Absent => Ok(false),
        StandaloneRecoveryTargetState::Transient => Err(recovery_refusal(
            "hmux_standalone_recovery_target_unavailable",
            "exact standalone recovery target is temporarily unavailable",
        )),
    }
}

fn refuse_duplicate_name(
    discovery_root: &Path,
    session_name: &str,
    recovery_identity: Option<&hmux_runtime_contract::StandaloneRecoveryCreateIdentity>,
    recovery_marker: Option<&str>,
) -> Result<Option<PresentationCheckpointSource>> {
    if !discovery_root.try_exists()? {
        return Ok(None);
    }
    let root = DiscoveryRoot::open(discovery_root)?;
    let mut newest_source = None;
    let mut candidates = Vec::new();
    for session in root.list_sessions_named(session_name)? {
        let DiscoveryManifest::Ready(ready) = &session.manifest else {
            continue;
        };
        if ready.common.session_class != SessionClass::Standalone
            || ready.common.session_name.as_deref() != Some(session_name)
        {
            continue;
        }
        let is_source = if let Some(identity) = recovery_identity {
            let is_target = ready.common.lifetime.session_id == identity.target_session_id()
                && ready.common.claim_linkage.kickoff_action_id.as_deref() == recovery_marker;
            let is_source = identity.source_predecessor().is_some_and(|source| {
                ready.common.lifetime.session_id == source.session_id()
                    && ready.common.lifetime.runner_principal == source.runner_principal()
                    && ready.common.lifetime.runner_instance == source.runner_instance()
                    && ready.common.lifetime.channel_epoch == source.channel_epoch()
                    && ready.common.host_instance_id == source.host_instance_id()
                    && ready.terminal_epoch == source.terminal_epoch()
            });
            if !is_target && !is_source {
                return Err(recovery_refusal(
                    "hmux_standalone_recovery_name_conflict",
                    "standalone recovery name conflicts with unrelated existing state",
                ));
            }
            if is_target {
                let descriptor = SessionDescriptor::from(session.clone());
                let host_absent = probe_local_process_generation(&descriptor.host_process)?
                    == LocalProcessGenerationStatus::Absent;
                let provider_absent = probe_local_process_generation(&descriptor.provider_process)?
                    == LocalProcessGenerationStatus::Absent;
                if !host_absent || !provider_absent {
                    return Err(recovery_refusal(
                        "hmux_standalone_recovery_target_unavailable",
                        "exact standalone recovery target changed during recovery",
                    ));
                }
            }
            is_source
        } else {
            false
        };
        let active = ready.endpoint.kind == LocalEndpointKind::UnixSocket
            && UnixStream::connect(&ready.endpoint.address).is_ok();
        if active {
            if recovery_identity.is_some() {
                return Err(recovery_refusal(
                    "hmux_standalone_recovery_target_unavailable",
                    format!("the standalone recovery source `{session_name}` became active"),
                ));
            }
            return Err(
                format!("an active Hmux session named `{session_name}` already exists").into(),
            );
        }
        let mut presentation_eligible = recovery_identity.is_none();
        if recovery_identity.is_some() {
            presentation_eligible = is_source;
        }
        if presentation_eligible {
            let source = PresentationCheckpointSource::from_ready(ready);
            let discovery = root.open_session(session.key.clone())?;
            if discovery.read_presentation_checkpoint(&source)?.is_some()
                && newest_source
                    .as_ref()
                    .is_none_or(|(_, ready_unix_ms)| *ready_unix_ms < ready.ready_unix_ms)
            {
                newest_source = Some((source, ready.ready_unix_ms));
            }
        }
        candidates.push(session);
    }
    candidates.sort_by(|left, right| left.discovery_path.cmp(&right.discovery_path));
    let mut locked = Vec::with_capacity(candidates.len());
    for session in candidates {
        let discovery = root.open_session(session.key.clone())?;
        let lifetime_lock = discovery.acquire_lifetime_lock()?;
        locked.push((session, discovery, lifetime_lock));
    }
    for (session, discovery, lifetime_lock) in locked {
        discovery.cleanup_current(&lifetime_lock, &session.manifest.generation())?;
    }
    Ok(newest_source.map(|(source, _)| source))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryKey, HostLifetimeIdentity, LocalEndpoint, ManifestCommon,
        ReadyManifest,
    };
    use hmux_host::local_protocol::{ProcessProof, ProtocolVersion, RuntimeContext, VersionRange};
    use hmux_runtime_contract::TerminalDefaultColors;
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    fn write_ready_fixture(root: &DiscoveryRoot, index: u64) {
        let session_id = format!("session-{index}");
        let runner_instance = format!("runner-{index}");
        let host_instance_id = format!("host-{index}");
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "build-v1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec!["screen_snapshot".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace".into(),
                session_id: session_id.clone(),
                runner_principal: "runner".into(),
                runner_instance: runner_instance.clone(),
                channel_epoch: index + 1,
            },
            host_instance_id: host_instance_id.clone(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id: 10_000 + index as u32,
                start_marker: format!("host-process-{index}"),
            },
            created_unix_ms: index + 1,
            session_class: SessionClass::Standalone,
            session_name: Some(format!("unrelated-{index}")),
            retirement_policy: None,
        };
        let ready = ReadyManifest {
            common,
            provider_process: ProcessProof {
                process_id: 20_000 + index as u32,
                start_marker: format!("provider-process-{index}"),
            },
            terminal_epoch: format!("terminal-{index}"),
            ready_output_seq: 0,
            endpoint: LocalEndpoint {
                kind: LocalEndpointKind::UnixSocket,
                address: root
                    .path()
                    .join(format!("missing-{index}.sock"))
                    .to_string_lossy()
                    .into_owned(),
            },
            capability_token: format!("token-{index}"),
            ready_unix_ms: index + 1,
        };
        let key = DiscoveryKey::new("workspace", session_id, runner_instance, index + 1).unwrap();
        let session_path = root.path().join(key.relative_path());
        std::fs::create_dir_all(&session_path).unwrap();
        std::fs::set_permissions(
            session_path.parent().unwrap(),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::set_permissions(&session_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let manifest_path = session_path.join("manifest.json");
        let mut manifest = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(manifest_path)
            .unwrap();
        manifest
            .write_all(&serde_json::to_vec(&DiscoveryManifest::Ready(ready)).unwrap())
            .unwrap();
    }

    #[test]
    fn unrelated_sessions_beyond_legacy_lookup_limit_do_not_block_new_name() {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let root = DiscoveryRoot::create(&discovery_root).unwrap();
        for index in 0..513 {
            write_ready_fixture(&root, index);
        }

        refuse_duplicate_name(&discovery_root, "new-name", None, None).unwrap();
    }

    #[test]
    fn presentation_color_changes_do_not_invalidate_an_exact_create_retry() {
        let recipe = StandaloneResurrectionRecipe::new("dev", "/tmp/work", Vec::new(), 24, 80, 1)
            .unwrap()
            .with_terminal_default_colors(
                TerminalDefaultColors::new(0x11_22_33, 0x44_55_66).unwrap(),
            )
            .unwrap();
        let retry =
            StandaloneCreateRequest::new("/tmp/work", Some("dev".into()), Vec::new(), 24, 80)
                .unwrap()
                .with_terminal_default_colors(
                    TerminalDefaultColors::new(0xaa_bb_cc, 0xdd_ee_ff).unwrap(),
                )
                .unwrap();

        assert!(request_matches_recipe(
            &retry,
            Path::new("/tmp/work"),
            "dev",
            &recipe,
        ));
    }
}
