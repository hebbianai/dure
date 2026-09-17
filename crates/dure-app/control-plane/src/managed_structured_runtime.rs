use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentInteractionBindingV1,
    AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeReplacementAuthorityV1, AgentRuntimeReplacementV1, AgentRuntimeTransitionRecordV1,
    AgentRuntimeTransitionStateV1, AgentRuntimeTransitionStore, AgentTimelineStore, DomainStore,
    ProviderCredentialProfileStore, ProviderIdV1,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{PresentationCheckpointPredecessor, ProviderStateEnvironment, SessionDescriptor};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::agent_conversation::AgentConversationService;
use crate::agent_conversation_api::AgentConversationRuntimeRegistry;
use crate::provider_credential_profile::{
    ProviderCredentialProfileErrorV1, ProviderCredentialProfileRegistry,
};
use crate::provider_turn_settings::ProviderTurnSettings;
use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntime,
    StructuredProviderRuntimeErrorKindV1 as ErrorKind, StructuredProviderRuntimeErrorV1 as Error,
    StructuredProviderRuntimeFuture, replacement_provider_conversation_ref,
    transition_owns_structured_source,
};

use crate::managed_provider_connection::{AttachedProviderConnection, ManagedProviderConnection};

mod configuration;
mod provider;
mod runtime;
pub(crate) use configuration::ManagedStructuredRuntimeConfiguration;
pub(crate) use provider::{ManagedProviderExecutable, ManagedProviderKind};

mod binding;
mod managed_connection_driver;
#[cfg(test)]
mod managed_connection_driver_tests;
mod managed_create_checkpoint;

use binding::*;
use managed_connection_driver::*;
use managed_create_checkpoint::{
    persist_presentation_predecessor, resolve_presentation_predecessor,
};

#[cfg(test)]
const CODEX_PROVIDER_ID: &str = "codex";

struct ActiveManagedRuntime {
    binding: AgentInteractionBindingV1,
    cwd: PathBuf,
    descriptor: SessionDescriptor,
    files: RuntimeFiles,
    settings: ProviderTurnSettings,
    bridge: Arc<dyn ManagedProviderConnection>,
}

#[derive(Debug)]
struct StoppedManagedRuntime {
    descriptor: Option<SessionDescriptor>,
    files: RuntimeFiles,
}

type RuntimeSlot = Arc<Mutex<Option<ActiveManagedRuntime>>>;

enum ManagedLaunchOutcome {
    Ready(Box<AgentInteractionBindingV1>),
    RetiredExact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ManagedLaunchMode {
    Ensure,
    TransitionEnsure,
    RecoverExisting,
    RecoverExistingForStop,
}

#[derive(Clone)]
struct PreparedProviderCredential {
    expected_home: Option<PathBuf>,
    environment: ProviderStateEnvironment,
}

fn prepared_provider_credential_from_environment(
    provider: ManagedProviderKind,
    execution_profile: &AgentExecutionProfileV1,
    environment: ProviderStateEnvironment,
) -> Result<PreparedProviderCredential, Error> {
    let expected_home = provider.credential_home(&environment);
    match (execution_profile, expected_home.as_ref()) {
        (AgentExecutionProfileV1::ProviderDefault, None)
        | (AgentExecutionProfileV1::CredentialReference { .. }, Some(_)) => {}
        _ => {
            return Err(map_credential_error(
                ProviderCredentialProfileErrorV1::Unavailable,
            ));
        }
    }
    Ok(PreparedProviderCredential {
        expected_home,
        environment,
    })
}

pub(crate) struct ManagedStructuredRuntimeManager<S>
where
    S: AgentTimelineStore
        + AgentRuntimeTransitionStore
        + DomainStore
        + ProviderCredentialProfileStore
        + 'static,
{
    slots: Arc<Mutex<BTreeMap<AgentInteractionSessionIdV1, RuntimeSlot>>>,
    configuration: ManagedStructuredRuntimeConfiguration,
    credential_profiles: Arc<ProviderCredentialProfileRegistry<S>>,
    conversation_service: Arc<AgentConversationService<S>>,
    runtime_registry: Arc<AgentConversationRuntimeRegistry>,
    store: Arc<S>,
}

impl<S> ManagedStructuredRuntimeManager<S>
where
    S: AgentTimelineStore
        + AgentRuntimeTransitionStore
        + DomainStore
        + ProviderCredentialProfileStore
        + 'static,
{
    pub(crate) fn new(
        configuration: ManagedStructuredRuntimeConfiguration,
        credential_profiles: Arc<ProviderCredentialProfileRegistry<S>>,
        conversation_service: Arc<AgentConversationService<S>>,
        runtime_registry: Arc<AgentConversationRuntimeRegistry>,
        store: Arc<S>,
    ) -> Self {
        Self {
            slots: Arc::new(Mutex::new(BTreeMap::new())),
            configuration,
            credential_profiles,
            conversation_service,
            runtime_registry,
            store,
        }
    }

    async fn open_runtime(
        &self,
        request: StructuredProviderOpenRequestV1,
    ) -> Result<AgentInteractionBindingV1, Error> {
        if !self.configuration.supports_new_sessions() {
            return Err(self.configuration.unavailable_error());
        }
        validate_request(&request)?;
        let agent = self
            .store
            .agent(&request.agent_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(invalid)?;
        if agent.provider_id.as_str() != self.configuration.provider.kind.id() {
            return Err(invalid());
        }
        let binding = match self
            .conversation_service
            .binding_for_agent(&request.agent_id)
            .await
            .map_err(|_| unavailable())?
        {
            Some(binding) => {
                validate_existing_binding(
                    self.configuration.provider.kind.id(),
                    &binding,
                    &request,
                )?;
                binding
            }
            None => {
                let binding =
                    initial_binding(&agent, &request, &self.configuration.backend_generation)?;
                self.conversation_service
                    .create(&binding)
                    .await
                    .map_err(|_| unavailable())?
            }
        };
        let settings =
            ProviderTurnSettings::new(request.permission_mode, request.model, request.effort);
        self.open_binding(binding, settings, ManagedLaunchMode::Ensure, None, None)
            .await
    }

    async fn attach_existing_runtime(
        &self,
        selection: &dure_app::AgentRuntimeSelectionV1,
        binding: &AgentInteractionBindingV1,
    ) -> Result<AgentInteractionBindingV1, Error> {
        let request = StructuredProviderOpenRequestV1 {
            agent_id: selection.agent_id.clone(),
            execution_profile: selection.execution_profile.clone(),
            provider_conversation_ref: binding.provider_conversation_ref.clone(),
            permission_mode: selection.permission_mode.clone(),
            model: selection.model.clone(),
            effort: selection.effort.clone(),
        };
        validate_request(&request)?;
        validate_existing_binding(self.configuration.provider.kind.id(), binding, &request)?;
        let settings = ProviderTurnSettings::new(
            selection.permission_mode.clone(),
            selection.model.clone(),
            selection.effort.clone(),
        );
        self.open_binding(
            binding.clone(),
            settings,
            ManagedLaunchMode::RecoverExisting,
            Some(selection),
            None,
        )
        .await
    }

    async fn open_replacement_runtime(
        &self,
        mut request: StructuredProviderOpenRequestV1,
        transition: &AgentRuntimeTransitionRecordV1,
        provider_state_environment: ProviderStateEnvironment,
    ) -> Result<AgentInteractionBindingV1, Error> {
        if !self.configuration.supports_new_sessions() {
            return Err(self.configuration.unavailable_error());
        }
        validate_replacement_request(self.configuration.provider.kind.id(), &request, transition)
            .map_err(Error::without_target)?;
        let prepared_credential = prepared_provider_credential_from_environment(
            self.configuration.provider.kind,
            &request.execution_profile,
            provider_state_environment,
        )
        .map_err(Error::without_target)?;
        let target_runtime = transition_runtime(transition);
        let failed_target = transition_failed_structured_binding(
            self.configuration.provider.kind.id(),
            transition,
        )?;
        request.provider_conversation_ref = replacement_provider_conversation_ref(
            request.provider_conversation_ref.as_deref(),
            failed_target,
        );
        let existing = self
            .conversation_service
            .binding_for_agent(&request.agent_id)
            .await
            .map_err(|_| unavailable())?;
        let binding = match &transition.intent.source_authority {
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
                let existing = existing.ok_or_else(conflict)?;
                if let Some(failed) = failed_target {
                    if is_exact_failed_target_successor(
                        &existing,
                        failed,
                        &target_runtime,
                        &request.execution_profile,
                    ) {
                        existing
                    } else if existing == *failed {
                        self.replace_binding(&existing, &request, target_runtime.clone())
                            .await?
                    } else {
                        return Err(conflict());
                    }
                } else if is_structured_transition_target(
                    &existing,
                    binding,
                    &request,
                    &target_runtime,
                    transition.intent.requested_at_ms,
                ) {
                    existing
                } else if existing == *binding {
                    self.replace_binding(&existing, &request, target_runtime.clone())
                        .await?
                } else {
                    return Err(conflict());
                }
            }
            AgentRuntimeBindingAuthorityV1::NativeCli { .. } => match existing {
                Some(existing) => {
                    if let Some(failed) = failed_target {
                        if is_exact_failed_target_successor(
                            &existing,
                            failed,
                            &target_runtime,
                            &request.execution_profile,
                        ) {
                            existing
                        } else if existing == *failed {
                            self.replace_binding(&existing, &request, target_runtime.clone())
                                .await?
                        } else {
                            return Err(conflict());
                        }
                    } else {
                        if existing.provider_id.as_str() != self.configuration.provider.kind.id()
                            || existing.agent_id != request.agent_id
                            || request
                                .provider_conversation_ref
                                .as_ref()
                                .is_some_and(|expected| {
                                    existing.provider_conversation_ref.as_ref() != Some(expected)
                                })
                        {
                            return Err(conflict());
                        }
                        if is_native_transition_target(
                            &existing,
                            &request,
                            &target_runtime,
                            transition.intent.requested_at_ms,
                        ) {
                            existing
                        } else {
                            self.retire_failed_binding(&existing).await?;
                            self.replace_binding(&existing, &request, target_runtime.clone())
                                .await?
                        }
                    }
                }
                None => {
                    let agent = self
                        .store
                        .agent(&request.agent_id)
                        .await
                        .map_err(|_| unavailable())?
                        .ok_or_else(invalid)?;
                    let mut binding =
                        initial_binding(&agent, &request, &self.configuration.backend_generation)?;
                    binding.runtime = target_runtime.clone();
                    binding.updated_at_ms = transition.intent.requested_at_ms;
                    self.conversation_service
                        .create(&binding)
                        .await
                        .map_err(|_| unavailable())?
                }
            },
        };
        let settings =
            ProviderTurnSettings::new(request.permission_mode, request.model, request.effort);
        let failed_binding = binding.clone();
        match self
            .open_binding(
                binding,
                settings,
                ManagedLaunchMode::TransitionEnsure,
                None,
                Some(prepared_credential),
            )
            .await
        {
            Ok(binding) => Ok(binding),
            Err(error) if replacement_failure_is_quiescent(&error) => {
                match self.current_owned_binding(&failed_binding).await {
                    Ok(published) => Err(error.with_failed_binding(published)),
                    Err(_) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }

    async fn replace_binding(
        &self,
        source: &AgentInteractionBindingV1,
        request: &StructuredProviderOpenRequestV1,
        target: AgentProviderRuntimeFenceV1,
    ) -> Result<AgentInteractionBindingV1, Error> {
        let replaced_at_ms = now_ms()?.max(source.updated_at_ms);
        let replacement = AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: source.interaction_session_id.clone(),
            expected_binding_revision: source.binding_revision,
            source: source.runtime.clone(),
            source_execution_profile: source.execution_profile.clone(),
            target,
            target_execution_profile: request.execution_profile.clone(),
            provider_conversation_ref: request.provider_conversation_ref.clone(),
            replaced_at_ms,
        };
        self.conversation_service
            .replace_runtime(&replacement)
            .await
            .map_err(|_| conflict())
    }

    async fn prepare_credential(
        &self,
        provider_id: &ProviderIdV1,
        execution_profile: &AgentExecutionProfileV1,
    ) -> Result<PreparedProviderCredential, Error> {
        let prepared = self
            .credential_profiles
            .prepare_for_launch(provider_id, execution_profile)
            .await
            .map_err(map_credential_error)?;
        let expected_home = prepared
            .resolved()
            .map(|profile| profile.directory().to_path_buf());
        Ok(PreparedProviderCredential {
            expected_home,
            environment: prepared.environment(),
        })
    }

    async fn open_binding(
        &self,
        mut binding: AgentInteractionBindingV1,
        settings: ProviderTurnSettings,
        mut mode: ManagedLaunchMode,
        expected_selection: Option<&dure_app::AgentRuntimeSelectionV1>,
        prepared_credential: Option<PreparedProviderCredential>,
    ) -> Result<AgentInteractionBindingV1, Error> {
        if mode == ManagedLaunchMode::RecoverExisting && !self.configuration.supports_new_sessions()
        {
            return Err(recovery_required());
        }
        loop {
            match self
                .launch_once(
                    binding.clone(),
                    &settings,
                    mode,
                    expected_selection,
                    prepared_credential.as_ref(),
                )
                .await?
            {
                ManagedLaunchOutcome::Ready(binding) => return Ok(*binding),
                ManagedLaunchOutcome::RetiredExact => {
                    if mode == ManagedLaunchMode::TransitionEnsure {
                        return Err(recovery_required());
                    }
                    if self.is_active_transition_source(&binding).await? {
                        return Err(conflict());
                    }
                    binding = self.rotate_failed_binding(&binding).await?;
                    mode = ManagedLaunchMode::Ensure;
                }
            }
        }
    }

    async fn is_active_transition_source(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<bool, Error> {
        let transition = self
            .store
            .active_agent_runtime_transition(&binding.agent_id)
            .await
            .map_err(|_| unavailable())?;
        Ok(transition
            .is_some_and(|transition| transition_owns_structured_source(&transition, binding)))
    }

    async fn launch_once(
        &self,
        binding: AgentInteractionBindingV1,
        settings: &ProviderTurnSettings,
        mode: ManagedLaunchMode,
        expected_selection: Option<&dure_app::AgentRuntimeSelectionV1>,
        prepared_credential: Option<&PreparedProviderCredential>,
    ) -> Result<ManagedLaunchOutcome, Error> {
        if let Some(expected) = expected_selection {
            let selection = self
                .store
                .agent_runtime_selection(&binding.agent_id)
                .await
                .map_err(|_| unavailable())?
                .ok_or_else(conflict)?;
            if expected != &selection {
                return Err(conflict());
            }
        }
        let agent = self
            .store
            .agent(&binding.agent_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(invalid)?;
        let workspace = self
            .store
            .workspace(&agent.workspace_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(invalid)?;
        let cwd = exact_directory(Path::new(&workspace.root_path))?;
        let workspace_id = agent.workspace_id.as_str().to_owned();
        let slot = {
            let mut slots = self.slots.lock().await;
            Arc::clone(
                slots
                    .entry(binding.interaction_session_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        let mut active = slot.lock().await;
        if let Some(current) = active.as_ref() {
            if current.binding.same_runtime_authority(&binding)
                && current.cwd == cwd
                && current.settings == *settings
            {
                if current.bridge.is_connected() {
                    return Ok(ManagedLaunchOutcome::Ready(Box::new(
                        current.binding.clone(),
                    )));
                }
                let descriptor = current.descriptor.clone();
                let files = current.files.clone();
                stop_exact(&self.configuration, &descriptor).await?;
                cleanup_runtime_files(&files);
                self.runtime_registry
                    .retire(&binding.interaction_session_id, &binding.runtime)
                    .map_err(|_| unavailable())?;
                active.take();
                return Ok(ManagedLaunchOutcome::RetiredExact);
            }
            return Err(conflict());
        }
        let files = runtime_files(&self.configuration, &binding)?;
        let (created, prepared_credential) = match mode {
            ManagedLaunchMode::Ensure | ManagedLaunchMode::TransitionEnsure => {
                let prepared = match prepared_credential {
                    Some(prepared) => prepared.clone(),
                    None => {
                        self.prepare_credential(&binding.provider_id, &binding.execution_profile)
                            .await?
                    }
                };
                ensure_runtime_directory(&files.directory)?;
                let created = create_managed_connection_driver(
                    &self.configuration,
                    &binding,
                    &workspace_id,
                    &cwd,
                    &files,
                    prepared.environment.clone(),
                    settings,
                )
                .await?;
                (created, prepared)
            }
            ManagedLaunchMode::RecoverExisting | ManagedLaunchMode::RecoverExistingForStop => {
                match reconcile_existing_managed_connection_driver(
                    &self.configuration,
                    &workspace_id,
                    &files,
                )
                .await
                {
                    ManagedConnectionDriverExistingOutcome::Existing(descriptor) => {
                        if mode == ManagedLaunchMode::RecoverExistingForStop
                            && !self.configuration.supports_new_sessions()
                        {
                            return Err(source_busy());
                        }
                        let prepared = match prepared_credential {
                            Some(prepared) => prepared.clone(),
                            None => {
                                self.prepare_credential(
                                    &binding.provider_id,
                                    &binding.execution_profile,
                                )
                                .await?
                            }
                        };
                        (
                            ManagedConnectionDriverCreateOutcome::Live(descriptor),
                            prepared,
                        )
                    }
                    ManagedConnectionDriverExistingOutcome::ReplayPrepared
                        if mode == ManagedLaunchMode::RecoverExisting
                            && self.configuration.supports_new_sessions() =>
                    {
                        let prepared = match prepared_credential {
                            Some(prepared) => prepared.clone(),
                            None => {
                                self.prepare_credential(
                                    &binding.provider_id,
                                    &binding.execution_profile,
                                )
                                .await?
                            }
                        };
                        ensure_runtime_directory(&files.directory)?;
                        let created = create_managed_connection_driver(
                            &self.configuration,
                            &binding,
                            &workspace_id,
                            &cwd,
                            &files,
                            prepared.environment.clone(),
                            settings,
                        )
                        .await?;
                        (created, prepared)
                    }
                    ManagedConnectionDriverExistingOutcome::ReplayPrepared => {
                        return Err(source_busy());
                    }
                    ManagedConnectionDriverExistingOutcome::NotFound
                    | ManagedConnectionDriverExistingOutcome::Terminal => {
                        cleanup_runtime_files(&files);
                        self.runtime_registry
                            .retire(&binding.interaction_session_id, &binding.runtime)
                            .map_err(|_| unavailable())?;
                        return Ok(ManagedLaunchOutcome::RetiredExact);
                    }
                    ManagedConnectionDriverExistingOutcome::RetrySame => {
                        return Err(recovery_pending());
                    }
                }
            }
        };
        let expected_home = prepared_credential.expected_home;
        let descriptor = match created {
            ManagedConnectionDriverCreateOutcome::Live(descriptor) => *descriptor,
        };
        let attached: Result<AttachedProviderConnection, Error> = async {
            wait_for_socket(&files.endpoint).await?;
            let attached = self
                .configuration
                .provider
                .kind
                .attach(
                    &binding,
                    &files.endpoint,
                    &cwd,
                    expected_home.as_deref(),
                    settings,
                    Arc::clone(&self.conversation_service),
                )
                .await?;
            if self
                .runtime_registry
                .register(attached.binding.clone(), Arc::clone(&attached.commands))
                .is_err()
            {
                attached.handler.abort();
                return Err(conflict());
            }
            Ok(attached)
        }
        .await;
        let AttachedProviderConnection {
            binding,
            connection: bridge,
            handler,
            ..
        } = match attached {
            Ok(attached) => attached,
            Err(error) => {
                if mode == ManagedLaunchMode::RecoverExisting
                    && error.kind == ErrorKind::LaunchFailed
                {
                    stop_exact(&self.configuration, &descriptor).await?;
                    cleanup_runtime_files(&files);
                    self.runtime_registry
                        .retire(&binding.interaction_session_id, &binding.runtime)
                        .map_err(|_| unavailable())?;
                    return Ok(ManagedLaunchOutcome::RetiredExact);
                }
                if matches!(
                    mode,
                    ManagedLaunchMode::Ensure | ManagedLaunchMode::TransitionEnsure
                ) {
                    stop_exact(&self.configuration, &descriptor).await?;
                    cleanup_runtime_files(&files);
                    if mode == ManagedLaunchMode::Ensure {
                        self.rotate_failed_binding(&binding).await?;
                    }
                }
                return Err(
                    if mode == ManagedLaunchMode::TransitionEnsure
                        && matches!(
                            error.kind,
                            ErrorKind::LaunchFailed | ErrorKind::RuntimeUnavailable
                        )
                    {
                        recovery_required()
                    } else {
                        error
                    },
                );
            }
        };
        *active = Some(ActiveManagedRuntime {
            binding: binding.clone(),
            cwd,
            descriptor,
            files,
            settings: settings.clone(),
            bridge: Arc::clone(&bridge),
        });
        drop(active);
        self.watch_connection(Arc::clone(&slot), binding.clone(), bridge, handler);
        Ok(ManagedLaunchOutcome::Ready(Box::new(binding)))
    }

    fn watch_connection(
        &self,
        slot: RuntimeSlot,
        binding: AgentInteractionBindingV1,
        bridge: Arc<dyn ManagedProviderConnection>,
        handler: tokio::task::JoinHandle<()>,
    ) {
        let slots = Arc::clone(&self.slots);
        let configuration = self.configuration.clone();
        let conversation_service = Arc::clone(&self.conversation_service);
        let runtime_registry = Arc::clone(&self.runtime_registry);
        tokio::spawn(async move {
            let _ = handler.await;
            let mut active = slot.lock().await;
            let Some(runtime) = active.as_ref() else {
                return;
            };
            if !runtime.binding.same_runtime_authority(&binding)
                || !Arc::ptr_eq(&runtime.bridge, &bridge)
            {
                return;
            }
            let Some(runtime) = active.take() else {
                return;
            };
            let stopped = stop_exact(&configuration, &runtime.descriptor)
                .await
                .is_ok();
            let _ = runtime_registry.retire(&binding.interaction_session_id, &binding.runtime);
            if stopped {
                cleanup_runtime_files(&runtime.files);
            }
            drop(active);
            let mut slots = slots.lock().await;
            if slots
                .get(&binding.interaction_session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &slot))
                && slot.try_lock().is_ok_and(|active| active.is_none())
            {
                slots.remove(&binding.interaction_session_id);
            }
            drop(slots);
            let _ = conversation_service.invalidate_runtime(&binding).await;
        });
    }

    async fn rotate_failed_binding(
        &self,
        source: &AgentInteractionBindingV1,
    ) -> Result<AgentInteractionBindingV1, Error> {
        let published = self.current_owned_binding(source).await?;
        let source = &published;
        self.conversation_service
            .replace_runtime(&AgentRuntimeReplacementV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: source.interaction_session_id.clone(),
                expected_binding_revision: source.binding_revision,
                source: source.runtime.clone(),
                source_execution_profile: source.execution_profile.clone(),
                target: failed_binding_recovery_runtime(source),
                target_execution_profile: source.execution_profile.clone(),
                provider_conversation_ref: source.provider_conversation_ref.clone(),
                replaced_at_ms: now_ms()?.max(source.updated_at_ms),
            })
            .await
            .map_err(|_| unavailable())
    }

    /// Attachment may allocate the exact conversation before a later operation
    /// fails. Recovery follows that publication within the same generation;
    /// it cannot adopt another runtime or forget a committed conversation.
    async fn current_owned_binding(
        &self,
        source: &AgentInteractionBindingV1,
    ) -> Result<AgentInteractionBindingV1, Error> {
        let current = self
            .conversation_service
            .binding(&source.interaction_session_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(conflict)?;
        if !source.same_runtime_authority(&current)
            || !crate::structured_provider_runtime::replacement_target_conversation_matches(
                source.provider_conversation_ref.as_deref(),
                current.provider_conversation_ref.as_deref(),
                source.binding_revision,
                current.binding_revision,
            )
        {
            return Err(conflict());
        }
        Ok(current)
    }

    async fn stop_replacement(
        &self,
        transition: &AgentRuntimeTransitionRecordV1,
    ) -> Result<(), Error> {
        transition.validate().map_err(|_| conflict())?;
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
            &transition.intent.source_authority
        else {
            return Err(conflict());
        };
        if transition.state != AgentRuntimeTransitionStateV1::Admitted
            || binding.provider_id.as_str() != self.configuration.provider.kind.id()
        {
            return Err(conflict());
        }
        let current = self
            .conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(conflict)?;
        if current != *binding {
            return Err(conflict());
        }
        let mut target_binding = binding.clone();
        target_binding.runtime = transition_runtime(transition);
        let target_files = runtime_files(&self.configuration, &target_binding)?;
        ensure_runtime_directory(&target_files.directory)?;
        let stopped = self
            .stop_binding_preserving_files(
                binding,
                transition.intent.source_stop_policy.requires_idle(),
            )
            .await?;
        if resolve_presentation_predecessor(&target_files)?.is_none() {
            if let Some(descriptor) = stopped.descriptor.as_ref() {
                persist_presentation_predecessor(
                    &target_files,
                    &presentation_predecessor(descriptor)?,
                )?;
            }
        }
        cleanup_runtime_files(&stopped.files);
        Ok(())
    }

    async fn retire_replacement_runtime(
        &self,
        transition: &AgentRuntimeTransitionRecordV1,
    ) -> Result<AgentRuntimeReplacementAuthorityV1, Error> {
        transition.validate().map_err(|_| conflict())?;
        let Some(authority) = transition.replacement_authority.as_ref() else {
            return Err(conflict());
        };
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: failed } = &authority.0
        else {
            return Err(conflict());
        };
        if failed.provider_id.as_str() != self.configuration.provider.kind.id() {
            return Err(conflict());
        }
        let current = self
            .conversation_service
            .binding(&failed.interaction_session_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(conflict)?;
        let target = failed_binding_recovery_runtime(failed);
        if is_exact_failed_target_successor(
            &current,
            failed,
            &target,
            &transition.intent.target_execution_profile,
        ) {
            return Ok(AgentRuntimeReplacementAuthorityV1(
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: current },
            ));
        }
        if current != *failed {
            return Err(conflict());
        }
        self.retire_failed_binding(failed).await?;
        let request = StructuredProviderOpenRequestV1 {
            agent_id: failed.agent_id.clone(),
            execution_profile: transition.intent.target_execution_profile.clone(),
            provider_conversation_ref: failed.provider_conversation_ref.clone(),
            permission_mode: transition.intent.effective_permission_mode(),
            model: None,
            effort: None,
        };
        let replacement = self
            .replace_binding(failed, &request, target.clone())
            .await?;
        if !is_exact_failed_target_successor(
            &replacement,
            failed,
            &target,
            &transition.intent.target_execution_profile,
        ) {
            return Err(conflict());
        }
        Ok(AgentRuntimeReplacementAuthorityV1(
            AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: replacement,
            },
        ))
    }

    async fn retire_failed_binding(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<(), Error> {
        let slot = {
            let slots = self.slots.lock().await;
            slots.get(&binding.interaction_session_id).map(Arc::clone)
        };
        if let Some(slot) = slot.as_ref() {
            let mut active = slot.lock().await;
            if let Some(runtime) = active.as_ref() {
                if runtime.binding != *binding {
                    return Err(conflict());
                }
                stop_exact(&self.configuration, &runtime.descriptor).await?;
                cleanup_runtime_files(&runtime.files);
                self.runtime_registry
                    .retire(&binding.interaction_session_id, &binding.runtime)
                    .map_err(|_| unavailable())?;
                active.take();
            }
        }
        let agent = self
            .store
            .agent(&binding.agent_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(invalid)?;
        let files = runtime_files(&self.configuration, binding)?;
        match claim_managed_connection_driver_for_stop(
            &self.configuration,
            agent.workspace_id.as_str(),
            &files,
        )
        .await
        {
            ManagedConnectionDriverStopTargetOutcome::Existing(descriptor) => {
                stop_exact(&self.configuration, &descriptor).await?;
            }
            ManagedConnectionDriverStopTargetOutcome::NotFound
            | ManagedConnectionDriverStopTargetOutcome::Terminal => {}
            ManagedConnectionDriverStopTargetOutcome::RetrySame => return Err(stop_failed()),
        }
        cleanup_runtime_files(&files);
        let _ = self
            .runtime_registry
            .retire(&binding.interaction_session_id, &binding.runtime);
        if let Some(slot) = slot.as_ref() {
            self.remove_empty_slot(binding, slot).await;
        }
        Ok(())
    }

    async fn stop_binding(
        &self,
        binding: &AgentInteractionBindingV1,
        require_idle: bool,
    ) -> Result<bool, Error> {
        let stopped = self
            .stop_binding_preserving_files(binding, require_idle)
            .await?;
        cleanup_runtime_files(&stopped.files);
        Ok(true)
    }

    async fn stop_binding_preserving_files(
        &self,
        binding: &AgentInteractionBindingV1,
        require_idle: bool,
    ) -> Result<StoppedManagedRuntime, Error> {
        if !require_idle {
            return self.stop_current_binding_preserving_files(binding).await;
        }
        let slot = {
            let slots = self.slots.lock().await;
            slots.get(&binding.interaction_session_id).map(Arc::clone)
        };
        let needs_launch = match slot.as_ref() {
            Some(slot) => slot.lock().await.is_none(),
            None => true,
        };
        if needs_launch {
            let probe = async {
                let selection = self
                    .store
                    .agent_runtime_selection(&binding.agent_id)
                    .await
                    .map_err(|_| unavailable())?
                    .ok_or_else(invalid)?;
                self.launch_once(
                    binding.clone(),
                    &ProviderTurnSettings::new(
                        selection.permission_mode,
                        selection.model,
                        selection.effort,
                    ),
                    ManagedLaunchMode::RecoverExistingForStop,
                    None,
                    None,
                )
                .await
            }
            .await
            .map_err(source_retaining_stop_probe_error)?;
            let launched = match probe {
                ManagedLaunchOutcome::Ready(launched) => *launched,
                ManagedLaunchOutcome::RetiredExact => {
                    let files = runtime_files(&self.configuration, binding)?;
                    let _ = self
                        .runtime_registry
                        .retire(&binding.interaction_session_id, &binding.runtime);
                    return Ok(StoppedManagedRuntime {
                        descriptor: None,
                        files,
                    });
                }
            };
            if !launched.same_runtime_authority(binding) {
                return Err(conflict());
            }
        }
        let slot = {
            let slots = self.slots.lock().await;
            Arc::clone(
                slots
                    .get(&binding.interaction_session_id)
                    .ok_or_else(unavailable)?,
            )
        };
        let mut active = slot.lock().await;
        let runtime = active.as_ref().ok_or_else(conflict)?;
        if !runtime.binding.same_runtime_authority(binding) {
            return Err(conflict());
        }
        if require_idle && !runtime.bridge.begin_idle_drain().await {
            runtime.bridge.cancel_drain();
            return Err(error(ErrorKind::SourceBusy, "managed_provider_source_busy"));
        }
        // Draining reconciles provider state. The first persisted conversation
        // can be published during that await; an admitted empty source may no
        // longer describe what would be stopped. Preserve it for fresh admission.
        let current = self
            .conversation_service
            .binding(&binding.interaction_session_id)
            .await;
        if !matches!(current, Ok(Some(ref current)) if current == binding) {
            runtime.bridge.cancel_drain();
            return Err(conflict());
        }
        if let Err(error) =
            stop_selected_source_exact(&self.configuration, &runtime.descriptor).await
        {
            runtime.bridge.cancel_drain();
            return Err(error);
        }
        let stopped = StoppedManagedRuntime {
            descriptor: Some(runtime.descriptor.clone()),
            files: runtime.files.clone(),
        };
        self.runtime_registry
            .retire(&binding.interaction_session_id, &binding.runtime)
            .map_err(|_| unavailable())?;
        active.take();
        drop(active);
        let mut slots = self.slots.lock().await;
        if slots
            .get(&binding.interaction_session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            slots.remove(&binding.interaction_session_id);
        }
        Ok(stopped)
    }

    async fn stop_current_binding_preserving_files(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<StoppedManagedRuntime, Error> {
        let slot = {
            let slots = self.slots.lock().await;
            slots.get(&binding.interaction_session_id).map(Arc::clone)
        };
        if let Some(slot) = slot.as_ref() {
            let mut active = slot.lock().await;
            if let Some(runtime) = active.as_ref() {
                if !runtime.binding.same_runtime_authority(binding) {
                    return Err(conflict());
                }
                stop_selected_source_exact(&self.configuration, &runtime.descriptor).await?;
                let stopped = StoppedManagedRuntime {
                    descriptor: Some(runtime.descriptor.clone()),
                    files: runtime.files.clone(),
                };
                self.runtime_registry
                    .retire(&binding.interaction_session_id, &binding.runtime)
                    .map_err(|_| unavailable())?;
                active.take();
                drop(active);
                self.remove_empty_slot(binding, slot).await;
                return Ok(stopped);
            }
        }

        let agent = self
            .store
            .agent(&binding.agent_id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(invalid)?;
        let files = runtime_files(&self.configuration, binding)?;
        let descriptor = match claim_managed_connection_driver_for_stop(
            &self.configuration,
            agent.workspace_id.as_str(),
            &files,
        )
        .await
        {
            ManagedConnectionDriverStopTargetOutcome::Existing(descriptor) => {
                stop_selected_source_exact(&self.configuration, &descriptor).await?;
                Some(*descriptor)
            }
            ManagedConnectionDriverStopTargetOutcome::NotFound
            | ManagedConnectionDriverStopTargetOutcome::Terminal => None,
            ManagedConnectionDriverStopTargetOutcome::RetrySame => return Err(stop_failed()),
        };
        self.runtime_registry
            .retire(&binding.interaction_session_id, &binding.runtime)
            .map_err(|_| unavailable())?;
        if let Some(slot) = slot.as_ref() {
            self.remove_empty_slot(binding, slot).await;
        }
        Ok(StoppedManagedRuntime { descriptor, files })
    }

    async fn remove_empty_slot(&self, binding: &AgentInteractionBindingV1, slot: &RuntimeSlot) {
        let mut slots = self.slots.lock().await;
        if slots
            .get(&binding.interaction_session_id)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
            && slot.try_lock().is_ok_and(|active| active.is_none())
        {
            slots.remove(&binding.interaction_session_id);
        }
    }
}

fn presentation_predecessor(
    descriptor: &SessionDescriptor,
) -> Result<PresentationCheckpointPredecessor, Error> {
    let channel_epoch = descriptor
        .channel_epoch
        .parse::<u64>()
        .map_err(|_| conflict())?;
    PresentationCheckpointPredecessor::new(
        &descriptor.session_id,
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        channel_epoch,
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
    )
    .map_err(|_| conflict())
}

pub(crate) fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn now_ms() -> Result<i64, Error> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| unavailable())?;
    i64::try_from(duration.as_millis()).map_err(|_| unavailable())
}

fn map_credential_error(source: ProviderCredentialProfileErrorV1) -> Error {
    match source {
        ProviderCredentialProfileErrorV1::StaleGeneration => error(
            ErrorKind::CredentialStale,
            "managed_provider_credential_stale",
        ),
        ProviderCredentialProfileErrorV1::Unavailable => error(
            ErrorKind::CredentialUnavailable,
            "managed_provider_credential_unavailable",
        ),
        _ => unavailable(),
    }
}

fn transition_failed_structured_binding<'a>(
    provider_id: &str,
    transition: &'a AgentRuntimeTransitionRecordV1,
) -> Result<Option<&'a AgentInteractionBindingV1>, Error> {
    transition.validate().map_err(|_| conflict())?;
    let authority = transition
        .replacement_authority
        .as_ref()
        .map(|authority| &authority.0);
    match authority {
        Some(AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding })
            if binding.agent_id == transition.intent.source.agent_id
                && binding.provider_id.as_str() == provider_id
                && transition
                    .intent
                    .provider_conversation_ref
                    .as_option()
                    .is_none_or(|expected| {
                        binding.provider_conversation_ref.as_deref() == Some(expected)
                    }) =>
        {
            Ok(Some(binding))
        }
        Some(AgentRuntimeBindingAuthorityV1::NativeCli { .. }) | None => Ok(None),
        Some(_) => Err(conflict()),
    }
}

fn replacement_failure_is_quiescent(error: &Error) -> bool {
    matches!(
        error.kind,
        ErrorKind::RequestInvalid
            | ErrorKind::CredentialUnavailable
            | ErrorKind::CredentialStale
            | ErrorKind::RuntimeConflict
            | ErrorKind::ExplicitRecoveryRequired
    )
}

pub(crate) fn error(kind: ErrorKind, code: &'static str) -> Error {
    Error::new(kind, code)
}

fn invalid() -> Error {
    error(
        ErrorKind::RequestInvalid,
        "managed_provider_request_invalid",
    )
}

pub(crate) fn unavailable() -> Error {
    error(
        ErrorKind::RuntimeUnavailable,
        "managed_provider_unavailable",
    )
}

pub(crate) fn conflict() -> Error {
    error(
        ErrorKind::RuntimeConflict,
        "managed_provider_runtime_conflict",
    )
}

fn source_busy() -> Error {
    error(ErrorKind::SourceBusy, "managed_provider_source_busy")
}

fn source_retaining_stop_probe_error(error: Error) -> Error {
    if error.retains_source() {
        error
    } else {
        source_busy()
    }
}

pub(crate) fn launch_failed() -> Error {
    error(ErrorKind::LaunchFailed, "managed_provider_launch_failed")
}

fn recovery_pending() -> Error {
    error(
        ErrorKind::RuntimeUnavailable,
        "managed_provider_recovery_pending",
    )
}

fn recovery_required() -> Error {
    error(
        ErrorKind::ExplicitRecoveryRequired,
        "managed_provider_recovery_required",
    )
}

fn stop_failed() -> Error {
    error(ErrorKind::StopFailed, "managed_provider_stop_failed")
}

#[cfg(test)]
#[path = "managed_structured_runtime/tests.rs"]
mod tests;

#[cfg(test)]
mod allocation_tests;

#[cfg(test)]
mod conformance_support;
#[cfg(test)]
mod opencode_tests;
#[cfg(test)]
mod pi_tests;
