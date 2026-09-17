use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use dure_app_sqlite::SqliteDomainStore;

use super::*;
use crate::managed_structured_runtime::{ManagedProviderExecutable, ManagedProviderKind};

pub(super) struct ClaudeStructuredRuntimePreparation<'a> {
    pub options: &'a ClaudeStructuredRuntimeOptions,
    pub backend_root: &'a backend_runtime_root::BackendRuntimeRoot,
    pub descriptor: &'a ServiceDescriptor,
    pub hmux_identity: &'a HmuxToolchainIdentity,
    pub credential_profiles:
        Arc<provider_credential_profile::ProviderCredentialProfileRegistry<SqliteDomainStore>>,
    pub store: Arc<SqliteDomainStore>,
    pub conversation_service: Arc<agent_conversation::AgentConversationService<SqliteDomainStore>>,
    pub runtime_registry: Arc<agent_conversation_api::AgentConversationRuntimeRegistry>,
}

pub(super) fn prepare_claude_structured_runtime(
    preparation: ClaudeStructuredRuntimePreparation<'_>,
) -> Result<
    Arc<claude_structured_runtime::ClaudeStructuredRuntimeManager<SqliteDomainStore>>,
    ControlPlaneError,
> {
    let ClaudeStructuredRuntimePreparation {
        options,
        backend_root,
        descriptor,
        hmux_identity,
        credential_profiles,
        store,
        conversation_service,
        runtime_registry,
    } = preparation;
    let structured_root = ensure_owner_subdirectory(backend_root.durable(), "claude-structured")?;
    let host_state_root = ensure_owner_subdirectory(&structured_root, "host")?;
    let relay_state_root = ensure_owner_subdirectory(&structured_root, "relays")?;
    let host_address_root =
        backend_root.address_for(&backend_root.durable().join("claude-structured/host"))?;
    let relay_address_root =
        backend_root.address_for(&backend_root.durable().join("claude-structured/relays"))?;
    let environment = capture_unicode_environment()?;
    let host_environment = environment
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "HOME" | "LANG" | "PATH" | "SSL_CERT_DIR" | "SSL_CERT_FILE" | "TMPDIR" | "TZ"
            ) || key.starts_with("LC_")
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let host_configuration =
        claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration::new_with_address_root(
            &options.node_bin,
            &options.host_entrypoint,
            host_state_root,
            host_address_root,
            &options.runtime_root,
            format!("host-{}", descriptor.generation),
            host_environment,
        )
        .map_err(|error| ControlPlaneError::Message(error.to_string()))?;
    let host = Arc::new(
        claude_conversation_host::ClaudeConversationHost::new(
            host_configuration,
            format!("client-{}", descriptor.generation),
            Arc::clone(&conversation_service),
            runtime_registry,
        )
        .map_err(|error| ControlPlaneError::Message(error.to_string()))?,
    );
    let runtime_configuration =
        claude_structured_runtime::ClaudeStructuredRuntimeConfiguration::new_with_address_root(
            &descriptor.generation,
            &hmux_identity.runtime_executable_path,
            &hmux_identity.discovery_root,
            &options.relay_bin,
            relay_state_root,
            relay_address_root,
            environment,
        )
        .map_err(|error| ControlPlaneError::Message(error.code().into()))?;
    Ok(Arc::new(
        claude_structured_runtime::ClaudeStructuredRuntimeManager::new(
            runtime_configuration,
            credential_profiles,
            conversation_service,
            host,
            store,
        ),
    ))
}

pub(super) struct ManagedStructuredRuntimePreparation<'a> {
    pub provider: ManagedProviderKind,
    pub backend_root: &'a backend_runtime_root::BackendRuntimeRoot,
    pub descriptor: &'a ServiceDescriptor,
    pub provider_launcher_executable: &'a Path,
    pub hmux_identity: &'a HmuxToolchainIdentity,
    pub credential_profiles:
        Arc<provider_credential_profile::ProviderCredentialProfileRegistry<SqliteDomainStore>>,
    pub store: Arc<SqliteDomainStore>,
    pub conversation_service: Arc<agent_conversation::AgentConversationService<SqliteDomainStore>>,
    pub runtime_registry: Arc<agent_conversation_api::AgentConversationRuntimeRegistry>,
}

pub(super) fn prepare_managed_structured_runtime(
    preparation: ManagedStructuredRuntimePreparation<'_>,
) -> Result<
    Arc<managed_structured_runtime::ManagedStructuredRuntimeManager<SqliteDomainStore>>,
    ControlPlaneError,
> {
    let ManagedStructuredRuntimePreparation {
        provider,
        backend_root,
        descriptor,
        provider_launcher_executable,
        hmux_identity,
        credential_profiles,
        store,
        conversation_service,
        runtime_registry,
    } = preparation;
    let executable = resolve_provider_executable(provider.id()).ok();
    let directory = format!("{}-structured", provider.id());
    let state_root = ensure_owner_subdirectory(backend_root.durable(), &directory)?;
    let address_root = backend_root.address_for(&backend_root.durable().join(&directory))?;
    let configuration = managed_structured_runtime::ManagedStructuredRuntimeConfiguration::new(
        &descriptor.generation,
        ManagedProviderExecutable::new(provider, executable),
        provider_launcher_executable,
        &hmux_identity.runtime_executable_path,
        &hmux_identity.discovery_root,
        state_root,
        address_root,
    )
    .map_err(|error| ControlPlaneError::Message(error.code))?;
    Ok(Arc::new(
        managed_structured_runtime::ManagedStructuredRuntimeManager::new(
            configuration,
            credential_profiles,
            conversation_service,
            runtime_registry,
            store,
        ),
    ))
}

fn capture_unicode_environment() -> Result<BTreeMap<String, String>, ControlPlaneError> {
    std::env::vars_os()
        .map(|(key, value)| {
            let key = key.into_string().map_err(|_| {
                ControlPlaneError::Invalid("Claude structured runtime environment is invalid")
            })?;
            let value = value.into_string().map_err(|_| {
                ControlPlaneError::Invalid("Claude structured runtime environment is invalid")
            })?;
            Ok((key, value))
        })
        .collect()
}
