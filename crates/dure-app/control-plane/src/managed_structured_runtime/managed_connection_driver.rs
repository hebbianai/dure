use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use dure_app::AgentInteractionBindingV1;
use hmux_client::{
    MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION, MANAGED_STOP_OUTCOME_UNKNOWN_CODE,
    ManagedCreateAdvanceResolution, ManagedCreateChainResolution, ManagedCreateFailureDisposition,
    ManagedCreateIdentityResolution, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ManagedSessionCreator, ManagedSessionStopper, ManagedStopOutcome, ManagedStopRequest,
    PermissionMode, ProviderConversationIdentitySeed, ProviderStateEnvironment, SessionDescriptor,
};
use tokio::time::{Duration, Instant};

use crate::provider_turn_settings::ProviderTurnSettings;
use crate::structured_provider_runtime::{
    StructuredProviderRuntimeErrorKindV1 as ErrorKind, StructuredProviderRuntimeErrorV1 as Error,
};

use super::managed_create_checkpoint::{
    ManagedCreateCheckpointResolution, cleanup_managed_create_checkpoint,
    cleanup_presentation_predecessor, persist_effective_managed_create_identity,
    prepare_managed_create_checkpoint, resolve_managed_create_checkpoint,
    resolve_presentation_predecessor,
};
use super::{
    ManagedStructuredRuntimeConfiguration, conflict, digest, error, invalid, launch_failed,
    recovery_pending, stop_failed, unavailable,
};

const SOCKET_READY_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET_READY_INTERVAL: Duration = Duration::from_millis(25);
const EXACT_STOP_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Clone, Debug)]
pub(super) struct RuntimeFiles {
    pub(super) directory: PathBuf,
    pub(super) endpoint: PathBuf,
    pub(super) upstream: PathBuf,
    pub(super) managed_create_identity: PathBuf,
    pub(super) session_id: String,
    pub(super) idempotency_key: String,
}

#[derive(Debug)]
pub(super) enum ManagedConnectionDriverCreateOutcome {
    Live(Box<SessionDescriptor>),
}

#[derive(Debug)]
pub(super) enum ManagedConnectionDriverExistingOutcome {
    ReplayPrepared,
    Existing(Box<SessionDescriptor>),
    NotFound,
    Terminal,
    RetrySame,
}

#[derive(Debug)]
pub(super) enum ManagedConnectionDriverStopTargetOutcome {
    Existing(Box<SessionDescriptor>),
    NotFound,
    Terminal,
    RetrySame,
}

pub(super) fn cleanup_runtime_files(files: &RuntimeFiles) {
    cleanup_socket(&files.endpoint);
    cleanup_socket(&files.upstream);
    cleanup_managed_create_checkpoint(files);
    cleanup_presentation_predecessor(files);
    let _ = fs::remove_dir(&files.directory);
}

fn cleanup_socket(socket: &Path) {
    if fs::symlink_metadata(socket).is_ok_and(|metadata| {
        metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::geteuid() }
    }) {
        let _ = fs::remove_file(socket);
    }
}

pub(super) fn runtime_files(
    configuration: &ManagedStructuredRuntimeConfiguration,
    binding: &AgentInteractionBindingV1,
) -> Result<RuntimeFiles, Error> {
    // Preserve the v1 session identity and public app.sock endpoint so a live
    // pre-driver generation remains recoverable through capability negotiation.
    let provider = configuration.provider.kind.id();
    let namespace = configuration.provider.kind.process_namespace();
    let identity = digest(&format!(
        "{namespace}/v1\0{}\0{}\0{}",
        binding.interaction_session_id,
        binding.runtime.runtime_generation,
        binding.runtime.provider_epoch,
    ));
    let identity = &identity[..24];
    let directory = configuration.state_root.join(format!("r.{identity}"));
    let address_directory = configuration.address_root.join(format!("r.{identity}"));
    let endpoint = address_directory.join("app.sock");
    let upstream = address_directory.join("provider.sock");
    if endpoint.as_os_str().as_bytes().len() >= 100 || upstream.as_os_str().as_bytes().len() >= 100
    {
        return Err(error(
            ErrorKind::RuntimeUnavailable,
            "managed_provider_socket_path_unavailable",
        ));
    }
    Ok(RuntimeFiles {
        directory,
        endpoint,
        upstream,
        managed_create_identity: configuration
            .state_root
            .join(format!("r.{identity}"))
            .join("managed-create-identity.json"),
        session_id: format!("{provider}-chat-{identity}"),
        idempotency_key: format!("{namespace}-create-{identity}"),
    })
}

pub(super) async fn create_managed_connection_driver(
    configuration: &ManagedStructuredRuntimeConfiguration,
    binding: &AgentInteractionBindingV1,
    workspace_id: &str,
    cwd: &Path,
    files: &RuntimeFiles,
    environment: ProviderStateEnvironment,
    settings: &ProviderTurnSettings,
) -> Result<ManagedConnectionDriverCreateOutcome, Error> {
    let command = configuration.provider.command(
        &configuration.provider_launcher_executable,
        files,
        binding,
        settings,
    )?;
    let (source_session_id, source_idempotency_key) =
        match resolve_managed_create_checkpoint(files, workspace_id)? {
            ManagedCreateCheckpointResolution::Missing => {
                (files.session_id.clone(), files.idempotency_key.clone())
            }
            ManagedCreateCheckpointResolution::Prepared {
                session_id,
                idempotency_key,
            }
            | ManagedCreateCheckpointResolution::Effective {
                session_id,
                idempotency_key,
            } => (session_id, idempotency_key),
        };
    let mut request = ManagedCreateRequest::new(
        &source_idempotency_key,
        &source_session_id,
        workspace_id,
        configuration.provider.kind.id(),
        if settings.bypasses_approvals() {
            PermissionMode::BypassApprovals
        } else {
            PermissionMode::Default
        },
        cwd,
        command,
        24,
        80,
    )
    .map_err(|_| invalid())?;
    if let Some(conversation_id) = binding.provider_conversation_ref.as_deref() {
        request = request
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new(
                    configuration.provider.kind.id(),
                    conversation_id,
                )
                .map_err(|_| invalid())?,
            )
            .map_err(|_| invalid())?;
    }
    if let Some(predecessor) = resolve_presentation_predecessor(files)? {
        request = request
            .with_presentation_predecessor(predecessor)
            .map_err(|_| invalid())?;
    }
    request = request
        .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        .map_err(|_| invalid())?;
    if !environment.is_empty() {
        request = request
            .with_provider_state_environment(environment)
            .map_err(|_| invalid())?;
    }
    let request_digest = digest(
        &request
            .canonical_create_identity_json()
            .map_err(|_| invalid())?,
    );
    prepare_managed_create_checkpoint(
        files,
        workspace_id,
        &source_session_id,
        &source_idempotency_key,
        &request_digest,
    )
    .map_err(|_| recovery_pending())?;
    let creator = ManagedSessionCreator::new(&configuration.hmux_runtime)
        .with_discovery_root(&configuration.discovery_root);
    let created =
        match tokio::task::spawn_blocking(move || creator.create_or_reconcile_and_advance(request))
            .await
        {
            Ok(Ok(
                ManagedCreateAdvanceResolution::Current(created)
                | ManagedCreateAdvanceResolution::Advanced(created),
            )) => created,
            Ok(Ok(
                ManagedCreateAdvanceResolution::Pending
                | ManagedCreateAdvanceResolution::AuthorityUnavailable(_),
            ))
            | Err(_) => return Err(super::recovery_pending()),
            Ok(Err(create_error)) => {
                return Err(match create_error.disposition() {
                    ManagedCreateFailureDisposition::Rejected => error(
                        ErrorKind::ExplicitRecoveryRequired,
                        "managed_provider_managed_create_rejected",
                    ),
                    ManagedCreateFailureDisposition::Retryable => launch_failed(),
                });
            }
        };
    let descriptor = created.session().descriptor().clone();
    if descriptor.provider_id != binding.provider_id.as_str() {
        // The successor edge is immutable once Hmux answers. Preserve the
        // target and the Prepared checkpoint: destroying it here would make
        // an exact replay return a permanently retired successor.
        return Err(conflict());
    }
    persist_effective_managed_create_identity(
        files,
        workspace_id,
        &request_digest,
        created.receipt().session_id(),
        created.receipt().idempotency_key(),
    )
    .map_err(|_| recovery_pending())?;
    Ok(ManagedConnectionDriverCreateOutcome::Live(Box::new(
        descriptor,
    )))
}

pub(super) async fn wait_for_socket(path: &Path) -> Result<(), Error> {
    let deadline = Instant::now() + SOCKET_READY_TIMEOUT;
    loop {
        match fs::symlink_metadata(path) {
            Ok(metadata)
                if metadata.file_type().is_socket()
                    && metadata.uid() == unsafe { libc::geteuid() } =>
            {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                    .map_err(|_| launch_failed())?;
                return Ok(());
            }
            Ok(_) => return Err(conflict()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(launch_failed()),
        }
        if Instant::now() >= deadline {
            return Err(error(
                ErrorKind::LaunchFailed,
                "managed_provider_readiness_failed",
            ));
        }
        tokio::time::sleep(SOCKET_READY_INTERVAL).await;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExactStopDisposition {
    Stopped,
    DefinitivePreEffectRefusal,
}

async fn request_exact_stop(
    configuration: &ManagedStructuredRuntimeConfiguration,
    descriptor: &SessionDescriptor,
) -> Result<ExactStopDisposition, Error> {
    let Ok(channel_epoch) = descriptor.channel_epoch.parse() else {
        return Ok(ExactStopDisposition::DefinitivePreEffectRefusal);
    };
    let request = ManagedStopRequest::new(
        format!(
            "{}-stop-{}",
            configuration.provider.kind.process_namespace(),
            &digest(&descriptor.session_id)[..24]
        ),
        &descriptor.session_id,
        &descriptor.workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &descriptor.runner_principal,
            &descriptor.runner_instance,
            channel_epoch,
            &descriptor.host_instance_id,
            &descriptor.terminal_epoch,
        )
    });
    let Ok(request) = request else {
        return Ok(ExactStopDisposition::DefinitivePreEffectRefusal);
    };
    let stopper =
        ManagedSessionStopper::new(&configuration.hmux_runtime, &configuration.state_root)
            .with_discovery_root(&configuration.discovery_root);
    let deadline = Instant::now() + EXACT_STOP_TIMEOUT;
    loop {
        let stopper = stopper.clone();
        let request = request.clone();
        match tokio::task::spawn_blocking(move || stopper.stop(request)).await {
            Ok(Ok(receipt))
                if matches!(
                    receipt.outcome(),
                    ManagedStopOutcome::Stopped | ManagedStopOutcome::AlreadyExited
                ) =>
            {
                return Ok(ExactStopDisposition::Stopped);
            }
            Ok(Err(error))
                if error.code() == MANAGED_STOP_OUTCOME_UNKNOWN_CODE
                    && Instant::now() < deadline =>
            {
                tokio::time::sleep(SOCKET_READY_INTERVAL).await;
            }
            Ok(Err(error)) if error.is_definitive_managed_stop_refusal() => {
                return Ok(ExactStopDisposition::DefinitivePreEffectRefusal);
            }
            _ => return Err(stop_failed()),
        }
    }
}

pub(super) async fn stop_exact(
    configuration: &ManagedStructuredRuntimeConfiguration,
    descriptor: &SessionDescriptor,
) -> Result<(), Error> {
    match request_exact_stop(configuration, descriptor).await? {
        ExactStopDisposition::Stopped => Ok(()),
        ExactStopDisposition::DefinitivePreEffectRefusal => Err(stop_failed()),
    }
}

pub(super) async fn stop_selected_source_exact(
    configuration: &ManagedStructuredRuntimeConfiguration,
    descriptor: &SessionDescriptor,
) -> Result<(), Error> {
    match request_exact_stop(configuration, descriptor).await? {
        ExactStopDisposition::Stopped => Ok(()),
        ExactStopDisposition::DefinitivePreEffectRefusal => Err(conflict()),
    }
}

pub(super) async fn reconcile_existing_managed_connection_driver(
    configuration: &ManagedStructuredRuntimeConfiguration,
    workspace_id: &str,
    files: &RuntimeFiles,
) -> ManagedConnectionDriverExistingOutcome {
    let workspace_id = workspace_id.to_owned();
    let checkpoint = match resolve_managed_create_checkpoint(files, &workspace_id) {
        Ok(checkpoint) => checkpoint,
        Err(_) => return ManagedConnectionDriverExistingOutcome::RetrySame,
    };
    let (session_id, idempotency_key) = match checkpoint {
        ManagedCreateCheckpointResolution::Prepared { .. } => {
            return ManagedConnectionDriverExistingOutcome::ReplayPrepared;
        }
        ManagedCreateCheckpointResolution::Effective {
            session_id,
            idempotency_key,
        } => (session_id, idempotency_key),
        ManagedCreateCheckpointResolution::Missing => {
            (files.session_id.clone(), files.idempotency_key.clone())
        }
    };
    let creator = ManagedSessionCreator::new(&configuration.hmux_runtime)
        .with_discovery_root(&configuration.discovery_root);
    let request =
        match ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id) {
            Ok(request) => request,
            Err(_) => return ManagedConnectionDriverExistingOutcome::RetrySame,
        };
    match tokio::task::spawn_blocking(move || creator.reconcile_identity(request)).await {
        Ok(Ok(ManagedCreateIdentityResolution::Existing(existing))) => {
            let descriptor = existing.session().descriptor();
            if descriptor.provider_id == configuration.provider.kind.id() {
                ManagedConnectionDriverExistingOutcome::Existing(Box::new(descriptor.clone()))
            } else {
                ManagedConnectionDriverExistingOutcome::RetrySame
            }
        }
        Ok(Ok(ManagedCreateIdentityResolution::NotFound)) => {
            ManagedConnectionDriverExistingOutcome::NotFound
        }
        Ok(Ok(
            ManagedCreateIdentityResolution::AbandonedBeforeCompletion
            | ManagedCreateIdentityResolution::Retired,
        )) => ManagedConnectionDriverExistingOutcome::Terminal,
        Ok(Ok(
            ManagedCreateIdentityResolution::Pending
            | ManagedCreateIdentityResolution::AuthorityUnavailable(_),
        ))
        | Ok(Err(_))
        | Err(_) => ManagedConnectionDriverExistingOutcome::RetrySame,
    }
}

/// Claims the canonical managed-create successor slot before an unattached
/// stop. A Prepared checkpoint may already have an immutable successor edge
/// even though the control plane lost the advance response, so identity-only
/// reconciliation cannot safely choose the source generation here.
pub(super) async fn claim_managed_connection_driver_for_stop(
    configuration: &ManagedStructuredRuntimeConfiguration,
    workspace_id: &str,
    files: &RuntimeFiles,
) -> ManagedConnectionDriverStopTargetOutcome {
    let (session_id, idempotency_key) = match resolve_managed_create_checkpoint(files, workspace_id)
    {
        Ok(ManagedCreateCheckpointResolution::Missing) => {
            (files.session_id.clone(), files.idempotency_key.clone())
        }
        Ok(
            ManagedCreateCheckpointResolution::Prepared {
                session_id,
                idempotency_key,
            }
            | ManagedCreateCheckpointResolution::Effective {
                session_id,
                idempotency_key,
            },
        ) => (session_id, idempotency_key),
        Err(_) => return ManagedConnectionDriverStopTargetOutcome::RetrySame,
    };
    let request =
        match ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id) {
            Ok(request) => request,
            Err(_) => return ManagedConnectionDriverStopTargetOutcome::RetrySame,
        };
    let creator = ManagedSessionCreator::new(&configuration.hmux_runtime)
        .with_discovery_root(&configuration.discovery_root);
    match tokio::task::spawn_blocking(move || creator.claim_successor_chain_cleanup(request)).await
    {
        Ok(Ok(ManagedCreateChainResolution::Existing(existing))) => {
            let descriptor = existing.session().descriptor();
            if descriptor.provider_id == configuration.provider.kind.id() {
                ManagedConnectionDriverStopTargetOutcome::Existing(Box::new(descriptor.clone()))
            } else {
                ManagedConnectionDriverStopTargetOutcome::RetrySame
            }
        }
        Ok(Ok(ManagedCreateChainResolution::NotFound)) => {
            ManagedConnectionDriverStopTargetOutcome::NotFound
        }
        Ok(Ok(ManagedCreateChainResolution::TerminalWithoutSuccessor)) => {
            ManagedConnectionDriverStopTargetOutcome::Terminal
        }
        Ok(Ok(ManagedCreateChainResolution::Pending)) | Ok(Err(_)) | Err(_) => {
            ManagedConnectionDriverStopTargetOutcome::RetrySame
        }
    }
}

pub(super) fn ensure_runtime_directory(path: &Path) -> Result<(), Error> {
    match fs::create_dir(path) {
        Ok(()) => {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| unavailable())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            exact_owner_directory(path).map(|_| ())
        }
        Err(_) => Err(unavailable()),
    }
}

pub(super) fn exact_executable(path: &Path) -> Result<PathBuf, Error> {
    let canonical = path.canonicalize().map_err(|_| unavailable())?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|_| unavailable())?;
    if !canonical.is_absolute()
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o111 == 0
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(unavailable());
    }
    Ok(canonical)
}

pub(super) fn exact_owner_directory(path: &Path) -> Result<PathBuf, Error> {
    let metadata = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(unavailable());
    }
    path.canonicalize().map_err(|_| unavailable())
}

pub(super) fn exact_directory(path: &Path) -> Result<PathBuf, Error> {
    let canonical = path.canonicalize().map_err(|_| invalid())?;
    if !path.is_absolute() || !canonical.is_dir() {
        return Err(invalid());
    }
    Ok(canonical)
}
