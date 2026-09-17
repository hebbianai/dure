use std::fs::{self, File};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dure_app::ProviderIdV1;
use dure_app_sqlite::SqliteDomainStore;
use tokio::net::UnixListener;
use tokio::sync::{Mutex, Notify, Semaphore, oneshot};
use tokio::task::JoinSet;

use crate::agent_runtime_transition_apply::deferred::idle;

#[cfg(unix)]
use crate::managed_structured_runtime;

use super::{
    BACKEND_ID, ControlPlaneError, MAX_ACTIVE_CONNECTIONS, MAX_ACTIVE_REQUESTS,
    MAX_ACTIVE_SUBSCRIPTIONS, SERVICE_DESCRIPTOR_SCHEMA_VERSION, ServeOptions, ServiceDescriptor,
    ServiceState, agent_conversation, agent_conversation_api, agent_operation_lock,
    agent_runtime_recovery, assert_owner_directory, assert_owner_regular_file,
    candidate_descriptor_path, control_plane_build_id, descriptor_hmux_identity,
    descriptor_hmux_identity_matches, descriptor_socket_path_is_valid, ensure_backend_root,
    handle_connection, now_ms, owner_file, provider_credential_profile, provider_extension,
    random_generation, read_descriptor, read_replacement_intent,
    resolve_control_plane_executable_identity, resolve_hmux_toolchain_identity, runtime_extension,
    schedule_runtime, structured_provider_composition, structured_provider_runtime,
    valid_generation, valid_replacement_direction, workflow_launch, workspace_git,
    write_descriptor,
};

/// The request endpoint projected by the descriptor publication transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlPlaneEndpoint {
    pub backend_id: String,
    pub generation: String,
    pub socket_path: PathBuf,
}

impl From<&ServiceDescriptor> for ControlPlaneEndpoint {
    fn from(descriptor: &ServiceDescriptor) -> Self {
        Self {
            backend_id: descriptor.backend_id.clone(),
            generation: descriptor.generation.clone(),
            socket_path: descriptor.socket_path.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ActivateStagedOptions {
    pub home: PathBuf,
    pub source_generation: String,
    pub target_generation: String,
}

pub(crate) fn with_descriptor_transition<T>(
    root: &Path,
    transition: impl FnOnce(&Path) -> Result<T, ControlPlaneError>,
) -> Result<T, ControlPlaneError> {
    let lock = owner_file(&root.join("descriptor.transition.lock"))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    let result = transition(&root.join("control-plane.json"));
    drop(lock);
    result
}

pub fn activate_staged(
    options: ActivateStagedOptions,
) -> Result<ControlPlaneEndpoint, ControlPlaneError> {
    if !valid_generation(&options.source_generation)
        || !valid_generation(&options.target_generation)
        || options.source_generation == options.target_generation
    {
        return Err(ControlPlaneError::Invalid(
            "staged activation generation is invalid",
        ));
    }
    let backend_root = ensure_backend_root(&options.home)?;
    let root = backend_root.durable().to_path_buf();
    let candidate_path = candidate_descriptor_path(&root, &options.target_generation);
    with_descriptor_transition(&root, |canonical_path| {
        let current = read_descriptor(canonical_path)?.ok_or(ControlPlaneError::Invalid(
            "control-plane descriptor generation conflicts",
        ))?;
        if current.generation == options.target_generation {
            if current.activation_source_generation.as_deref()
                != Some(options.source_generation.as_str())
            {
                return Err(ControlPlaneError::Invalid(
                    "control-plane descriptor generation conflicts",
                ));
            }
            File::open(&root)?.sync_all()?;
            return Ok(ControlPlaneEndpoint::from(&current));
        }
        if current.generation != options.source_generation {
            return Err(ControlPlaneError::Invalid(
                "control-plane descriptor generation conflicts",
            ));
        }
        let intent = read_replacement_intent(&root, &options.source_generation)
            .map_err(|_| ControlPlaneError::Invalid("staged replacement intent is invalid"))?;
        let candidate = read_descriptor(&candidate_path)?.ok_or(ControlPlaneError::Invalid(
            "staged control-plane descriptor is unavailable",
        ))?;
        if intent.source.build_id != current.build_id
            || intent.source.hmux_identity != descriptor_hmux_identity(&current)
            || !valid_replacement_direction(current.build_id.as_deref(), &intent.target.build_id)
            || intent.target.generation != options.target_generation
            || candidate.schema_version != SERVICE_DESCRIPTOR_SCHEMA_VERSION
            || candidate.backend_id != BACKEND_ID
            || candidate.generation != intent.target.generation
            || candidate.build_id.as_deref() != Some(intent.target.build_id.as_str())
            || candidate.control_plane_identity.as_ref()
                != Some(&intent.target.control_plane_identity)
            || descriptor_hmux_identity(&candidate).as_ref() != Some(&intent.target.hmux_identity)
            || candidate.activation_source_generation.as_deref()
                != Some(options.source_generation.as_str())
            || !descriptor_socket_path_is_valid(&root, &candidate)
        {
            return Err(ControlPlaneError::Invalid(
                "staged control-plane descriptor is invalid",
            ));
        }
        fs::rename(&candidate_path, canonical_path)?;
        File::open(&root)?.sync_all()?;
        Ok(ControlPlaneEndpoint::from(&candidate))
    })
}

struct BoundSocket {
    listener: UnixListener,
    path: Option<PathBuf>,
}

impl BoundSocket {
    fn bind(path: PathBuf) -> Result<Self, ControlPlaneError> {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(&path)?,
            Ok(_) => return Err(ControlPlaneError::Invalid("socket path is not a socket")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let listener = UnixListener::bind(&path)?;
        let socket = Self {
            listener,
            path: Some(path),
        };
        fs::set_permissions(socket.path(), fs::Permissions::from_mode(0o600))?;
        Ok(socket)
    }

    fn listener(&self) -> &UnixListener {
        &self.listener
    }

    fn path(&self) -> &Path {
        self.path
            .as_deref()
            .expect("bound control-plane socket retains its path while serving")
    }

    fn cleanup(&mut self) -> io::Result<()> {
        let Some(path) = self.path.take() else {
            return Ok(());
        };
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                self.path = Some(path);
                Err(error)
            }
        }
    }
}

impl Drop for BoundSocket {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

enum DescriptorTarget {
    Canonical {
        root: PathBuf,
        expected_generation: Option<String>,
    },
    Staged(PathBuf),
}

impl DescriptorTarget {
    fn publish(
        &self,
        descriptor: &ServiceDescriptor,
    ) -> Result<Option<StagedDescriptorPublication>, ControlPlaneError> {
        match self {
            Self::Canonical {
                root,
                expected_generation,
            } => {
                with_descriptor_transition(root, |canonical_path| {
                    let current = read_descriptor(canonical_path)?;
                    let matches = match (current.as_ref(), expected_generation.as_deref()) {
                        (None, None) => true,
                        (Some(current), Some(expected)) => current.generation == expected,
                        _ => false,
                    };
                    if !matches {
                        return Err(ControlPlaneError::Invalid(
                            "control-plane descriptor generation conflicts",
                        ));
                    }
                    write_descriptor(canonical_path, descriptor)
                })?;
                Ok(None)
            }
            Self::Staged(path) => {
                if read_descriptor(path)?
                    .is_some_and(|current| current.generation != descriptor.generation)
                {
                    return Err(ControlPlaneError::Invalid(
                        "control-plane descriptor generation conflicts",
                    ));
                }
                write_descriptor(path, descriptor)?;
                Ok(Some(StagedDescriptorPublication {
                    path: Some(path.clone()),
                    descriptor: descriptor.clone(),
                }))
            }
        }
    }
}

struct StagedDescriptorPublication {
    path: Option<PathBuf>,
    descriptor: ServiceDescriptor,
}

impl StagedDescriptorPublication {
    fn cleanup(&mut self) -> Result<(), ControlPlaneError> {
        let Some(path) = self.path.take() else {
            return Ok(());
        };
        let result = (|| {
            if read_descriptor(&path)?.is_some_and(|descriptor| descriptor == self.descriptor) {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.path = Some(path);
        }
        result
    }
}

impl Drop for StagedDescriptorPublication {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

struct ControlPlaneRuntime {
    socket: BoundSocket,
    state: Arc<ServiceState>,
    _generation_lock: File,
}

#[must_use = "a prepared control plane must be served to become discoverable"]
/// A bound control plane whose fallible runtime preparation has completed.
pub struct PreparedControlPlane {
    runtime: ControlPlaneRuntime,
    descriptor_target: DescriptorTarget,
}

impl PreparedControlPlane {
    /// Publishes the descriptor and serves requests until shutdown.
    pub async fn serve(self) -> Result<(), ControlPlaneError> {
        self.serve_observed(|_| {}).await
    }

    /// Serves requests and emits the endpoint after descriptor publication.
    pub async fn serve_with_publication(
        self,
        published: oneshot::Sender<ControlPlaneEndpoint>,
    ) -> Result<(), ControlPlaneError> {
        self.serve_observed(move |endpoint| {
            let _ = published.send(endpoint);
        })
        .await
    }

    async fn serve_observed(
        self,
        on_published: impl FnOnce(ControlPlaneEndpoint),
    ) -> Result<(), ControlPlaneError> {
        let Self {
            mut runtime,
            descriptor_target,
        } = self;
        let mut staged_publication = descriptor_target.publish(&runtime.state.descriptor)?;
        on_published(ControlPlaneEndpoint::from(&runtime.state.descriptor));

        let state = Arc::clone(&runtime.state);
        let mut background_tasks = JoinSet::new();
        background_tasks.spawn(schedule_runtime::run_loop(Arc::clone(&state)));
        background_tasks.spawn(crate::workflow_graph::runtime::run_loop(Arc::clone(&state)));
        background_tasks.spawn(agent_runtime_recovery::run(Arc::clone(&state)));
        background_tasks.spawn(idle::run(Arc::clone(&state)));
        background_tasks.spawn(crate::slack_connector::restore_when_active(Arc::clone(&state)));
        background_tasks.spawn(crate::agent_goal::run(Arc::clone(&state)));
        let mut connections = JoinSet::new();
        let mut listener_error = None;
        loop {
            let permit = tokio::select! {
                permit = Arc::clone(&state.connection_slots).acquire_owned() => {
                    let Ok(permit) = permit else {
                        break;
                    };
                    permit
                }
                () = state.shutdown.notified() => break,
                _ = connections.join_next(), if !connections.is_empty() => continue,
            };
            tokio::select! {
                accepted = runtime.socket.listener().accept() => {
                    let (stream, _) = match accepted {
                        Ok(accepted) => accepted,
                        Err(error) => {
                            listener_error = Some(error);
                            break;
                        }
                    };
                    let state = Arc::clone(&state);
                    connections.spawn(async move {
                        let _permit = permit;
                        let _ = handle_connection(state, stream).await;
                    });
                }
                () = state.shutdown.notified() => break,
            }
        }
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        background_tasks.abort_all();
        while background_tasks.join_next().await.is_some() {}
        let slack_retirement = state.slack.shutdown().await;
        let browser_retirement = state.browser.shutdown().await;
        state.store.close().await;

        runtime.socket.cleanup()?;
        if let Some(publication) = staged_publication.as_mut() {
            publication.cleanup()?;
        }
        if let Some(error) = listener_error {
            return Err(error.into());
        }
        browser_retirement?;
        slack_retirement.map_err(|error| ControlPlaneError::Message(error.code))?;
        Ok(())
    }
}

pub async fn serve(options: ServeOptions) -> Result<(), ControlPlaneError> {
    prepare_with_agent_conversation_runtimes(
        options,
        Arc::new(agent_conversation_api::AgentConversationRuntimeRegistry::default()),
    )
    .await?
    .serve()
    .await
}

pub async fn prepare_with_agent_conversation_runtimes(
    options: ServeOptions,
    agent_conversation_runtimes: Arc<agent_conversation_api::AgentConversationRuntimeRegistry>,
) -> Result<PreparedControlPlane, ControlPlaneError> {
    unsafe {
        libc::umask(0o077);
    }
    let projects_catalog_path = options.home.join("backend-projects.json");
    let backend_root = ensure_backend_root(&options.home)?;
    let root = backend_root.durable().to_path_buf();
    let descriptor_path = root.join("control-plane.json");
    let current_descriptor = read_descriptor(&descriptor_path)?;
    let hmux_identity = resolve_hmux_toolchain_identity(
        &options.hmux_bin,
        &options.hmux_runtime_bin,
        &options.hmux_discovery_root,
    )?;
    let launch_executable = match options.launch_executable.as_deref() {
        Some(executable) => executable.to_path_buf(),
        None => std::env::current_exe()?,
    };
    let control_plane_identity = resolve_control_plane_executable_identity(&launch_executable)?;
    let database_path = root.join("application-state.sqlite3");
    let generation = match current_descriptor.as_ref() {
        Some(_) => match options.expected_generation {
            Some(generation) if valid_generation(&generation) => generation,
            Some(_) => {
                return Err(ControlPlaneError::Invalid("expected generation is invalid"));
            }
            None => {
                return Err(ControlPlaneError::Invalid(
                    "an existing control plane requires an expected generation",
                ));
            }
        },
        None => match options.expected_generation {
            Some(generation) if valid_generation(&generation) => generation,
            Some(_) => {
                return Err(ControlPlaneError::Invalid("expected generation is invalid"));
            }
            None => random_generation()?,
        },
    };
    let activation_source = options.activation_source_generation.as_deref();
    let invalid_activation =
        activation_source.is_some_and(|source| !valid_generation(source) || source == generation);
    let invalid_transition = match current_descriptor.as_ref() {
        None => options.staged || activation_source.is_some(),
        Some(current) if options.staged => {
            activation_source != Some(current.generation.as_str())
                || generation == current.generation
        }
        Some(current) => {
            generation != current.generation
                || current.schema_version != SERVICE_DESCRIPTOR_SCHEMA_VERSION
                || current.build_id.as_deref() != Some(control_plane_build_id())
                || activation_source != current.activation_source_generation.as_deref()
                || current.control_plane_identity.as_ref() != Some(&control_plane_identity)
                || !descriptor_hmux_identity_matches(current, &hmux_identity)
        }
    };
    if invalid_activation || invalid_transition {
        return Err(ControlPlaneError::Invalid(
            "activation source generation is invalid",
        ));
    }
    if options.staged {
        let source = activation_source.ok_or(ControlPlaneError::Invalid(
            "activation source generation is invalid",
        ))?;
        let intent_directory = root.join("replacement-intents");
        assert_owner_directory(&intent_directory)?;
        assert_owner_regular_file(&intent_directory.join(format!("{source}.json")))?;
    }

    let generation_lock = owner_file(&root.join(format!("service.{generation}.lock")))?;
    if unsafe { libc::flock(generation_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(ControlPlaneError::Invalid(
            "control-plane generation is already running",
        ));
    }
    let descriptor_target = if options.staged {
        DescriptorTarget::Staged(candidate_descriptor_path(&root, &generation))
    } else {
        DescriptorTarget::Canonical {
            root: root.clone(),
            expected_generation: current_descriptor
                .as_ref()
                .map(|descriptor| descriptor.generation.clone()),
        }
    };
    let socket = BoundSocket::bind(
        backend_root.control_plane_socket(SERVICE_DESCRIPTOR_SCHEMA_VERSION, &generation)?,
    )?;
    drop(owner_file(&database_path)?);
    let store = Arc::new(
        SqliteDomainStore::open(database_path.clone())
            .await
            .map_err(|error| ControlPlaneError::Message(error.to_string()))?,
    );
    assert_owner_regular_file(&database_path)?;
    let descriptor = ServiceDescriptor {
        schema_version: SERVICE_DESCRIPTOR_SCHEMA_VERSION,
        backend_id: BACKEND_ID.into(),
        build_id: Some(control_plane_build_id().into()),
        generation,
        activation_source_generation: options.activation_source_generation.clone(),
        socket_path: socket.path().to_path_buf(),
        database_path: database_path.clone(),
        control_plane_identity: Some(control_plane_identity),
        hmux_executable_path: Some(hmux_identity.executable_path.clone()),
        hmux_executable_device: Some(hmux_identity.executable_device.clone()),
        hmux_executable_inode: Some(hmux_identity.executable_inode.clone()),
        hmux_executable_size: Some(hmux_identity.executable_size.clone()),
        hmux_executable_modified: Some(hmux_identity.executable_modified.clone()),
        hmux_executable_sha256: Some(hmux_identity.executable_sha256.clone()),
        hmux_runtime_executable_path: Some(hmux_identity.runtime_executable_path.clone()),
        hmux_runtime_executable_device: Some(hmux_identity.runtime_executable_device.clone()),
        hmux_runtime_executable_inode: Some(hmux_identity.runtime_executable_inode.clone()),
        hmux_runtime_executable_size: Some(hmux_identity.runtime_executable_size.clone()),
        hmux_runtime_executable_modified: Some(hmux_identity.runtime_executable_modified.clone()),
        hmux_runtime_executable_sha256: Some(hmux_identity.runtime_executable_sha256.clone()),
        hmux_discovery_root: Some(hmux_identity.discovery_root.clone()),
        hmux_discovery_device: Some(hmux_identity.discovery_device.clone()),
        hmux_discovery_inode: Some(hmux_identity.discovery_inode.clone()),
        process_id: std::process::id(),
        observed_at_ms: now_ms()?,
    };
    let agent_conversation_service = Arc::new(
        agent_conversation::AgentConversationService::new(Arc::clone(&store))
            .with_backend_home(options.home.clone()),
    );
    let platform_home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from);
    let credential_profiles = Arc::new(
        provider_credential_profile::ProviderCredentialProfileRegistry::with_platform_home(
            options.home.clone(),
            platform_home,
            Arc::clone(&store),
        ),
    );
    #[cfg(unix)]
    let claude_runtime = match options.claude_structured_runtime.as_ref() {
        Some(runtime) => Some(
            structured_provider_composition::prepare_claude_structured_runtime(
                structured_provider_composition::ClaudeStructuredRuntimePreparation {
                    options: runtime,
                    backend_root: &backend_root,
                    descriptor: &descriptor,
                    hmux_identity: &hmux_identity,
                    credential_profiles: Arc::clone(&credential_profiles),
                    store: Arc::clone(&store),
                    conversation_service: Arc::clone(&agent_conversation_service),
                    runtime_registry: Arc::clone(&agent_conversation_runtimes),
                },
            )?,
        ),
        None => None,
    };
    #[cfg(unix)]
    let managed_runtimes = {
        let mut runtimes = Vec::new();
        for provider in [
            managed_structured_runtime::ManagedProviderKind::Codex,
            managed_structured_runtime::ManagedProviderKind::OpenCode,
            managed_structured_runtime::ManagedProviderKind::Pi,
        ] {
            let runtime = structured_provider_composition::prepare_managed_structured_runtime(
                structured_provider_composition::ManagedStructuredRuntimePreparation {
                    provider,
                    backend_root: &backend_root,
                    descriptor: &descriptor,
                    provider_launcher_executable: &launch_executable,
                    hmux_identity: &hmux_identity,
                    credential_profiles: Arc::clone(&credential_profiles),
                    store: Arc::clone(&store),
                    conversation_service: Arc::clone(&agent_conversation_service),
                    runtime_registry: Arc::clone(&agent_conversation_runtimes),
                },
            )?;
            runtimes.push((provider, runtime));
        }
        runtimes
    };
    let agent_conversations = Arc::new(agent_conversation_api::AgentConversationApi::new(
        agent_conversation_service,
        Arc::clone(&agent_conversation_runtimes),
    ));
    #[cfg(unix)]
    let structured_runtimes = {
        let mut registry =
            structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
        if let Some(runtime) = claude_runtime.as_ref() {
            registry
                .register(
                    ProviderIdV1::new("claude").expect("static provider ID is valid"),
                    Arc::clone(runtime)
                        as Arc<dyn structured_provider_runtime::StructuredProviderRuntime>,
                )
                .expect("bundled structured provider IDs are unique");
        }
        for (provider, runtime) in managed_runtimes {
            registry
                .register(
                    ProviderIdV1::new(provider.id()).expect("static provider ID is valid"),
                    runtime as Arc<dyn structured_provider_runtime::StructuredProviderRuntime>,
                )
                .expect("bundled structured provider IDs are unique");
        }
        Arc::new(registry)
    };
    #[cfg(unix)]
    let structured_providers = structured_runtimes.providers();
    #[cfg(not(unix))]
    let structured_providers = std::collections::BTreeSet::new();
    let agent_providers = Arc::new(provider_extension::local_agent_provider_registry(
        &options.home,
        structured_providers,
    ));
    let state = Arc::new(ServiceState {
        scope_id: crate::backend_scope::load_or_create(backend_root.durable())?,
        slack: crate::slack_connector::SlackConnectorService::new(
            backend_root.durable(),
            &options.home,
            launch_executable.with_file_name("dure.mjs"),
            hmux_identity.clone(),
        ),
        browser: crate::browser_service::BrowserService::new(
            backend_root,
            &descriptor.generation,
            &options.home,
        ),
        descriptor,
        canonical_descriptor_path: descriptor_path,
        agent_providers: Arc::clone(&agent_providers),
        runtime_adapters: Arc::new(runtime_extension::local_hmux_runtime_registry(
            hmux_identity.clone(),
        )),
        credential_aware_workflow_launcher: Arc::new(
            workflow_launch::HmuxWorkflowSessionLauncher::new(
                hmux_identity.runtime_executable_path.clone(),
                hmux_identity.discovery_root.clone(),
            ),
        ),
        workflow_prompt_deliverer: Arc::new(workflow_launch::HmuxWorkflowPromptDeliverer::new(
            hmux_identity.discovery_root.clone(),
            agent_providers,
        )),
        workflow_prompt_activity_observer: Arc::new(
            workflow_launch::HmuxWorkflowPromptActivityObserver::new(
                hmux_identity.discovery_root.clone(),
            ),
        ),
        workspace_acquirer: Arc::new(workspace_git::GitWorkspaceAcquirer::default()),
        hmux_identity,
        projects_catalog_path,
        store,
        credential_profiles,
        #[cfg(unix)]
        claude_runtime,
        #[cfg(unix)]
        structured_runtimes,
        agent_conversation_runtimes,
        agent_conversations,
        agent_operations: agent_operation_lock::AgentOperationLocks::default(),
        agent_runtime_recovery_wake: Notify::new(),
        goal_wakeup: Notify::new(),
        runtime_idle: idle::IdleRuntime::from_environment(),
        project_catalog_lock: Mutex::new(()),
        workflow_lock: Mutex::new(()),
        request_slots: Arc::new(Semaphore::new(MAX_ACTIVE_REQUESTS)),
        subscription_slots: Arc::new(Semaphore::new(MAX_ACTIVE_SUBSCRIPTIONS)),
        connection_slots: Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS)),
        shutdown: Notify::new(),
    });

    Ok(PreparedControlPlane {
        runtime: ControlPlaneRuntime {
            socket,
            state,
            _generation_lock: generation_lock,
        },
        descriptor_target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(
        root: &Path,
        generation: &str,
        activation_source_generation: Option<&str>,
        process_id: u32,
    ) -> ServiceDescriptor {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": SERVICE_DESCRIPTOR_SCHEMA_VERSION,
            "backendId": BACKEND_ID,
            "buildId": "dure-control-plane/v1-test",
            "generation": generation,
            "activationSourceGeneration": activation_source_generation,
            "socketPath": crate::backend_runtime_root::from_durable(root)
                .unwrap()
                .control_plane_socket(SERVICE_DESCRIPTOR_SCHEMA_VERSION, generation)
                .unwrap(),
            "databasePath": root.join("application-state.sqlite3"),
            "controlPlaneIdentity": {
                "executablePath": root.join("control-plane"),
                "executableDevice": "1",
                "executableInode": "2",
                "executableSize": "3",
                "executableModified": "4:5",
                "executableSha256": "a".repeat(64)
            },
            "hmuxExecutablePath": root.join("hmux"),
            "hmuxExecutableDevice": "6",
            "hmuxExecutableInode": "7",
            "hmuxExecutableSize": "8",
            "hmuxExecutableModified": "9:10",
            "hmuxExecutableSha256": "b".repeat(64),
            "hmuxRuntimeExecutablePath": root.join("hmux-runtime"),
            "hmuxRuntimeExecutableDevice": "11",
            "hmuxRuntimeExecutableInode": "12",
            "hmuxRuntimeExecutableSize": "13",
            "hmuxRuntimeExecutableModified": "14:15",
            "hmuxRuntimeExecutableSha256": "c".repeat(64),
            "hmuxDiscoveryRoot": root.join("hmux-discovery"),
            "hmuxDiscoveryDevice": "16",
            "hmuxDiscoveryInode": "17",
            "processId": process_id,
            "observedAtMs": i64::from(process_id)
        }))
        .unwrap()
    }

    fn write_replacement_intent(
        root: &Path,
        source: &ServiceDescriptor,
        target: &ServiceDescriptor,
    ) {
        let directory = root.join("replacement-intents");
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join(format!("{}.json", source.generation));
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "kind": "dure.local_backend_replacement_intent",
                "source": {
                    "generation": source.generation,
                    "buildId": source.build_id,
                    "hmuxIdentity": descriptor_hmux_identity(source)
                },
                "target": {
                    "generation": target.generation,
                    "buildId": target.build_id,
                    "controlPlaneIdentity": target.control_plane_identity,
                    "hmuxIdentity": descriptor_hmux_identity(target).unwrap()
                },
                "createdAtMs": 1
            }))
            .unwrap(),
        )
        .unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn descriptor_transition_lock_covers_the_transition_closure() {
        let home = tempfile::tempdir().unwrap();
        let backend_root = ensure_backend_root(home.path()).unwrap();
        let root = backend_root.durable().to_path_buf();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first_root = root.clone();
        let first = std::thread::spawn(move || {
            with_descriptor_transition(&first_root, |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .unwrap();
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();

        let (second_tx, second_rx) = std::sync::mpsc::channel();
        let second = std::thread::spawn(move || {
            with_descriptor_transition(&root, |_| {
                second_tx.send(()).unwrap();
                Ok(())
            })
            .unwrap();
        });
        assert_eq!(
            second_rx.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
        release_tx.send(()).unwrap();
        second_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        first.join().unwrap();
        second.join().unwrap();
    }

    #[test]
    fn staged_activation_requires_the_current_exact_intent() {
        let home = tempfile::tempdir().unwrap();
        let backend_root = ensure_backend_root(home.path()).unwrap();
        let root = backend_root.durable().to_path_buf();
        let canonical_path = root.join("control-plane.json");
        let source_generation = "local-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let target_generation = "local-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let stale_generation = "local-v1-cccccccccccccccccccccccccccccccc";
        let source = descriptor(&root, source_generation, None, 1);
        let target = descriptor(&root, target_generation, Some(source_generation), 2);
        let stale_target = descriptor(&root, stale_generation, Some(source_generation), 3);
        write_descriptor(&canonical_path, &source).unwrap();
        write_descriptor(
            &candidate_descriptor_path(&root, target_generation),
            &target,
        )
        .unwrap();
        write_replacement_intent(&root, &source, &stale_target);

        let options = ActivateStagedOptions {
            home: home.path().into(),
            source_generation: source_generation.into(),
            target_generation: target_generation.into(),
        };
        assert!(activate_staged(options.clone()).is_err());
        assert_eq!(
            read_descriptor(&canonical_path).unwrap(),
            Some(source.clone())
        );
        write_replacement_intent(&root, &source, &target);
        activate_staged(options.clone()).unwrap();
        activate_staged(options).unwrap();
        assert_eq!(read_descriptor(&canonical_path).unwrap(), Some(target));
    }

    #[test]
    fn canonical_generation_transition_never_reverts_an_activated_target() {
        let home = tempfile::tempdir().unwrap();
        let backend_root = ensure_backend_root(home.path()).unwrap();
        let root = backend_root.durable().to_path_buf();
        let canonical_path = root.join("control-plane.json");
        let source_generation = "local-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let target_generation = "local-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let source = descriptor(&root, source_generation, None, 1);
        let restarted_source = descriptor(&root, source_generation, None, 2);
        let target = descriptor(&root, target_generation, Some(source_generation), 3);
        let stale_restart = DescriptorTarget::Canonical {
            root: root.clone(),
            expected_generation: Some(source_generation.into()),
        };

        write_descriptor(&canonical_path, &source).unwrap();
        write_descriptor(
            &candidate_descriptor_path(&root, target_generation),
            &target,
        )
        .unwrap();
        write_replacement_intent(&root, &source, &target);
        activate_staged(ActivateStagedOptions {
            home: home.path().into(),
            source_generation: source_generation.into(),
            target_generation: target_generation.into(),
        })
        .unwrap();
        assert!(stale_restart.publish(&restarted_source).is_err());
        assert_eq!(
            read_descriptor(&canonical_path).unwrap(),
            Some(target.clone())
        );

        write_descriptor(&canonical_path, &source).unwrap();
        write_descriptor(
            &candidate_descriptor_path(&root, target_generation),
            &target,
        )
        .unwrap();
        stale_restart.publish(&restarted_source).unwrap();
        activate_staged(ActivateStagedOptions {
            home: home.path().into(),
            source_generation: source_generation.into(),
            target_generation: target_generation.into(),
        })
        .unwrap();
        assert_eq!(read_descriptor(&canonical_path).unwrap(), Some(target));
    }
}
