use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentInteractionBindingV1,
    AgentInteractionProfileV1, AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeReplacementAuthorityV1, AgentRuntimeReplacementV1,
    AgentRuntimeSelectionV1, AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1,
    AgentRuntimeTransitionStore, AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1,
    AgentTimelineStore, DomainStore, DomainStoreErrorV1, OperationIdV1,
    ProviderCredentialProfileStore, ProviderIdV1, ProviderPermissionModeV1, SessionBindingRecordV1,
};
use hmux_client::{
    LocalProcessGenerationStatus, MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    ManagedCreateAdvanceResolution, ManagedCreateChainResolution, ManagedCreateFailureDisposition,
    ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopOutcome, ManagedStopRequest, PermissionMode,
    ProviderConversationIdentitySeed, ProviderStateEnvironment, SessionDescriptor,
    probe_local_process_generation,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio::time::{Duration, Instant};

use crate::agent_conversation::{AgentConversationErrorV1, AgentConversationService};
use crate::claude_conversation_host::{
    ClaudeConversationAttachmentV1, ClaudeConversationHost, ClaudeConversationHostErrorV1,
    ClaudeConversationProcessBindingV1,
};
use crate::claude_sdk_host_client::{ClaudeDch1HostIdentity, ClaudeDch1QueryIdentity};
use crate::provider_credential_profile::{
    ProviderCredentialProfileErrorV1, ProviderCredentialProfileRegistry,
};
use crate::structured_provider_runtime::{
    StructuredProviderTargetQuiescenceV1, replacement_provider_conversation_ref,
    replacement_target_conversation_matches, transition_owns_structured_source,
};

#[cfg(test)]
mod dormant_recovery_tests;
mod journal;
#[cfg(test)]
mod managed_create_recovery_tests;
mod open;
#[cfg(test)]
mod recovery_tests;
mod retirement;

pub(crate) use open::ClaudeConversationOpenBodyV1;
pub use open::{ClaudeStructuredOpenReceiptV1, ClaudeStructuredOpenRequestV1};

use self::journal::{
    ClaudeManagedCreateIdentityV1, ClaudeRuntimeLaunchJournalV1, ClaudeRuntimeLaunchStateV1,
    read_journal, write_journal,
};

const RELAY_READY_TIMEOUT: Duration = Duration::from_secs(5);
const EXACT_STOP_RECONCILE_TIMEOUT: Duration = Duration::from_secs(5);
const EXACT_STOP_RECONCILE_INTERVAL: Duration = Duration::from_millis(25);
const CLAUDE_PROVIDER_ID: &str = "claude";
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClaudeConversationLaunchBodyV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClaudeConversationStopBodyV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime_generation: String,
}

#[derive(Clone, Debug)]
pub struct ClaudeStructuredLaunchRequestV1 {
    pub interaction_session_id: AgentInteractionSessionIdV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ClaudeStructuredLaunchOptionsV1 {
    permission_mode: ProviderPermissionModeV1,
    model: Option<AgentSpawnModelSelectionV1>,
    effort: Option<AgentSpawnEffortSelectionV1>,
}

impl Default for ClaudeStructuredLaunchOptionsV1 {
    fn default() -> Self {
        Self {
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        }
    }
}

impl ClaudeStructuredLaunchOptionsV1 {
    fn from_open(request: &ClaudeStructuredOpenRequestV1) -> Self {
        Self {
            permission_mode: request.permission_mode.clone(),
            model: request.model.clone(),
            effort: request.effort.clone(),
        }
    }

    fn from_selection(selection: &AgentRuntimeSelectionV1) -> Self {
        Self {
            permission_mode: selection.permission_mode.clone(),
            model: selection.model.clone(),
            effort: selection.effort.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStructuredLaunchReceiptV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime_generation: String,
    pub query_epoch: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ClaudeStructuredRecordedFailureV1 {
    HostAttach {
        reason: String,
        /// Why the attach failed, in the host's own words (its stderr tail).
        /// Optional so records written before this field stay readable, and
        /// skipped when absent so a retirement does not invent evidence.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    RelayReadiness,
    ManagedCreateNormalizationRequired,
    ManagedCreateRetiredExact,
    ManagedCreateRejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaudeStructuredRuntimeErrorV1 {
    RequestInvalid,
    RuntimeUnavailable,
    RuntimeLaunchRequired,
    CredentialUnavailable,
    CredentialStale,
    SourceBusy,
    RuntimeConflict,
    RelayLaunchFailed,
    ManagedCreateRecoveryPending,
    ManagedCreateRecoveryRequired,
    RelayReadinessFailed,
    HostAttachFailed,
    HostAttachUncertain,
    HostAttachRecoveryRequired,
    RelayReadinessRecoveryRequired,
    JournalFailed,
    StopFailed,
}

pub(crate) struct ClaudeStructuredReplacementFailureV1 {
    pub(crate) error: ClaudeStructuredRuntimeErrorV1,
    pub(crate) target_quiescence: StructuredProviderTargetQuiescenceV1,
    /// Why it failed, in the failing layer's own words — the SDK host's stderr
    /// tail, say. The error enum is a Copy code shared by three causes
    /// (HostAttachFailed covers attach, uncertain, and recovery-required), so
    /// the evidence has to ride beside it or it is lost at the first `?`.
    pub(crate) detail: Option<String>,
}

impl From<ClaudeStructuredRuntimeErrorV1> for ClaudeStructuredReplacementFailureV1 {
    /// A bare error arrived without evidence — nothing to carry.
    fn from(error: ClaudeStructuredRuntimeErrorV1) -> Self {
        let target_quiescence = match error {
            ClaudeStructuredRuntimeErrorV1::RequestInvalid
            | ClaudeStructuredRuntimeErrorV1::CredentialUnavailable
            | ClaudeStructuredRuntimeErrorV1::CredentialStale
            | ClaudeStructuredRuntimeErrorV1::SourceBusy => {
                StructuredProviderTargetQuiescenceV1::NoTarget
            }
            _ => StructuredProviderTargetQuiescenceV1::Unknown,
        };
        Self {
            error,
            target_quiescence,
            detail: None,
        }
    }
}

impl ClaudeStructuredRuntimeErrorV1 {
    pub fn code(&self) -> &'static str {
        match self {
            Self::RequestInvalid => "claude_conversation_request_invalid",
            Self::RuntimeUnavailable => "claude_conversation_runtime_unavailable",
            Self::RuntimeLaunchRequired => "claude_conversation_runtime_unavailable",
            Self::CredentialUnavailable => "claude_conversation_credential_unavailable",
            Self::CredentialStale => "claude_conversation_credential_stale",
            Self::SourceBusy => "claude_conversation_source_busy",
            Self::RuntimeConflict => "claude_conversation_runtime_conflict",
            Self::RelayLaunchFailed => "claude_conversation_relay_launch_failed",
            Self::ManagedCreateRecoveryPending => {
                "claude_conversation_managed_create_recovery_pending"
            }
            Self::ManagedCreateRecoveryRequired => {
                "claude_conversation_managed_create_recovery_required"
            }
            Self::RelayReadinessFailed => "claude_conversation_relay_readiness_failed",
            Self::HostAttachFailed => "claude_conversation_host_attach_failed",
            Self::HostAttachUncertain => "claude_conversation_host_attach_failed",
            Self::HostAttachRecoveryRequired => "claude_conversation_host_attach_failed",
            Self::RelayReadinessRecoveryRequired => "claude_conversation_relay_readiness_failed",
            Self::JournalFailed => "claude_conversation_journal_failed",
            Self::StopFailed => "claude_conversation_stop_failed",
        }
    }
}

#[derive(Clone)]
pub struct ClaudeStructuredRuntimeConfiguration {
    pub backend_generation: String,
    pub hmux_runtime: PathBuf,
    pub discovery_root: PathBuf,
    pub relay_executable: PathBuf,
    pub state_root: PathBuf,
    address_root: PathBuf,
    pub environment: BTreeMap<String, String>,
}

impl fmt::Debug for ClaudeStructuredRuntimeConfiguration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeStructuredRuntimeConfiguration")
            .field("backend_generation", &self.backend_generation)
            .field("hmux_runtime", &self.hmux_runtime)
            .field("discovery_root", &self.discovery_root)
            .field("relay_executable", &self.relay_executable)
            .field("state_root", &self.state_root)
            .field("address_root", &self.address_root)
            .field(
                "environment_keys",
                &self.environment.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl ClaudeStructuredRuntimeConfiguration {
    pub fn new(
        backend_generation: impl Into<String>,
        hmux_runtime: impl Into<PathBuf>,
        discovery_root: impl Into<PathBuf>,
        relay_executable: impl Into<PathBuf>,
        state_root: impl Into<PathBuf>,
        environment: BTreeMap<String, String>,
    ) -> Result<Self, ClaudeStructuredRuntimeErrorV1> {
        let state_root = state_root.into();
        let mut configuration = Self::new_with_address_root(
            backend_generation,
            hmux_runtime,
            discovery_root,
            relay_executable,
            state_root.clone(),
            state_root,
            environment,
        )?;
        configuration.address_root = configuration.state_root.clone();
        Ok(configuration)
    }

    pub(crate) fn new_with_address_root(
        backend_generation: impl Into<String>,
        hmux_runtime: impl Into<PathBuf>,
        discovery_root: impl Into<PathBuf>,
        relay_executable: impl Into<PathBuf>,
        state_root: impl Into<PathBuf>,
        address_root: impl Into<PathBuf>,
        environment: BTreeMap<String, String>,
    ) -> Result<Self, ClaudeStructuredRuntimeErrorV1> {
        let backend_generation = backend_generation.into();
        if !safe_token(&backend_generation) {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable);
        }
        let hmux_runtime = exact_executable(&hmux_runtime.into())?;
        let relay_executable = exact_executable(&relay_executable.into())?;
        let discovery_root = exact_owner_directory(&discovery_root.into())?;
        let state_root = exact_owner_directory(&state_root.into())?;
        let address_root = address_root.into();
        if !address_root.is_absolute() || address_root.to_str().is_none() {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable);
        }
        validate_environment(&environment)?;
        Ok(Self {
            backend_generation,
            hmux_runtime,
            discovery_root,
            relay_executable,
            state_root,
            address_root,
            environment,
        })
    }
}

struct ActiveClaudeRuntime {
    binding: AgentInteractionBindingV1,
    cwd: PathBuf,
    launch_options: ClaudeStructuredLaunchOptionsV1,
    host_identity: ClaudeDch1HostIdentity,
    query_identity: ClaudeDch1QueryIdentity,
    receipt: ClaudeStructuredLaunchReceiptV1,
}

struct ClaudeRuntimeFiles {
    capability_file: PathBuf,
    create_idempotency_key: String,
    endpoint: PathBuf,
    relay_id: String,
    relay_session_id: String,
    runtime_directory: PathBuf,
}

struct PreparedClaudeRuntime {
    capability: Option<String>,
    files: ClaudeRuntimeFiles,
    journal: ClaudeRuntimeLaunchJournalV1,
}

enum ManagedRelayCreateOutcome {
    Created {
        descriptor: Box<SessionDescriptor>,
        identity: ClaudeManagedCreateIdentityV1,
    },
    Rejected,
    RecoveryPending,
}

enum ManagedRelayIdentityOutcome {
    Existing {
        descriptor: Box<SessionDescriptor>,
        identity: ClaudeManagedCreateIdentityV1,
    },
    NotFound,
    Terminal,
    RecoveryPending,
}

struct ClaudeRuntimeContext {
    binding: AgentInteractionBindingV1,
    workspace_id: String,
    cwd: PathBuf,
}

#[derive(Clone, Copy)]
enum ClaudeFailedTargetDisposition {
    Launch,
    Stop,
}

type ClaudeRuntimeSlot = Arc<Mutex<Option<ActiveClaudeRuntime>>>;

pub struct ClaudeStructuredRuntimeManager<S>
where
    S: AgentTimelineStore
        + AgentRuntimeTransitionStore
        + DomainStore
        + ProviderCredentialProfileStore
        + 'static,
{
    slots: Mutex<BTreeMap<AgentInteractionSessionIdV1, ClaudeRuntimeSlot>>,
    configuration: ClaudeStructuredRuntimeConfiguration,
    conversation_service: Arc<AgentConversationService<S>>,
    credential_profiles: Arc<ProviderCredentialProfileRegistry<S>>,
    host: Arc<ClaudeConversationHost<S>>,
    store: Arc<S>,
}

impl<S> ClaudeStructuredRuntimeManager<S>
where
    S: AgentTimelineStore
        + AgentRuntimeTransitionStore
        + DomainStore
        + ProviderCredentialProfileStore
        + 'static,
{
    pub fn new(
        configuration: ClaudeStructuredRuntimeConfiguration,
        credential_profiles: Arc<ProviderCredentialProfileRegistry<S>>,
        conversation_service: Arc<AgentConversationService<S>>,
        host: Arc<ClaudeConversationHost<S>>,
        store: Arc<S>,
    ) -> Self {
        Self {
            slots: Mutex::new(BTreeMap::new()),
            configuration,
            conversation_service,
            credential_profiles,
            host,
            store,
        }
    }

    async fn runtime_context(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
    ) -> Result<Option<ClaudeRuntimeContext>, ClaudeStructuredRuntimeErrorV1> {
        let Some(binding) = self
            .conversation_service
            .binding(interaction_session_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
        else {
            return Ok(None);
        };
        binding
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        if binding.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1
            || binding.provider_id.as_str() != CLAUDE_PROVIDER_ID
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid);
        }
        let agent = self
            .store
            .agent(&binding.agent_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        if agent.agent_id != binding.agent_id || agent.provider_id != binding.provider_id {
            return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid);
        }
        let workspace = self
            .store
            .workspace(&agent.workspace_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        Ok(Some(ClaudeRuntimeContext {
            binding,
            workspace_id: agent.workspace_id.as_str().to_owned(),
            cwd: exact_directory(Path::new(&workspace.root_path))?,
        }))
    }

    async fn prepare_launch(
        &self,
        binding: AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
    ) -> Result<(AgentInteractionBindingV1, PreparedClaudeRuntime), ClaudeStructuredRuntimeErrorV1>
    {
        let Some(prepared) = self.read_runtime(&binding, workspace_id, cwd)? else {
            let prepared = self.create_runtime(&binding, workspace_id, cwd, None)?;
            return Ok((binding, prepared));
        };
        let mut prepared = prepared;
        let resuming_stop_cleanup =
            prepared.journal.state() == ClaudeRuntimeLaunchStateV1::StopCleanupPending;
        let resuming_retired_direct_stop = prepared.journal.state()
            == ClaudeRuntimeLaunchStateV1::QueryRetired
            && prepared
                .journal
                .retirement_authority()
                .is_some_and(|authority| authority.allowed_target.is_none());
        if resuming_retired_direct_stop {
            self.begin_prepared_stop_cleanup(workspace_id, &mut prepared)
                .await?;
        }
        if resuming_stop_cleanup
            || prepared.journal.state() == ClaudeRuntimeLaunchStateV1::Stopped
            || resuming_retired_direct_stop
        {
            self.complete_stop_cleanup(
                cwd,
                &prepared.files.runtime_directory,
                &mut prepared.journal,
            )
            .await?;
            if resuming_stop_cleanup || resuming_retired_direct_stop {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeLaunchRequired);
            }
        }
        if matches!(
            prepared.journal.state(),
            ClaudeRuntimeLaunchStateV1::FailureCleanupPending | ClaudeRuntimeLaunchStateV1::Failed
        ) {
            prepared
                .journal
                .failure()
                .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
            if prepared.journal.state() == ClaudeRuntimeLaunchStateV1::FailureCleanupPending {
                self.complete_failed_runtime_cleanup(cwd, &mut prepared)
                    .await?;
            }
            return self
                .replace_runtime(binding, workspace_id, cwd, prepared)
                .await;
        }
        if prepared.journal.state() == ClaudeRuntimeLaunchStateV1::Prepared
            && prepared.capability.is_none()
        {
            self.start_prepared_relay(&binding, workspace_id, cwd, &mut prepared)
                .await?;
        }
        let cursor = self
            .conversation_service
            .provider_cursor(&binding.interaction_session_id, &binding.runtime)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        let adoptable = match prepared.journal.state() {
            ClaudeRuntimeLaunchStateV1::Prepared => {
                cursor.committed_through_sequence == 0 && prepared.capability.is_some()
            }
            ClaudeRuntimeLaunchStateV1::RelayReady => prepared.capability.is_some(),
            ClaudeRuntimeLaunchStateV1::Attached => {
                prepared.capability.is_some()
                    && wait_for_relay(&prepared.files.endpoint).await.is_ok()
            }
            ClaudeRuntimeLaunchStateV1::QueryRetired
            | ClaudeRuntimeLaunchStateV1::StopCleanupPending
            | ClaudeRuntimeLaunchStateV1::FailureCleanupPending
            | ClaudeRuntimeLaunchStateV1::Failed
            | ClaudeRuntimeLaunchStateV1::Stopped => false,
        };
        if adoptable {
            return Ok((binding, prepared));
        }
        if self.is_active_transition_source(&binding).await? {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        self.replace_runtime(binding, workspace_id, cwd, prepared)
            .await
    }

    async fn is_active_transition_source(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<bool, ClaudeStructuredRuntimeErrorV1> {
        let transition = self
            .store
            .active_agent_runtime_transition(&binding.agent_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        Ok(transition
            .is_some_and(|transition| transition_owns_structured_source(&transition, binding)))
    }

    async fn replace_runtime(
        &self,
        binding: AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        mut source: PreparedClaudeRuntime,
    ) -> Result<(AgentInteractionBindingV1, PreparedClaudeRuntime), ClaudeStructuredRuntimeErrorV1>
    {
        let target_runtime = replacement_runtime(
            &binding.interaction_session_id,
            &binding.runtime,
            &self.configuration.backend_generation,
        );
        let replaced_at_ms = now_ms()?;
        let target_revision = binding
            .binding_revision
            .checked_add(1)
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        let mut expected = binding.clone();
        expected.runtime = target_runtime.clone();
        expected.binding_revision = target_revision;
        expected.updated_at_ms = replaced_at_ms;
        let target_identity = runtime_query_identity(&self.configuration, &expected)?;
        if matches!(
            source.journal.state(),
            ClaudeRuntimeLaunchStateV1::Attached | ClaudeRuntimeLaunchStateV1::QueryRetired
        ) {
            let source_identity = source.journal.query_identity();
            self.retire_query_before_stop(
                &binding,
                &source_identity,
                &source.files.runtime_directory,
                &mut source.journal,
                false,
                Some(&target_identity),
            )
            .await?;
            if source
                .journal
                .retirement_authority()
                .and_then(|authority| authority.allowed_target.as_ref())
                != Some(&target_identity)
            {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
        }
        if !matches!(
            source.journal.state(),
            ClaudeRuntimeLaunchStateV1::Failed | ClaudeRuntimeLaunchStateV1::Stopped
        ) && let Some(descriptor) = source.journal.descriptor()
        {
            stop_exact_or_confirm_absent(
                &self.configuration,
                cwd,
                descriptor,
                "claude-chat-recovery-stop",
            )
            .await?;
        }
        source.journal.stopped();
        write_journal(&source.files.runtime_directory, &source.journal)?;
        let target = match self.read_runtime(&expected, workspace_id, cwd)? {
            Some(target)
                if source.journal.accepts_existing_target_predecessor(
                    &target_identity,
                    target.journal.provider_predecessor(),
                ) && target.journal.state() == ClaudeRuntimeLaunchStateV1::Prepared =>
            {
                target
            }
            Some(_) => return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
            None => self.create_runtime(
                &expected,
                workspace_id,
                cwd,
                source.journal.provider_predecessor_for_new_target()?,
            )?,
        };
        let replacement = AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding.interaction_session_id.clone(),
            expected_binding_revision: binding.binding_revision,
            source: binding.runtime.clone(),
            source_execution_profile: binding.execution_profile.clone(),
            target: target_runtime,
            target_execution_profile: binding.execution_profile.clone(),
            provider_conversation_ref: binding.provider_conversation_ref.clone(),
            replaced_at_ms,
        };
        let replaced = self
            .conversation_service
            .replace_runtime(&replacement)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        if !expected.same_runtime_authority(&replaced)
            || expected.binding_revision != replaced.binding_revision
            || expected.provider_conversation_ref != replaced.provider_conversation_ref
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        Ok((replaced, target))
    }

    async fn start_prepared_relay(
        &self,
        binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        prepared: &mut PreparedClaudeRuntime,
    ) -> Result<SessionDescriptor, ClaudeStructuredRuntimeErrorV1> {
        match create_managed_relay(
            &self.configuration,
            binding,
            workspace_id,
            cwd,
            &prepared.files,
            &prepared.journal,
        )
        .await?
        {
            ManagedRelayCreateOutcome::Created {
                descriptor,
                identity,
            } => {
                let descriptor = *descriptor;
                let mut relay_ready = prepared.journal.clone();
                relay_ready.relay_ready_with_managed_identity(descriptor.clone(), identity);
                if write_journal(&prepared.files.runtime_directory, &relay_ready).is_err() {
                    // The Hmux successor edge is already immutable. Preserve
                    // that exact target so replaying the source advance can
                    // return it and retry this journal checkpoint.
                    return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
                }
                prepared.journal = relay_ready;
                Ok(descriptor)
            }
            ManagedRelayCreateOutcome::Rejected => {
                self.record_managed_create_failure(
                    cwd,
                    prepared,
                    ClaudeStructuredRecordedFailureV1::ManagedCreateRejected,
                )
                .await?;
                Err(ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryRequired)
            }
            ManagedRelayCreateOutcome::RecoveryPending => {
                Err(ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryPending)
            }
        }
    }

    async fn record_managed_create_failure(
        &self,
        cwd: &Path,
        source: &mut PreparedClaudeRuntime,
        failure: ClaudeStructuredRecordedFailureV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        self.publish_failure(source, failure)?;
        self.complete_failed_runtime_cleanup(cwd, source).await?;
        Ok(())
    }

    fn publish_failure(
        &self,
        prepared: &mut PreparedClaudeRuntime,
        failure: ClaudeStructuredRecordedFailureV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        // The pending state is published before cleanup so a restart can only
        // reconcile this exact generation; it cannot create or attach again.
        prepared.journal.failure_cleanup_pending(failure);
        write_journal(&prepared.files.runtime_directory, &prepared.journal)
    }

    async fn complete_failed_runtime_cleanup(
        &self,
        cwd: &Path,
        prepared: &mut PreparedClaudeRuntime,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        self.release_failed_target_predecessor(prepared).await?;
        if let Some(descriptor) = prepared.journal.descriptor() {
            stop_exact(
                &self.configuration,
                cwd,
                descriptor,
                "claude-chat-failed-runtime-stop",
            )
            .await?;
        }
        prepared.journal.failure_cleanup_completed();
        write_journal(&prepared.files.runtime_directory, &prepared.journal)
    }

    async fn complete_stop_cleanup(
        &self,
        cwd: &Path,
        runtime_directory: &Path,
        journal: &mut ClaudeRuntimeLaunchJournalV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        match journal.state() {
            ClaudeRuntimeLaunchStateV1::StopCleanupPending => {
                if let Some(descriptor) = journal.descriptor().cloned() {
                    stop_exact_or_confirm_absent(
                        &self.configuration,
                        cwd,
                        &descriptor,
                        "claude-chat-stop",
                    )
                    .await?;
                }
            }
            // Older builds could publish Stopped before releasing predecessor
            // authority. Repair that terminal journal without repeating stop.
            ClaudeRuntimeLaunchStateV1::Stopped => {}
            _ => return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
        }
        if journal
            .retirement_authority()
            .is_some_and(|authority| authority.allowed_target.is_none())
        {
            self.release_terminal_authority(runtime_directory, journal)
                .await?;
        }
        if journal.provider_predecessor().is_some() {
            self.release_terminal_predecessor(journal).await?;
            journal.consume_provider_predecessor();
        }
        journal.stopped();
        write_journal(runtime_directory, journal)
    }

    async fn begin_prepared_stop_cleanup(
        &self,
        workspace_id: &str,
        prepared: &mut PreparedClaudeRuntime,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        if matches!(
            prepared.journal.state(),
            ClaudeRuntimeLaunchStateV1::StopCleanupPending | ClaudeRuntimeLaunchStateV1::Stopped
        ) {
            return Ok(());
        }
        let (descriptor, managed_create_identity) = match prepared.journal.state() {
            ClaudeRuntimeLaunchStateV1::Prepared => {
                match resolve_managed_relay_for_stop(
                    &self.configuration,
                    workspace_id,
                    &prepared.files,
                    &prepared.journal,
                )
                .await
                {
                    ManagedRelayIdentityOutcome::Existing {
                        descriptor,
                        identity,
                    } => (Some(*descriptor), Some(identity)),
                    ManagedRelayIdentityOutcome::NotFound
                    | ManagedRelayIdentityOutcome::Terminal => (None, None),
                    ManagedRelayIdentityOutcome::RecoveryPending => {
                        return Err(ClaudeStructuredRuntimeErrorV1::StopFailed);
                    }
                }
            }
            ClaudeRuntimeLaunchStateV1::RelayReady
            | ClaudeRuntimeLaunchStateV1::Attached
            | ClaudeRuntimeLaunchStateV1::QueryRetired => (
                Some(
                    prepared
                        .journal
                        .descriptor()
                        .cloned()
                        .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?,
                ),
                None,
            ),
            ClaudeRuntimeLaunchStateV1::FailureCleanupPending
            | ClaudeRuntimeLaunchStateV1::Failed => (prepared.journal.descriptor().cloned(), None),
            ClaudeRuntimeLaunchStateV1::StopCleanupPending
            | ClaudeRuntimeLaunchStateV1::Stopped => unreachable!("terminal state returned above"),
        };
        if let Some(identity) = managed_create_identity {
            prepared.journal.stop_cleanup_pending_with_managed_identity(
                descriptor.ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?,
                identity,
            );
        } else {
            prepared.journal.stop_cleanup_pending(descriptor);
        }
        write_journal(&prepared.files.runtime_directory, &prepared.journal)
    }

    fn read_runtime(
        &self,
        binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
    ) -> Result<Option<PreparedClaudeRuntime>, ClaudeStructuredRuntimeErrorV1> {
        let files = runtime_files(&self.configuration, binding)?;
        let metadata = match fs::symlink_metadata(&files.runtime_directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed),
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
        }
        let journal = read_journal(&files.runtime_directory)?;
        if !journal.matches(
            binding,
            workspace_id,
            cwd,
            &files.relay_id,
            &files.relay_session_id,
            &files.create_idempotency_key,
        ) {
            return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
        }
        let capability = read_owner_capability(&files.capability_file)?;
        Ok(Some(PreparedClaudeRuntime {
            capability,
            files,
            journal,
        }))
    }

    fn create_runtime(
        &self,
        binding: &AgentInteractionBindingV1,
        workspace_id: &str,
        cwd: &Path,
        replaces: Option<ClaudeDch1QueryIdentity>,
    ) -> Result<PreparedClaudeRuntime, ClaudeStructuredRuntimeErrorV1> {
        let files = runtime_files(&self.configuration, binding)?;
        let capability = random_capability()?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&files.runtime_directory)
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        write_owner_file(&files.capability_file, capability.as_bytes())?;
        let journal = ClaudeRuntimeLaunchJournalV1::prepared(
            binding,
            workspace_id,
            cwd,
            &files.relay_id,
            &files.relay_session_id,
            replaces,
        );
        write_journal(&files.runtime_directory, &journal)?;
        Ok(PreparedClaudeRuntime {
            capability: Some(capability),
            files,
            journal,
        })
    }

    pub async fn launch(
        &self,
        request: ClaudeStructuredLaunchRequestV1,
    ) -> Result<ClaudeStructuredLaunchReceiptV1, ClaudeStructuredRuntimeErrorV1> {
        let context = self
            .runtime_context(&request.interaction_session_id)
            .await?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        let launch_options = self
            .committed_launch_options(&context)
            .await?
            .unwrap_or_default();
        self.launch_context(context, launch_options, None)
            .await
            .map_err(|failure| failure.error)
    }

    async fn launch_with_options(
        &self,
        request: ClaudeStructuredLaunchRequestV1,
        launch_options: ClaudeStructuredLaunchOptionsV1,
    ) -> Result<ClaudeStructuredLaunchReceiptV1, ClaudeStructuredRuntimeErrorV1> {
        let context = self
            .runtime_context(&request.interaction_session_id)
            .await?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        if self
            .committed_launch_options(&context)
            .await?
            .is_some_and(|committed| committed != launch_options)
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        self.launch_context(context, launch_options, None)
            .await
            .map_err(|failure| failure.error)
    }

    async fn launch_with_transition_options(
        &self,
        request: ClaudeStructuredLaunchRequestV1,
        launch_options: ClaudeStructuredLaunchOptionsV1,
        environment: BTreeMap<String, String>,
    ) -> Result<ClaudeStructuredLaunchReceiptV1, ClaudeStructuredReplacementFailureV1> {
        let interaction_session_id = request.interaction_session_id.clone();
        let context = self
            .runtime_context(&request.interaction_session_id)
            .await?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        match self
            .launch_context(context, launch_options, Some(environment))
            .await
        {
            Ok(receipt) => Ok(receipt),
            Err(failure) => {
                let error = failure.error;
                let target_quiescence = if replacement_failure_is_quiescent(error) {
                    self.runtime_context(&interaction_session_id)
                        .await
                        .ok()
                        .flatten()
                        .map_or(StructuredProviderTargetQuiescenceV1::Unknown, |context| {
                            StructuredProviderTargetQuiescenceV1::ExactFailedBinding(Box::new(
                                context.binding,
                            ))
                        })
                } else {
                    StructuredProviderTargetQuiescenceV1::Unknown
                };
                Err(ClaudeStructuredReplacementFailureV1 {
                    error,
                    target_quiescence,
                    // This frame re-decides quiescence, not the cause.
                    detail: failure.detail,
                })
            }
        }
    }

    async fn committed_launch_options(
        &self,
        context: &ClaudeRuntimeContext,
    ) -> Result<Option<ClaudeStructuredLaunchOptionsV1>, ClaudeStructuredRuntimeErrorV1> {
        let Some(selection) = self
            .store
            .agent_runtime_selection(&context.binding.agent_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
        else {
            return Ok(None);
        };
        selection
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if selection.agent_id != context.binding.agent_id
            || selection.provider_id != context.binding.provider_id
            || selection.interaction_profile != AgentInteractionProfileV1::StructuredProtocol
            || selection.execution_profile != context.binding.execution_profile
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        Ok(Some(ClaudeStructuredLaunchOptionsV1::from_selection(
            &selection,
        )))
    }

    async fn prepared_environment(
        &self,
        provider_id: &ProviderIdV1,
        execution_profile: &AgentExecutionProfileV1,
    ) -> Result<BTreeMap<String, String>, ClaudeStructuredRuntimeErrorV1> {
        let prepared_profile = self
            .credential_profiles
            .prepare_for_launch(provider_id, execution_profile)
            .await
            .map_err(map_credential_error)?;
        prepared_claude_environment(
            &self.configuration.environment,
            &prepared_profile.environment(),
        )
    }

    /// Returns the replacement carrier rather than the bare error: this is the
    /// frame where a host attach failure still knows *why*, and every caller
    /// that does not want the evidence narrows it back with one map_err.
    async fn launch_context(
        &self,
        context: ClaudeRuntimeContext,
        launch_options: ClaudeStructuredLaunchOptionsV1,
        prepared_environment: Option<BTreeMap<String, String>>,
    ) -> Result<ClaudeStructuredLaunchReceiptV1, ClaudeStructuredReplacementFailureV1> {
        let ClaudeRuntimeContext {
            binding,
            workspace_id,
            cwd,
        } = context;
        let slot = {
            let mut slots = self.slots.lock().await;
            Arc::clone(
                slots
                    .entry(binding.interaction_session_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        let mut active = slot.lock().await;
        if let Some(existing) = active.as_ref() {
            if !existing.binding.same_runtime_authority(&binding)
                || existing.cwd != cwd
                || existing.launch_options != launch_options
            {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
            }
            if self
                .host
                .attachment_is_live(&existing.query_identity, &existing.host_identity)
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            {
                return Ok(existing.receipt.clone());
            }
            *active = None;
        }

        // Credential resolution depends only on the exact persisted binding.
        // Keep it before runtime-directory or relay creation so a stale account
        // generation cannot leave a provider process for repair to discover.
        let environment = match prepared_environment {
            Some(environment) => environment,
            None => {
                self.prepared_environment(&binding.provider_id, &binding.execution_profile)
                    .await?
            }
        };

        let (binding, mut prepared) = self.prepare_launch(binding, &workspace_id, &cwd).await?;
        let descriptor = match prepared.journal.state() {
            ClaudeRuntimeLaunchStateV1::Prepared => {
                self.start_prepared_relay(&binding, &workspace_id, &cwd, &mut prepared)
                    .await?
            }
            ClaudeRuntimeLaunchStateV1::RelayReady => prepared
                .journal
                .descriptor()
                .cloned()
                .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?,
            ClaudeRuntimeLaunchStateV1::Attached => prepared
                .journal
                .descriptor()
                .cloned()
                .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?,
            ClaudeRuntimeLaunchStateV1::QueryRetired
            | ClaudeRuntimeLaunchStateV1::StopCleanupPending
            | ClaudeRuntimeLaunchStateV1::FailureCleanupPending
            | ClaudeRuntimeLaunchStateV1::Failed
            | ClaudeRuntimeLaunchStateV1::Stopped => {
                return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed.into());
            }
        };
        if wait_for_relay(&prepared.files.endpoint).await.is_err() {
            self.publish_failure(
                &mut prepared,
                ClaudeStructuredRecordedFailureV1::RelayReadiness,
            )?;
            self.complete_failed_runtime_cleanup(&cwd, &mut prepared)
                .await?;
            return Err(ClaudeStructuredRuntimeErrorV1::RelayReadinessFailed.into());
        }

        let reattaching = prepared.journal.state() == ClaudeRuntimeLaunchStateV1::Attached;
        let replacement_authority = if reattaching {
            None
        } else {
            self.replacement_authority_for_target(&binding, &workspace_id, &cwd, &prepared.journal)
                .await?
        };

        let attachment = self
            .host
            .attach(ClaudeConversationAttachmentV1 {
                binding: binding.clone(),
                cwd: cwd.clone(),
                environment,
                permission_mode: launch_options.permission_mode.clone(),
                model: launch_options.model.clone(),
                effort: launch_options.effort.clone(),
                process: Some(ClaudeConversationProcessBindingV1 {
                    relay_capability: prepared
                        .capability
                        .clone()
                        .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?,
                    relay_endpoint: prepared.files.endpoint.clone(),
                }),
                relay_id: prepared.files.relay_id.clone(),
                replacement_authority,
            })
            .await;
        let attachment = match attachment {
            Ok(attachment) => attachment,
            Err(error) => {
                self.record_host_attach_failure(&cwd, &mut prepared, &error)
                    .await?;
                return Err(ClaudeStructuredReplacementFailureV1 {
                    detail: error.detail().map(str::to_owned),
                    ..ClaudeStructuredRuntimeErrorV1::HostAttachFailed.into()
                });
            }
        };
        let query_identity = attachment.identity;
        let binding = attachment.binding;
        let receipt = ClaudeStructuredLaunchReceiptV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id.clone(),
            runtime_generation: query_identity.runtime_generation.clone(),
            query_epoch: query_identity.query_epoch.clone(),
        };
        prepared.journal.attached(attachment.host_process_id);
        if write_journal(&prepared.files.runtime_directory, &prepared.journal).is_err() {
            let _ = self.host.retire(&binding, &query_identity, None).await;
            let _ = stop_exact(
                &self.configuration,
                &cwd,
                &descriptor,
                "claude-chat-attach-journal-failure-stop",
            )
            .await;
            return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed.into());
        }
        self.finalize_replacement_authority(&binding, &workspace_id, &cwd, &mut prepared)
            .await?;
        *active = Some(ActiveClaudeRuntime {
            binding,
            cwd,
            launch_options,
            host_identity: attachment.host_identity,
            query_identity,
            receipt: receipt.clone(),
        });
        Ok(receipt)
    }

    /// Reattaches the new control-plane generation to the selected Claude
    /// conversation. A live relay keeps its exact runtime generation; a relay
    /// proven dead is replaced through the same launch journal while preserving
    /// the logical interaction and provider conversation.
    pub(crate) async fn attach_existing(
        &self,
        selection: &AgentRuntimeSelectionV1,
        binding: &AgentInteractionBindingV1,
    ) -> Result<AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
        selection
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: binding.clone(),
        }
        .validate_for_selection(selection)
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if selection.interaction_profile != AgentInteractionProfileV1::StructuredProtocol
            || selection.provider_id.as_str() != CLAUDE_PROVIDER_ID
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }

        let context = self
            .runtime_context(&binding.interaction_session_id)
            .await?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if !context.binding.same_runtime_authority(binding) {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let authoritative_binding = context.binding.clone();
        let launch_options = ClaudeStructuredLaunchOptionsV1::from_selection(selection);
        let slot = {
            let mut slots = self.slots.lock().await;
            Arc::clone(
                slots
                    .entry(authoritative_binding.interaction_session_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        let mut active = slot.lock().await;
        if let Some(existing) = active.as_mut() {
            if !existing
                .binding
                .same_runtime_authority(&authoritative_binding)
                || existing.cwd != context.cwd
                || existing.launch_options != launch_options
            {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            if self
                .host
                .attachment_is_live(&existing.query_identity, &existing.host_identity)
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            {
                existing.binding = authoritative_binding.clone();
                return Ok(authoritative_binding);
            }
            *active = None;
        }

        let Some(mut prepared) =
            self.read_runtime(&authoritative_binding, &context.workspace_id, &context.cwd)?
        else {
            drop(active);
            return self.recover_existing_context(context, launch_options).await;
        };
        match prepared.journal.state() {
            ClaudeRuntimeLaunchStateV1::StopCleanupPending => {
                self.complete_stop_cleanup(
                    &context.cwd,
                    &prepared.files.runtime_directory,
                    &mut prepared.journal,
                )
                .await?;
                drop(active);
                return self.recover_existing_context(context, launch_options).await;
            }
            ClaudeRuntimeLaunchStateV1::FailureCleanupPending
            | ClaudeRuntimeLaunchStateV1::Failed => {
                let failure = prepared
                    .journal
                    .failure()
                    .cloned()
                    .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
                if prepared.journal.state() == ClaudeRuntimeLaunchStateV1::FailureCleanupPending {
                    self.complete_failed_runtime_cleanup(&context.cwd, &mut prepared)
                        .await?;
                }
                return Err(recorded_failure_error(&failure));
            }
            ClaudeRuntimeLaunchStateV1::Attached => {}
            ClaudeRuntimeLaunchStateV1::Prepared
            | ClaudeRuntimeLaunchStateV1::RelayReady
            | ClaudeRuntimeLaunchStateV1::QueryRetired
            | ClaudeRuntimeLaunchStateV1::Stopped => {
                // The durable binding selects this exact journal generation.
                // Its incomplete transaction resumes through the same launch
                // authority; a recorded failure waits for explicit launch.
                drop(active);
                return self.recover_existing_context(context, launch_options).await;
            }
        }
        prepared
            .journal
            .descriptor()
            .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
        if wait_for_relay(&prepared.files.endpoint).await.is_err() {
            drop(active);
            return self.recover_existing_context(context, launch_options).await;
        }
        let capability = prepared
            .capability
            .clone()
            .ok_or(ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
        let prepared_profile = self
            .credential_profiles
            .prepare_for_launch(
                &authoritative_binding.provider_id,
                &authoritative_binding.execution_profile,
            )
            .await
            .map_err(map_credential_error)?;
        let environment = prepared_claude_environment(
            &self.configuration.environment,
            &prepared_profile.environment(),
        )?;
        let attachment = self
            .host
            .attach(ClaudeConversationAttachmentV1 {
                binding: authoritative_binding.clone(),
                cwd: context.cwd.clone(),
                environment,
                permission_mode: launch_options.permission_mode.clone(),
                model: launch_options.model.clone(),
                effort: launch_options.effort.clone(),
                process: Some(ClaudeConversationProcessBindingV1 {
                    relay_capability: capability,
                    relay_endpoint: prepared.files.endpoint.clone(),
                }),
                relay_id: prepared.files.relay_id.clone(),
                replacement_authority: None,
            })
            .await;
        let attachment = match attachment {
            Ok(attachment) => attachment,
            Err(error) => {
                self.record_host_attach_failure(&context.cwd, &mut prepared, &error)
                    .await?;
                return Err(ClaudeStructuredRuntimeErrorV1::HostAttachFailed);
            }
        };
        let attached_binding = attachment.binding;
        let query_identity = prepared.journal.query_identity();
        if attachment.identity != query_identity
            || !authoritative_binding.same_runtime_authority(&attached_binding)
            || attachment.identity.runtime_generation != attached_binding.runtime.runtime_generation
            || attachment.identity.query_epoch != attached_binding.runtime.provider_epoch
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let receipt = ClaudeStructuredLaunchReceiptV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: attached_binding.interaction_session_id.clone(),
            runtime_generation: attached_binding.runtime.runtime_generation.clone(),
            query_epoch: attached_binding.runtime.provider_epoch.clone(),
        };
        self.finalize_replacement_authority(
            &attached_binding,
            &context.workspace_id,
            &context.cwd,
            &mut prepared,
        )
        .await?;
        *active = Some(ActiveClaudeRuntime {
            binding: attached_binding.clone(),
            cwd: context.cwd,
            launch_options,
            host_identity: attachment.host_identity,
            query_identity,
            receipt,
        });
        Ok(attached_binding)
    }

    async fn recover_existing_context(
        &self,
        context: ClaudeRuntimeContext,
        launch_options: ClaudeStructuredLaunchOptionsV1,
    ) -> Result<AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
        let receipt = self
            .launch_context(context, launch_options, None)
            .await
            .map_err(|failure| failure.error)?;
        let replacement = self
            .conversation_service
            .binding(&receipt.interaction_session_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        if replacement.runtime.runtime_generation != receipt.runtime_generation
            || replacement.runtime.provider_epoch != receipt.query_epoch
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        Ok(replacement)
    }

    pub async fn open(
        &self,
        request: ClaudeStructuredOpenRequestV1,
    ) -> Result<ClaudeStructuredOpenReceiptV1, ClaudeStructuredRuntimeErrorV1> {
        self.open_with_native_replacement(request, None, None)
            .await
            .map_err(|failure| failure.error)
    }

    pub(crate) async fn open_replacement(
        &self,
        mut request: ClaudeStructuredOpenRequestV1,
        transition: &AgentRuntimeTransitionRecordV1,
        provider_state_environment: ProviderStateEnvironment,
    ) -> Result<ClaudeStructuredOpenReceiptV1, ClaudeStructuredReplacementFailureV1> {
        let dispatch = replacement_dispatch(transition, &request)?;
        let environment = prepared_claude_environment(
            &self.configuration.environment,
            &provider_state_environment,
        )?;
        let failed_target = self.failed_target_binding(transition)?;
        request.provider_conversation_ref = replacement_provider_conversation_ref(
            request.provider_conversation_ref.as_deref(),
            failed_target.as_ref(),
        );
        match dispatch {
            ReplacementDispatch::NativeSource(binding) => {
                self.open_with_native_replacement(
                    request,
                    Some((binding, transition)),
                    Some(environment),
                )
                .await
            }
            ReplacementDispatch::StructuredSource => {
                self.open_with_structured_replacement(request, transition, environment)
                    .await
            }
        }
    }

    async fn open_with_structured_replacement(
        &self,
        request: ClaudeStructuredOpenRequestV1,
        transition: &AgentRuntimeTransitionRecordV1,
        environment: BTreeMap<String, String>,
    ) -> Result<ClaudeStructuredOpenReceiptV1, ClaudeStructuredReplacementFailureV1> {
        let source_binding = structured_transition_source_binding(transition)?;
        request
            .execution_profile
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        let context = self
            .runtime_context(&source_binding.interaction_session_id)
            .await?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if source_binding.agent_id != request.agent_id
            || source_binding.provider_id.as_str() != CLAUDE_PROVIDER_ID
            || source_binding.provider_conversation_ref.as_deref()
                != transition.intent.provider_conversation_ref.as_option()
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
        }
        let failed_binding = self.failed_target_binding(transition)?;
        let binding = if let Some(failed_binding) = failed_binding.as_ref() {
            self.replace_failed_target(
                &context,
                failed_binding,
                &request,
                transition_target_effect_operation_id(transition),
                ClaudeFailedTargetDisposition::Launch,
            )
            .await?
        } else {
            self.replace_stopped_target(
                &context,
                source_binding,
                &request,
                transition_target_effect_operation_id(transition),
            )
            .await?
        };
        let replacement_source = failed_binding.as_ref().unwrap_or(source_binding);
        let matches_authorized_target = {
            let target_revision = replacement_source
                .binding_revision
                .checked_add(1)
                .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
            let target_runtime = replacement_runtime_for_operation(
                &replacement_source.interaction_session_id,
                &replacement_source.runtime,
                transition_target_effect_operation_id(transition),
            );
            is_exact_replacement_target(
                &binding,
                replacement_source,
                &request,
                &target_runtime,
                target_revision,
            )
        };
        if !matches_authorized_target {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
        }
        let launch = self
            .launch_with_transition_options(
                ClaudeStructuredLaunchRequestV1 {
                    interaction_session_id: binding.interaction_session_id.clone(),
                },
                ClaudeStructuredLaunchOptionsV1::from_open(&request),
                environment,
            )
            .await?;
        let binding = self
            .conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        if binding.execution_profile != request.execution_profile
            || request
                .provider_conversation_ref
                .as_ref()
                .is_some_and(|expected| {
                    binding.provider_conversation_ref.as_ref() != Some(expected)
                })
            || binding.runtime.runtime_generation != launch.runtime_generation
            || binding.runtime.provider_epoch != launch.query_epoch
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
        }
        Ok(ClaudeStructuredOpenReceiptV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            binding,
            launch,
        })
    }

    pub(crate) async fn stop_replacement_source(
        &self,
        transition: &AgentRuntimeTransitionRecordV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let binding = structured_replacement_source_binding(transition)?;
        let current = self
            .conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if current != *binding {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let allowed_target = if transition.intent.target_interaction_profile
            == AgentInteractionProfileV1::StructuredProtocol
        {
            let mut target = binding.clone();
            target.runtime = replacement_runtime_for_operation(
                &binding.interaction_session_id,
                &binding.runtime,
                &transition.intent.operation_id,
            );
            Some(runtime_query_identity(&self.configuration, &target)?)
        } else {
            None
        };
        self.stop_runtime(
            &binding.interaction_session_id,
            &binding.runtime.runtime_generation,
            Some(binding),
            transition.intent.source_stop_policy.requires_idle(),
            allowed_target,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn retire_replacement_source(
        &self,
        transition: &AgentRuntimeTransitionRecordV1,
    ) -> Result<AgentRuntimeReplacementAuthorityV1, ClaudeStructuredRuntimeErrorV1> {
        transition
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        let Some(authority) = transition.replacement_authority.as_ref() else {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        };
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: failed } = &authority.0
        else {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        };
        if failed.provider_id.as_str() != CLAUDE_PROVIDER_ID {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let context = self
            .runtime_context(&failed.interaction_session_id)
            .await?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        let request = ClaudeStructuredOpenRequestV1 {
            agent_id: failed.agent_id.clone(),
            execution_profile: transition.intent.target_execution_profile.clone(),
            provider_conversation_ref: failed.provider_conversation_ref.clone(),
            permission_mode: transition.intent.effective_permission_mode(),
            model: None,
            effort: None,
        };
        let replacement = self
            .replace_failed_target(
                &context,
                failed,
                &request,
                &transition.intent.operation_id,
                ClaudeFailedTargetDisposition::Stop,
            )
            .await?;
        Ok(AgentRuntimeReplacementAuthorityV1(
            AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: replacement,
            },
        ))
    }

    async fn open_with_native_replacement(
        &self,
        request: ClaudeStructuredOpenRequestV1,
        authorized_native: Option<(SessionBindingRecordV1, &AgentRuntimeTransitionRecordV1)>,
        transition_environment: Option<BTreeMap<String, String>>,
    ) -> Result<ClaudeStructuredOpenReceiptV1, ClaudeStructuredReplacementFailureV1> {
        let transition_authorized = authorized_native.is_some();
        let authorized_native_binding = authorized_native.as_ref().map(|(binding, _)| binding);
        request
            .execution_profile
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        if request
            .provider_conversation_ref
            .as_deref()
            .is_some_and(|reference| !safe_token(reference))
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid.into());
        }
        let agent = self
            .store
            .agent(&request.agent_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
        if agent.provider_id.as_str() != CLAUDE_PROVIDER_ID {
            return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid.into());
        }
        let native_binding = self
            .store
            .session_binding(&request.agent_id)
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        let committed_interaction =
            if let (Some(_), None) = (&native_binding, &authorized_native_binding) {
                let selection = self
                    .store
                    .agent_runtime_selection(&request.agent_id)
                    .await
                    .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
                    .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
                let operation_id = selection
                    .selected_by_operation_id
                    .as_ref()
                    .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
                let transition = self
                    .store
                    .agent_runtime_transition(operation_id)
                    .await
                    .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?
                    .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
                Some(
                    committed_structured_interaction(
                        &selection,
                        &transition,
                        &request,
                        &agent.provider_id,
                    )
                    .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?,
                )
            } else {
                None
            };
        match (&native_binding, authorized_native_binding) {
            (None, None) => {}
            (Some(current), Some(expected)) if current == expected => {}
            (Some(_), None) if committed_interaction.is_some() => {}
            _ => {
                // An active Native selection may be replaced only by the exact
                // source-stopped transition. Ordinary reopen accepts a stored
                // Native row only after the committed Structured target proves
                // that row is historical.
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
            }
        }
        let binding = match self
            .conversation_service
            .binding_for_agent(&request.agent_id)
            .await
            .map_err(map_conversation_error)?
        {
            Some(existing) => {
                if let Some((_, transition)) = authorized_native {
                    let context = self
                        .runtime_context(&existing.interaction_session_id)
                        .await?
                        .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
                    if let Some(failed) = self.failed_target_binding(transition)? {
                        if existing != failed {
                            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
                        }
                        self.replace_failed_target(
                            &context,
                            &failed,
                            &request,
                            transition_target_effect_operation_id(transition),
                            ClaudeFailedTargetDisposition::Launch,
                        )
                        .await?
                    } else {
                        self.replace_stopped_target(
                            &context,
                            &existing,
                            &request,
                            transition_target_effect_operation_id(transition),
                        )
                        .await?
                    }
                } else {
                    if existing.agent_id != request.agent_id
                        || existing.provider_id.as_str() != CLAUDE_PROVIDER_ID
                        || existing.execution_profile != request.execution_profile
                        || request
                            .provider_conversation_ref
                            .as_ref()
                            .is_some_and(|reference| {
                                existing.provider_conversation_ref.as_ref() != Some(reference)
                            })
                    {
                        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
                    }
                    existing
                }
            }
            None => {
                let proposed = open::initial_binding(
                    &agent,
                    &request,
                    &self.configuration.backend_generation,
                )?;
                self.conversation_service
                    .create(&proposed)
                    .await
                    .map_err(map_conversation_error)?
            }
        };
        if committed_interaction
            .as_ref()
            .is_some_and(|expected| *expected != binding.interaction_session_id)
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
        }
        let launch_request = ClaudeStructuredLaunchRequestV1 {
            interaction_session_id: binding.interaction_session_id.clone(),
        };
        let launch_options = ClaudeStructuredLaunchOptionsV1::from_open(&request);
        let launch = if transition_authorized {
            self.launch_with_transition_options(
                launch_request,
                launch_options,
                transition_environment.ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?,
            )
            .await?
        } else {
            let selection = self
                .store
                .agent_runtime_selection(&request.agent_id)
                .await
                .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
            match selection {
                Some(selection) => match self.attach_existing(&selection, &binding).await {
                    Ok(attached) => ClaudeStructuredLaunchReceiptV1 {
                        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                        interaction_session_id: attached.interaction_session_id,
                        runtime_generation: attached.runtime.runtime_generation,
                        query_epoch: attached.runtime.provider_epoch,
                    },
                    Err(
                        ClaudeStructuredRuntimeErrorV1::HostAttachRecoveryRequired
                        | ClaudeStructuredRuntimeErrorV1::RelayReadinessRecoveryRequired
                        | ClaudeStructuredRuntimeErrorV1::RuntimeLaunchRequired,
                    ) => {
                        self.launch_with_options(launch_request, launch_options)
                            .await?
                    }
                    Err(error) => return Err(error.into()),
                },
                None => {
                    self.launch_with_options(launch_request, launch_options)
                        .await?
                }
            }
        };
        let binding = self
            .conversation_service
            .binding(&binding.interaction_session_id)
            .await
            .map_err(map_conversation_error)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        if binding.runtime.runtime_generation != launch.runtime_generation
            || binding.runtime.provider_epoch != launch.query_epoch
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict.into());
        }
        Ok(ClaudeStructuredOpenReceiptV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            binding,
            launch,
        })
    }

    fn failed_target_binding(
        &self,
        transition: &AgentRuntimeTransitionRecordV1,
    ) -> Result<Option<AgentInteractionBindingV1>, ClaudeStructuredRuntimeErrorV1> {
        transition
            .validate()
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        let authority = transition
            .replacement_authority
            .as_ref()
            .map(|authority| &authority.0);
        match authority {
            Some(AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding })
                if binding.agent_id == transition.intent.source.agent_id
                    && binding.provider_id.as_str() == CLAUDE_PROVIDER_ID
                    && transition
                        .intent
                        .provider_conversation_ref
                        .as_option()
                        .is_none_or(|expected| {
                            binding.provider_conversation_ref.as_deref() == Some(expected)
                        }) =>
            {
                Ok(Some(binding.clone()))
            }
            Some(_) => Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
            None => Ok(None),
        }
    }

    /// Rotate one exact dormant Structured binding under a durable transition.
    /// The provider journal proves the old runtime is stopped; the transition
    /// operation deterministically names the only target that may replace it.
    async fn replace_stopped_target(
        &self,
        context: &ClaudeRuntimeContext,
        source: &AgentInteractionBindingV1,
        request: &ClaudeStructuredOpenRequestV1,
        operation_id: &OperationIdV1,
    ) -> Result<AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
        if source.agent_id != request.agent_id
            || source.provider_id.as_str() != CLAUDE_PROVIDER_ID
            || request
                .provider_conversation_ref
                .as_ref()
                .is_some_and(|expected| source.provider_conversation_ref.as_ref() != Some(expected))
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let target_runtime = replacement_runtime_for_operation(
            &source.interaction_session_id,
            &source.runtime,
            operation_id,
        );
        let target_revision = source
            .binding_revision
            .checked_add(1)
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        let source_runtime = self
            .read_runtime(source, &context.workspace_id, &context.cwd)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if source_runtime.journal.state() != ClaudeRuntimeLaunchStateV1::Stopped {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let mut expected = source.clone();
        expected.execution_profile = request.execution_profile.clone();
        expected.runtime = target_runtime.clone();
        expected.binding_revision = target_revision;
        let target_identity = runtime_query_identity(&self.configuration, &expected)?;
        if is_exact_replacement_target(
            &context.binding,
            source,
            request,
            &target_runtime,
            target_revision,
        ) {
            let target = self
                .read_runtime(&context.binding, &context.workspace_id, &context.cwd)?
                .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
            if !source_runtime.journal.accepts_existing_target_predecessor(
                &target_identity,
                target.journal.provider_predecessor(),
            ) {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            return Ok(context.binding.clone());
        }
        if context.binding != *source {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let replaced_at_ms = now_ms()?.max(source.updated_at_ms);
        expected.updated_at_ms = replaced_at_ms;
        match self.read_runtime(&expected, &context.workspace_id, &context.cwd)? {
            Some(target)
                if source_runtime.journal.accepts_existing_target_predecessor(
                    &target_identity,
                    target.journal.provider_predecessor(),
                ) => {}
            Some(_) => return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
            None => {
                self.create_runtime(
                    &expected,
                    &context.workspace_id,
                    &context.cwd,
                    source_runtime
                        .journal
                        .provider_predecessor_for_new_target()?,
                )?;
            }
        }
        let replacement = AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: source.interaction_session_id.clone(),
            expected_binding_revision: source.binding_revision,
            source: source.runtime.clone(),
            source_execution_profile: source.execution_profile.clone(),
            target: target_runtime,
            target_execution_profile: request.execution_profile.clone(),
            provider_conversation_ref: request.provider_conversation_ref.clone(),
            replaced_at_ms,
        };
        let replaced = self
            .conversation_service
            .replace_runtime(&replacement)
            .await
            .map_err(map_conversation_error)?;
        if !is_exact_replacement_target(
            &replaced,
            source,
            request,
            &expected.runtime,
            target_revision,
        ) {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        Ok(replaced)
    }

    async fn replace_failed_target(
        &self,
        context: &ClaudeRuntimeContext,
        failed: &AgentInteractionBindingV1,
        request: &ClaudeStructuredOpenRequestV1,
        operation_id: &OperationIdV1,
        disposition: ClaudeFailedTargetDisposition,
    ) -> Result<AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
        if failed.agent_id != request.agent_id
            || failed.provider_id.as_str() != CLAUDE_PROVIDER_ID
            || failed.provider_conversation_ref != request.provider_conversation_ref
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let target_runtime = replacement_runtime_for_operation(
            &failed.interaction_session_id,
            &failed.runtime,
            operation_id,
        );
        let target_revision = failed
            .binding_revision
            .checked_add(1)
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
        let mut failed_runtime = self
            .read_runtime(failed, &context.workspace_id, &context.cwd)?
            .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
        if failed_runtime.journal.state() != ClaudeRuntimeLaunchStateV1::Failed {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let replacement_source = self
            .failed_target_replacement_source(
                failed,
                &context.workspace_id,
                &context.cwd,
                &mut failed_runtime,
            )
            .await?;

        if is_exact_replacement_target(
            &context.binding,
            failed,
            request,
            &target_runtime,
            target_revision,
        ) {
            let mut target = self
                .read_runtime(&context.binding, &context.workspace_id, &context.cwd)?
                .ok_or(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
            let completed_terminal_stop =
                matches!(disposition, ClaudeFailedTargetDisposition::Stop)
                    && target.journal.state() == ClaudeRuntimeLaunchStateV1::Stopped
                    && target.journal.provider_predecessor().is_none();
            let predecessor_matches =
                target.journal.provider_predecessor() == replacement_source.as_ref();
            let stop_state_is_recoverable =
                !matches!(disposition, ClaudeFailedTargetDisposition::Stop)
                    || matches!(
                        target.journal.state(),
                        ClaudeRuntimeLaunchStateV1::Prepared
                            | ClaudeRuntimeLaunchStateV1::StopCleanupPending
                            | ClaudeRuntimeLaunchStateV1::Stopped
                    );
            if (!completed_terminal_stop && !predecessor_matches) || !stop_state_is_recoverable {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            if matches!(disposition, ClaudeFailedTargetDisposition::Stop) {
                self.begin_prepared_stop_cleanup(&context.workspace_id, &mut target)
                    .await?;
                self.complete_stop_cleanup(
                    &context.cwd,
                    &target.files.runtime_directory,
                    &mut target.journal,
                )
                .await?;
            }
            return Ok(context.binding.clone());
        }
        if context.binding != *failed {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }

        self.retire_failed_runtime(context, failed).await?;
        let replaced_at_ms = now_ms()?.max(failed.updated_at_ms);
        let mut expected = failed.clone();
        expected.execution_profile = request.execution_profile.clone();
        expected.runtime = target_runtime.clone();
        expected.binding_revision = target_revision;
        expected.updated_at_ms = replaced_at_ms;
        let mut target = match self.read_runtime(&expected, &context.workspace_id, &context.cwd)? {
            Some(target)
                if target.journal.provider_predecessor() == replacement_source.as_ref()
                    || matches!(disposition, ClaudeFailedTargetDisposition::Stop)
                        && target.journal.state() == ClaudeRuntimeLaunchStateV1::Stopped
                        && target.journal.provider_predecessor().is_none() =>
            {
                target
            }
            Some(_) => return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
            None => self.create_runtime(
                &expected,
                &context.workspace_id,
                &context.cwd,
                replacement_source,
            )?,
        };
        if matches!(disposition, ClaudeFailedTargetDisposition::Stop) {
            if !matches!(
                target.journal.state(),
                ClaudeRuntimeLaunchStateV1::Prepared
                    | ClaudeRuntimeLaunchStateV1::StopCleanupPending
                    | ClaudeRuntimeLaunchStateV1::Stopped
            ) {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
            self.begin_prepared_stop_cleanup(&context.workspace_id, &mut target)
                .await?;
            self.complete_stop_cleanup(
                &context.cwd,
                &target.files.runtime_directory,
                &mut target.journal,
            )
            .await?;
        }
        let replacement = AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: failed.interaction_session_id.clone(),
            expected_binding_revision: failed.binding_revision,
            source: failed.runtime.clone(),
            source_execution_profile: failed.execution_profile.clone(),
            target: target_runtime,
            target_execution_profile: request.execution_profile.clone(),
            provider_conversation_ref: request.provider_conversation_ref.clone(),
            replaced_at_ms,
        };
        let replaced = self
            .conversation_service
            .replace_runtime(&replacement)
            .await
            .map_err(map_conversation_error)?;
        if !is_exact_replacement_target(
            &replaced,
            failed,
            request,
            &expected.runtime,
            target_revision,
        ) {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        Ok(replaced)
    }

    async fn retire_failed_runtime(
        &self,
        context: &ClaudeRuntimeContext,
        failed: &AgentInteractionBindingV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        if context.binding != *failed {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let slot = {
            let mut slots = self.slots.lock().await;
            Arc::clone(
                slots
                    .entry(failed.interaction_session_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        let active = slot.lock().await;
        if active.is_some() {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        if let Some(mut prepared) =
            self.read_runtime(failed, &context.workspace_id, &context.cwd)?
        {
            match prepared.journal.state() {
                ClaudeRuntimeLaunchStateV1::FailureCleanupPending => {
                    self.complete_failed_runtime_cleanup(&context.cwd, &mut prepared)
                        .await?;
                }
                ClaudeRuntimeLaunchStateV1::Failed => {}
                ClaudeRuntimeLaunchStateV1::Prepared
                | ClaudeRuntimeLaunchStateV1::RelayReady
                | ClaudeRuntimeLaunchStateV1::Attached
                | ClaudeRuntimeLaunchStateV1::QueryRetired
                | ClaudeRuntimeLaunchStateV1::StopCleanupPending
                | ClaudeRuntimeLaunchStateV1::Stopped => {
                    return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
                }
            }
            if prepared.journal.state() != ClaudeRuntimeLaunchStateV1::Failed
                || prepared.journal.failure().is_none()
            {
                return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
            }
        }
        drop(active);
        self.remove_idle_slot(&failed.interaction_session_id, &slot)
            .await;
        Ok(())
    }

    pub async fn stop(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        runtime_generation: &str,
    ) -> Result<bool, ClaudeStructuredRuntimeErrorV1> {
        self.stop_runtime(
            interaction_session_id,
            runtime_generation,
            None,
            false,
            None,
        )
        .await
    }

    pub(crate) async fn stop_terminal(
        &self,
        binding: &AgentInteractionBindingV1,
    ) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
        let stopped = self
            .stop_runtime(
                &binding.interaction_session_id,
                &binding.runtime.runtime_generation,
                Some(binding),
                false,
                None,
            )
            .await?;
        if !stopped {
            return Err(ClaudeStructuredRuntimeErrorV1::StopFailed);
        }
        Ok(())
    }

    async fn stop_runtime(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        runtime_generation: &str,
        expected_binding: Option<&AgentInteractionBindingV1>,
        require_idle: bool,
        allowed_target: Option<ClaudeDch1QueryIdentity>,
    ) -> Result<bool, ClaudeStructuredRuntimeErrorV1> {
        if !safe_token(runtime_generation) {
            return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid);
        }
        let Some(context) = self.runtime_context(interaction_session_id).await? else {
            return Ok(false);
        };
        if context.binding.runtime.runtime_generation != runtime_generation
            || expected_binding
                .is_some_and(|expected| !context.binding.same_runtime_authority(expected))
        {
            return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
        }
        let slot = {
            let mut slots = self.slots.lock().await;
            Arc::clone(
                slots
                    .entry(interaction_session_id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        let mut active = slot.lock().await;
        if let Some(runtime) = active.as_ref() {
            if runtime.receipt.runtime_generation != runtime_generation
                || !runtime.binding.same_runtime_authority(&context.binding)
            {
                return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
            }
        }
        // The durable launch journal owns stop progress for both attached and
        // recovered slots. A pending exact stop must never retire the Query again.
        let Some(mut prepared) =
            self.read_runtime(&context.binding, &context.workspace_id, &context.cwd)?
        else {
            if active.is_some() {
                return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
            }
            drop(active);
            self.remove_idle_slot(interaction_session_id, &slot).await;
            return Ok(false);
        };
        if matches!(
            prepared.journal.state(),
            ClaudeRuntimeLaunchStateV1::Attached | ClaudeRuntimeLaunchStateV1::QueryRetired
        ) {
            self.retire_query_before_stop(
                &context.binding,
                &prepared.journal.query_identity(),
                &prepared.files.runtime_directory,
                &mut prepared.journal,
                require_idle,
                allowed_target.as_ref(),
            )
            .await?;
        }
        self.begin_prepared_stop_cleanup(&context.workspace_id, &mut prepared)
            .await?;
        self.complete_stop_cleanup(
            &context.cwd,
            &prepared.files.runtime_directory,
            &mut prepared.journal,
        )
        .await?;
        active.take();
        drop(active);
        self.remove_idle_slot(interaction_session_id, &slot).await;
        Ok(true)
    }

    async fn remove_idle_slot(
        &self,
        interaction_session_id: &AgentInteractionSessionIdV1,
        slot: &ClaudeRuntimeSlot,
    ) {
        let mut slots = self.slots.lock().await;
        if slots
            .get(interaction_session_id)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
            && Arc::strong_count(slot) == 2
        {
            slots.remove(interaction_session_id);
        }
    }
}

enum ReplacementDispatch {
    NativeSource(SessionBindingRecordV1),
    StructuredSource,
}

/// Pure admission for a replacement open: the intent is the one authority —
/// the request must equal its target execution profile, permission mode, and
/// EFFECTIVE launch selection (the snapshot when one rides the transition),
/// and dispatch follows the SOURCE authority: a structured source is a
/// structured replacement whether the change is credentials or launch
/// selection.
fn replacement_dispatch(
    transition: &AgentRuntimeTransitionRecordV1,
    request: &ClaudeStructuredOpenRequestV1,
) -> Result<ReplacementDispatch, ClaudeStructuredRuntimeErrorV1> {
    transition
        .validate()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
    let launch = transition.intent.effective_launch_selection();
    if !transition.permits_target_effects()
        || transition.intent.source.agent_id != request.agent_id
        || transition.intent.target_interaction_profile
            != AgentInteractionProfileV1::StructuredProtocol
        || transition.intent.target_execution_profile != request.execution_profile
        || request.provider_conversation_ref.as_deref()
            != transition.intent.provider_conversation_ref.as_option()
        || transition.intent.effective_permission_mode() != request.permission_mode
        || launch.model.as_ref() != request.model.as_ref()
        || launch.effort.as_ref() != request.effort.as_ref()
    {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
    }
    match &transition.intent.source_authority {
        AgentRuntimeBindingAuthorityV1::NativeCli { authority }
            if transition.intent.source.interaction_profile
                == AgentInteractionProfileV1::NativeCli =>
        {
            Ok(ReplacementDispatch::NativeSource(authority.binding.clone()))
        }
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. }
            if transition.intent.source.interaction_profile
                == AgentInteractionProfileV1::StructuredProtocol =>
        {
            Ok(ReplacementDispatch::StructuredSource)
        }
        _ => Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict),
    }
}

fn structured_replacement_source_binding(
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<&AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
    transition
        .validate()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
        &transition.intent.source_authority
    else {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
    };
    if transition.state != AgentRuntimeTransitionStateV1::Admitted
        || transition.intent.source.interaction_profile
            != AgentInteractionProfileV1::StructuredProtocol
    {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
    }
    Ok(binding)
}

fn structured_transition_source_binding(
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<&AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
    transition
        .validate()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
        &transition.intent.source_authority
    else {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
    };
    if !transition.permits_target_effects()
        || transition.intent.source.interaction_profile
            != AgentInteractionProfileV1::StructuredProtocol
    {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
    }
    Ok(binding)
}

fn prepared_claude_environment(
    base: &BTreeMap<String, String>,
    mutation: &ProviderStateEnvironment,
) -> Result<BTreeMap<String, String>, ClaudeStructuredRuntimeErrorV1> {
    let mut environment = base
        .iter()
        .filter(|(key, _)| !control_environment(key) && !outer_claude_session_environment(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    for key in mutation.removals() {
        environment.remove(key);
    }
    for (key, value) in mutation.values() {
        environment.insert(key.clone(), value.clone());
    }
    if !environment.contains_key("HOME") || !environment.contains_key("PATH") {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable);
    }
    validate_environment(&environment)?;
    Ok(environment)
}

fn control_environment(key: &str) -> bool {
    key == "HMUX" || key.starts_with("HMUX_") || key.starts_with("DURE_")
}

/// Remove inherited client identity plus settings reserved by the SDK host.
/// Authentication and provider configuration retain their existing authority;
/// the SDK host supplies its own reserved settings after this boundary.
pub(crate) fn outer_claude_session_environment(key: &str) -> bool {
    hmux_runtime_contract::is_launching_client_session_env_key(key)
        || matches!(
            key,
            "CLAUDE_AGENT_SDK_VERSION" | "CLAUDE_PID" | "CLAUDE_EFFORT" | "DISABLE_AUTOUPDATER"
        )
}

fn validate_environment(
    environment: &BTreeMap<String, String>,
) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
    if environment.len() > 4096
        || environment.iter().any(|(key, value)| {
            key.is_empty()
                || key.len() > 1024
                || key.contains('=')
                || key.as_bytes().contains(&0)
                || value.len() > 1024 * 1024
                || value.as_bytes().contains(&0)
        })
    {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable);
    }
    Ok(())
}

fn map_credential_error(error: ProviderCredentialProfileErrorV1) -> ClaudeStructuredRuntimeErrorV1 {
    match error {
        ProviderCredentialProfileErrorV1::StaleGeneration => {
            ClaudeStructuredRuntimeErrorV1::CredentialStale
        }
        ProviderCredentialProfileErrorV1::Unavailable => {
            ClaudeStructuredRuntimeErrorV1::CredentialUnavailable
        }
        ProviderCredentialProfileErrorV1::RequestInvalid
        | ProviderCredentialProfileErrorV1::Conflict => {
            ClaudeStructuredRuntimeErrorV1::RequestInvalid
        }
        ProviderCredentialProfileErrorV1::StoreFailed => {
            ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable
        }
    }
}

fn map_query_retirement_error(
    error: ClaudeConversationHostErrorV1,
) -> ClaudeStructuredRuntimeErrorV1 {
    if error.is_source_busy() {
        ClaudeStructuredRuntimeErrorV1::SourceBusy
    } else if error.reason().starts_with("supervisor_")
        || error.reason() == "supervisor_unavailable"
    {
        // The DCH1 host itself is down - a distinct code, because callers
        // that see only stop_failed spent a day unable to tell a dead host
        // layer from an ordinary stop failure (2026-08-31).
        ClaudeStructuredRuntimeErrorV1::HostAttachFailed
    } else {
        ClaudeStructuredRuntimeErrorV1::StopFailed
    }
}

fn committed_structured_interaction(
    selection: &AgentRuntimeSelectionV1,
    transition: &AgentRuntimeTransitionRecordV1,
    request: &ClaudeStructuredOpenRequestV1,
    provider_id: &ProviderIdV1,
) -> Option<AgentInteractionSessionIdV1> {
    selection.validate().ok()?;
    transition.validate().ok()?;
    let target = transition
        .intent
        .target_selection_at(transition.updated_at_ms)
        .ok()?;
    if selection.agent_id != request.agent_id
        || selection.provider_id != *provider_id
        || selection.interaction_profile != AgentInteractionProfileV1::StructuredProtocol
        || selection.execution_profile != request.execution_profile
        || selection.permission_mode != request.permission_mode
        || selection.model.as_ref() != request.model.as_ref()
        || selection.effort.as_ref() != request.effort.as_ref()
        || transition.state != AgentRuntimeTransitionStateV1::Committed
        || &target != selection
    {
        return None;
    }
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
        transition.target_authority.as_ref()?
    else {
        return None;
    };
    if request
        .provider_conversation_ref
        .as_ref()
        .is_some_and(|expected| binding.provider_conversation_ref.as_ref() != Some(expected))
    {
        return None;
    }
    Some(binding.interaction_session_id.clone())
}

fn map_conversation_error(error: AgentConversationErrorV1) -> ClaudeStructuredRuntimeErrorV1 {
    match error {
        AgentConversationErrorV1::Store(
            DomainStoreErrorV1::IdentityConflict { .. }
            | DomainStoreErrorV1::IdempotencyConflict { .. },
        ) => ClaudeStructuredRuntimeErrorV1::RuntimeConflict,
        AgentConversationErrorV1::Store(
            DomainStoreErrorV1::InvalidRecord { .. } | DomainStoreErrorV1::NotFound { .. },
        ) => ClaudeStructuredRuntimeErrorV1::RequestInvalid,
        AgentConversationErrorV1::Store(_)
        | AgentConversationErrorV1::Provider(_)
        | AgentConversationErrorV1::Clock => ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable,
    }
}

fn recorded_failure_error(
    failure: &ClaudeStructuredRecordedFailureV1,
) -> ClaudeStructuredRuntimeErrorV1 {
    match failure {
        ClaudeStructuredRecordedFailureV1::HostAttach { .. } => {
            ClaudeStructuredRuntimeErrorV1::HostAttachRecoveryRequired
        }
        ClaudeStructuredRecordedFailureV1::RelayReadiness => {
            ClaudeStructuredRuntimeErrorV1::RelayReadinessRecoveryRequired
        }
        ClaudeStructuredRecordedFailureV1::ManagedCreateNormalizationRequired
        | ClaudeStructuredRecordedFailureV1::ManagedCreateRetiredExact
        | ClaudeStructuredRecordedFailureV1::ManagedCreateRejected => {
            ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryRequired
        }
    }
}

fn replacement_failure_is_quiescent(error: ClaudeStructuredRuntimeErrorV1) -> bool {
    matches!(
        error,
        ClaudeStructuredRuntimeErrorV1::CredentialUnavailable
            | ClaudeStructuredRuntimeErrorV1::CredentialStale
            | ClaudeStructuredRuntimeErrorV1::HostAttachFailed
            | ClaudeStructuredRuntimeErrorV1::RelayReadinessFailed
            | ClaudeStructuredRuntimeErrorV1::HostAttachRecoveryRequired
            | ClaudeStructuredRuntimeErrorV1::RelayReadinessRecoveryRequired
            | ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryRequired
    )
}

fn relay_arguments(
    relay_executable: &Path,
    endpoint: &Path,
    capability_file: &Path,
    binding: &AgentInteractionBindingV1,
    relay_id: &str,
) -> Vec<String> {
    [
        relay_executable.to_string_lossy().into_owned(),
        "--endpoint".into(),
        endpoint.to_string_lossy().into_owned(),
        "--capability-file".into(),
        capability_file.to_string_lossy().into_owned(),
        "--runtime-generation".into(),
        binding.runtime.runtime_generation.clone(),
        "--query-epoch".into(),
        binding.runtime.provider_epoch.clone(),
        "--relay-id".into(),
        relay_id.into(),
    ]
    .into()
}

async fn create_managed_relay(
    configuration: &ClaudeStructuredRuntimeConfiguration,
    binding: &AgentInteractionBindingV1,
    workspace_id: &str,
    cwd: &Path,
    files: &ClaudeRuntimeFiles,
    journal: &ClaudeRuntimeLaunchJournalV1,
) -> Result<ManagedRelayCreateOutcome, ClaudeStructuredRuntimeErrorV1> {
    let (source_session_id, source_idempotency_key) = journal
        .effective_managed_create_identity(&files.relay_session_id, &files.create_idempotency_key);
    let mut request = ManagedCreateRequest::new(
        source_idempotency_key,
        source_session_id,
        workspace_id,
        CLAUDE_PROVIDER_ID,
        PermissionMode::Default,
        cwd,
        relay_arguments(
            &configuration.relay_executable,
            &files.endpoint,
            &files.capability_file,
            binding,
            &files.relay_id,
        ),
        24,
        80,
    )
    .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
    if let Some(conversation_id) = binding.provider_conversation_ref.as_deref() {
        request = request
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new(CLAUDE_PROVIDER_ID, conversation_id)
                    .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?,
            )
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
    }
    request = request
        .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
    let creator = ManagedSessionCreator::new(&configuration.hmux_runtime)
        .with_discovery_root(&configuration.discovery_root);
    let resolution =
        tokio::task::spawn_blocking(move || creator.create_or_reconcile_and_advance(request))
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryPending)?;
    match resolution {
        Ok(
            ManagedCreateAdvanceResolution::Current(created)
            | ManagedCreateAdvanceResolution::Advanced(created),
        ) => {
            let identity = ClaudeManagedCreateIdentityV1::new(
                &files.relay_session_id,
                &files.create_idempotency_key,
                created.receipt().session_id(),
                created.receipt().idempotency_key(),
            )?;
            Ok(ManagedRelayCreateOutcome::Created {
                descriptor: Box::new(created.session().descriptor().clone()),
                identity,
            })
        }
        Ok(
            ManagedCreateAdvanceResolution::Pending
            | ManagedCreateAdvanceResolution::AuthorityUnavailable(_),
        ) => Ok(ManagedRelayCreateOutcome::RecoveryPending),
        Err(error) => match error.disposition() {
            ManagedCreateFailureDisposition::Rejected => Ok(ManagedRelayCreateOutcome::Rejected),
            ManagedCreateFailureDisposition::Retryable => {
                Err(ClaudeStructuredRuntimeErrorV1::RelayLaunchFailed)
            }
        },
    }
}

async fn resolve_managed_relay_for_stop(
    configuration: &ClaudeStructuredRuntimeConfiguration,
    workspace_id: &str,
    files: &ClaudeRuntimeFiles,
    journal: &ClaudeRuntimeLaunchJournalV1,
) -> ManagedRelayIdentityOutcome {
    let (session_id, idempotency_key) = journal
        .effective_managed_create_identity(&files.relay_session_id, &files.create_idempotency_key);
    let request =
        match ManagedCreateReconcileRequest::new(idempotency_key, session_id, workspace_id) {
            Ok(request) => request,
            Err(_) => return ManagedRelayIdentityOutcome::RecoveryPending,
        };
    let creator = ManagedSessionCreator::new(&configuration.hmux_runtime)
        .with_discovery_root(&configuration.discovery_root);
    match tokio::task::spawn_blocking(move || creator.claim_successor_chain_cleanup(request)).await
    {
        Ok(Ok(ManagedCreateChainResolution::Existing(existing))) => {
            let descriptor = existing.session().descriptor();
            if descriptor.provider_id == CLAUDE_PROVIDER_ID {
                match ClaudeManagedCreateIdentityV1::new(
                    &files.relay_session_id,
                    &files.create_idempotency_key,
                    existing.receipt().session_id(),
                    existing.receipt().idempotency_key(),
                ) {
                    Ok(identity) => ManagedRelayIdentityOutcome::Existing {
                        descriptor: Box::new(descriptor.clone()),
                        identity,
                    },
                    Err(_) => ManagedRelayIdentityOutcome::RecoveryPending,
                }
            } else {
                ManagedRelayIdentityOutcome::RecoveryPending
            }
        }
        Ok(Ok(ManagedCreateChainResolution::NotFound)) => ManagedRelayIdentityOutcome::NotFound,
        Ok(Ok(ManagedCreateChainResolution::TerminalWithoutSuccessor)) => {
            ManagedRelayIdentityOutcome::Terminal
        }
        Ok(Ok(ManagedCreateChainResolution::Pending)) | Ok(Err(_)) | Err(_) => {
            ManagedRelayIdentityOutcome::RecoveryPending
        }
    }
}

fn runtime_files(
    configuration: &ClaudeStructuredRuntimeConfiguration,
    binding: &AgentInteractionBindingV1,
) -> Result<ClaudeRuntimeFiles, ClaudeStructuredRuntimeErrorV1> {
    let identity = runtime_identity(binding);
    let runtime_directory = configuration.state_root.join(format!("r.{identity}"));
    let endpoint = configuration
        .address_root
        .join(format!("r.{identity}"))
        .join("relay.sock");
    if endpoint.as_os_str().as_bytes().len() >= 100 {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable);
    }
    Ok(ClaudeRuntimeFiles {
        capability_file: runtime_directory.join("relay-capability"),
        create_idempotency_key: format!("claude-chat-create-{identity}"),
        endpoint,
        relay_id: format!("relay-{identity}"),
        relay_session_id: format!("claude-chat-{identity}"),
        runtime_directory,
    })
}

fn runtime_directory_for_query(
    configuration: &ClaudeStructuredRuntimeConfiguration,
    interaction_session_id: &AgentInteractionSessionIdV1,
    identity: &ClaudeDch1QueryIdentity,
) -> Result<PathBuf, ClaudeStructuredRuntimeErrorV1> {
    identity
        .validate()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
    let digest = Sha256::digest(
        format!(
            "claude-structured-runtime/v1\0{interaction_session_id}\0{}\0{}",
            identity.runtime_generation, identity.query_epoch,
        )
        .as_bytes(),
    );
    let runtime_directory = configuration
        .state_root
        .join(format!("r.{}", &format!("{digest:x}")[..24]));
    let expected_relay = format!("relay-{}", &format!("{digest:x}")[..24]);
    if identity.relay_id != expected_relay {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
    }
    Ok(runtime_directory)
}

fn replacement_runtime(
    interaction_session_id: &AgentInteractionSessionIdV1,
    source: &AgentProviderRuntimeFenceV1,
    backend_generation: &str,
) -> AgentProviderRuntimeFenceV1 {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "claude-runtime-replacement/v1\0{interaction_session_id}\0{}\0{}\0{backend_generation}",
                source.runtime_generation, source.provider_epoch,
            )
            .as_bytes(),
        )
    );
    AgentProviderRuntimeFenceV1 {
        runtime_generation: format!("claude-runtime-{}", &digest[..24]),
        provider_epoch: format!("claude-query-{}", &digest[24..48]),
    }
}

fn replacement_runtime_for_operation(
    interaction_session_id: &AgentInteractionSessionIdV1,
    source: &AgentProviderRuntimeFenceV1,
    operation_id: &OperationIdV1,
) -> AgentProviderRuntimeFenceV1 {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "claude-runtime-transition-replacement/v1\0{interaction_session_id}\0{}\0{}\0{}",
                source.runtime_generation,
                source.provider_epoch,
                operation_id.as_str(),
            )
            .as_bytes(),
        )
    );
    AgentProviderRuntimeFenceV1 {
        runtime_generation: format!("claude-runtime-{}", &digest[..24]),
        provider_epoch: format!("claude-query-{}", &digest[24..48]),
    }
}

fn transition_target_effect_operation_id(
    transition: &AgentRuntimeTransitionRecordV1,
) -> &OperationIdV1 {
    transition
        .last_repair_operation_id
        .as_ref()
        .unwrap_or(&transition.intent.operation_id)
}

fn runtime_query_identity(
    configuration: &ClaudeStructuredRuntimeConfiguration,
    binding: &AgentInteractionBindingV1,
) -> Result<ClaudeDch1QueryIdentity, ClaudeStructuredRuntimeErrorV1> {
    let files = runtime_files(configuration, binding)?;
    Ok(ClaudeDch1QueryIdentity {
        runtime_generation: binding.runtime.runtime_generation.clone(),
        query_epoch: binding.runtime.provider_epoch.clone(),
        relay_id: files.relay_id,
    })
}

fn predecessor_binding(
    target: &AgentInteractionBindingV1,
    source: &ClaudeDch1QueryIdentity,
) -> Result<AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
    let mut binding = target.clone();
    binding.runtime = AgentProviderRuntimeFenceV1 {
        runtime_generation: source.runtime_generation.clone(),
        provider_epoch: source.query_epoch.clone(),
    };
    binding.binding_revision = binding.binding_revision.saturating_sub(1).max(1);
    let expected = runtime_query_identity_for_binding(&binding)?;
    if expected != *source {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
    }
    Ok(binding)
}

fn runtime_query_identity_for_binding(
    binding: &AgentInteractionBindingV1,
) -> Result<ClaudeDch1QueryIdentity, ClaudeStructuredRuntimeErrorV1> {
    let identity = runtime_identity(binding);
    Ok(ClaudeDch1QueryIdentity {
        runtime_generation: binding.runtime.runtime_generation.clone(),
        query_epoch: binding.runtime.provider_epoch.clone(),
        relay_id: format!("relay-{identity}"),
    })
}

fn is_exact_replacement_target(
    candidate: &AgentInteractionBindingV1,
    failed: &AgentInteractionBindingV1,
    request: &ClaudeStructuredOpenRequestV1,
    target_runtime: &AgentProviderRuntimeFenceV1,
    target_revision: i64,
) -> bool {
    candidate.schema_version == failed.schema_version
        && candidate.interaction_session_id == failed.interaction_session_id
        && candidate.agent_id == failed.agent_id
        && candidate.provider_id == failed.provider_id
        && candidate.execution_profile == request.execution_profile
        && replacement_target_conversation_matches(
            request.provider_conversation_ref.as_deref(),
            candidate.provider_conversation_ref.as_deref(),
            target_revision,
            candidate.binding_revision,
        )
        && &candidate.runtime == target_runtime
        && candidate.timeline_epoch == failed.timeline_epoch
        && candidate.history_complete == failed.history_complete
        && candidate.created_at_ms == failed.created_at_ms
        && candidate.updated_at_ms >= failed.updated_at_ms
}

fn read_owner_capability(path: &Path) -> Result<Option<String>, ClaudeStructuredRuntimeErrorV1> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || !(16..=256).contains(&metadata.len())
    {
        return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
    }
    let capability = String::from_utf8(
        fs::read(path).map_err(|_| ClaudeStructuredRuntimeErrorV1::JournalFailed)?,
    )
    .map_err(|_| ClaudeStructuredRuntimeErrorV1::JournalFailed)?;
    if !safe_token(&capability) {
        return Err(ClaudeStructuredRuntimeErrorV1::JournalFailed);
    }
    Ok(Some(capability))
}

fn relay_is_ready(endpoint: &Path) -> bool {
    fs::symlink_metadata(endpoint).is_ok_and(|metadata| metadata.file_type().is_socket())
}

fn relay_generation_is_absent(
    descriptor: &SessionDescriptor,
) -> Result<bool, ClaudeStructuredRuntimeErrorV1> {
    for process in [&descriptor.host_process, &descriptor.provider_process] {
        if probe_local_process_generation(process)
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?
            != LocalProcessGenerationStatus::Absent
        {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn wait_for_relay(endpoint: &Path) -> Result<(), ()> {
    let deadline = Instant::now() + RELAY_READY_TIMEOUT;
    loop {
        if relay_is_ready(endpoint) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn now_ms() -> Result<i64, ClaudeStructuredRuntimeErrorV1> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
    i64::try_from(duration.as_millis())
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)
}

async fn stop_exact(
    configuration: &ClaudeStructuredRuntimeConfiguration,
    cwd: &Path,
    descriptor: &SessionDescriptor,
    idempotency_prefix: &str,
) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
    let idempotency_key = format!("{idempotency_prefix}-{}", exact_stop_identity(descriptor));
    let channel_epoch = descriptor
        .channel_epoch
        .parse()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
    let request = ManagedStopRequest::new(
        idempotency_key,
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
    })
    .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
    let stopper = ManagedSessionStopper::new(&configuration.hmux_runtime, cwd)
        .with_discovery_root(&configuration.discovery_root);
    let deadline = Instant::now() + EXACT_STOP_RECONCILE_TIMEOUT;
    let receipt = loop {
        let stopper = stopper.clone();
        let request = request.clone();
        let result = tokio::task::spawn_blocking(move || stopper.stop(request))
            .await
            .map_err(|_| ClaudeStructuredRuntimeErrorV1::StopFailed)?;
        match result {
            Ok(receipt) => break receipt,
            Err(error)
                if error.code() == "hmux_managed_stop_outcome_unknown"
                    && Instant::now() < deadline =>
            {
                tokio::time::sleep(EXACT_STOP_RECONCILE_INTERVAL).await;
            }
            Err(_) => return Err(ClaudeStructuredRuntimeErrorV1::StopFailed),
        }
    };
    if !matches!(
        receipt.outcome(),
        ManagedStopOutcome::Stopped | ManagedStopOutcome::AlreadyExited
    ) {
        return Err(ClaudeStructuredRuntimeErrorV1::StopFailed);
    }
    let deadline = Instant::now() + EXACT_STOP_RECONCILE_TIMEOUT;
    loop {
        if relay_generation_is_absent(descriptor)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ClaudeStructuredRuntimeErrorV1::StopFailed);
        }
        tokio::time::sleep(EXACT_STOP_RECONCILE_INTERVAL).await;
    }
}

async fn stop_exact_or_confirm_absent(
    configuration: &ClaudeStructuredRuntimeConfiguration,
    cwd: &Path,
    descriptor: &SessionDescriptor,
    idempotency_prefix: &str,
) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
    match stop_exact(configuration, cwd, descriptor, idempotency_prefix).await {
        Ok(()) => Ok(()),
        Err(_) if relay_generation_is_absent(descriptor)? => Ok(()),
        Err(error) => Err(error),
    }
}

fn write_owner_file(path: &Path, source: &[u8]) -> Result<(), ClaudeStructuredRuntimeErrorV1> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
    file.write_all(source)
        .and_then(|_| file.sync_all())
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)
}

fn random_capability() -> Result<String, ClaudeStructuredRuntimeErrorV1> {
    Ok(format!("claude-relay-{}", random_hex::<32>()?))
}

fn random_hex<const N: usize>() -> Result<String, ClaudeStructuredRuntimeErrorV1> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn runtime_identity(binding: &AgentInteractionBindingV1) -> String {
    let digest = Sha256::digest(
        format!(
            "claude-structured-runtime/v1\0{}\0{}\0{}",
            binding.interaction_session_id,
            binding.runtime.runtime_generation,
            binding.runtime.provider_epoch,
        )
        .as_bytes(),
    );
    format!("{digest:x}")[..24].into()
}

fn exact_stop_identity(descriptor: &SessionDescriptor) -> String {
    let digest = Sha256::digest(
        format!(
            "claude-structured-stop/v1\0{}\0{}\0{}\0{}\0{}",
            descriptor.session_id,
            descriptor.runner_instance,
            descriptor.channel_epoch,
            descriptor.host_instance_id,
            descriptor.terminal_epoch,
        )
        .as_bytes(),
    );
    format!("{digest:x}")[..24].into()
}

fn exact_executable(path: &Path) -> Result<PathBuf, ClaudeStructuredRuntimeErrorV1> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o111 == 0
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable);
    }
    path.canonicalize()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)
}

fn exact_owner_directory(path: &Path) -> Result<PathBuf, ClaudeStructuredRuntimeErrorV1> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable);
    }
    path.canonicalize()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable)
}

fn exact_directory(path: &Path) -> Result<PathBuf, ClaudeStructuredRuntimeErrorV1> {
    if !path.is_absolute() {
        return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
    if !canonical.is_dir() {
        return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid);
    }
    Ok(canonical)
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
mod managed_create_tests;
#[cfg(test)]
mod tests;
