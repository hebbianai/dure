mod agent_checkpoint_binding;
pub mod agent_conversation;
pub mod agent_conversation_api;
#[cfg(unix)]
mod agent_conversation_recover;
#[cfg(unix)]
mod agent_dispatch_stop_apply;
mod agent_operation_lock;
#[cfg(unix)]
mod agent_runtime_api;
#[cfg(unix)]
mod agent_runtime_native_io;
#[cfg(unix)]
mod agent_runtime_checkout;
#[cfg(unix)]
mod agent_runtime_close_apply;
#[cfg(unix)]
mod agent_runtime_native_rehost;
#[cfg(unix)]
mod agent_runtime_projection;
#[cfg(unix)]
mod agent_runtime_projection_context;
#[cfg(unix)]
mod agent_runtime_recovery;
#[cfg(unix)]
mod agent_runtime_remove_apply;
#[cfg(unix)]
mod agent_runtime_stop_boundary;
#[cfg(unix)]
mod agent_runtime_transition_apply;
mod agent_spawn_api;
mod agent_spawn_preview;
mod agent_spawn_worktree;
use agent_spawn_preview::preview_agent_spawn;
mod agent_spawn_apply;
mod agent_spawn_records;
#[cfg(unix)]
mod agent_spawn_structured;
mod agent_spawn_support;
mod backend_runtime_root;
#[cfg(unix)]
pub mod browser_engine;
#[cfg(unix)]
mod browser_service;
#[cfg(unix)]
pub mod claude_conversation_host;
#[cfg(unix)]
pub mod claude_process_relay;
#[cfg(unix)]
pub mod claude_sdk_host_client;
#[cfg(unix)]
pub mod claude_sdk_host_supervisor;
#[cfg(unix)]
pub mod claude_structured_runtime;
#[cfg(unix)]
pub mod claude_timeline_bridge;
#[cfg(unix)]
mod codex_app_server_protocol;
#[cfg(unix)]
pub mod codex_connection_driver;
#[cfg(unix)]
mod codex_connection_driver_protocol;
#[cfg(unix)]
mod codex_structured_connection;
#[cfg(unix)]
mod codex_timeline_bridge;
mod hmux_session_inspection;
mod interaction_wake;
#[cfg(unix)]
pub mod managed_claude_hook;
#[cfg(unix)]
mod json_rpc_socket_client;
#[cfg(all(test, unix))]
mod managed_create_recovery_test_support;
#[cfg(unix)]
mod managed_provider_connection;
#[cfg(unix)]
mod managed_structured_runtime;
pub mod mcp_stdio_relay;
#[cfg(unix)]
pub mod opencode_connection_driver;
#[cfg(unix)]
mod opencode_session_client;
#[cfg(unix)]
mod opencode_timeline_bridge;
mod orchestration_context_batch;
mod orchestration_event_batch;
mod orchestration_event_inspection;
mod orchestration_invoke;
mod pro_features;
#[cfg(unix)]
mod workspace_environment;
#[cfg(unix)]
mod backend_scope;
#[cfg(unix)]
mod agent_goal;
#[cfg(unix)]
mod slack_connector;
#[cfg(unix)]
pub mod pi_connection_driver;
#[cfg(unix)]
mod pi_session_client;
#[cfg(unix)]
mod pi_timeline_bridge;
#[cfg(unix)]
mod private_driver_socket;
mod private_record;
mod project_catalog;
mod provider_commands;
pub mod provider_credential_profile;
mod provider_executable;
use provider_executable::resolve_provider_executable;
mod provider_model_catalog;
mod provider_permission;
#[cfg(unix)]
mod provider_timeline_journal;
#[cfg(unix)]
mod provider_turn_settings;
mod request_execution;
mod schedule_runtime;
mod workflow_graph;
use orchestration_invoke::invoke_orchestration;
mod service_lifecycle;
#[cfg(unix)]
mod structured_provider_composition;
#[cfg(unix)]
mod structured_provider_runtime;
mod workspace_git;

#[cfg(unix)]
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_orchestration::contract::{
    AnswerDecisionReceipt, AnswerDecisionRequest, CompleteDispatchRequest, CreateRunRequest,
    DispatchContextReceipt, GetInteractionRequest, InteractionDraft, InteractionDraftCommon,
    ORCHESTRATION_API_VERSION, OpenInteractionRequest, ServiceError,
};
use agent_orchestration::domain::{
    Audience, AudienceGrant, CapabilityRef, ChannelEpochRef, DecisionAnswer, HostInstanceRef,
    IntegrationCapabilityReceipt, InteractionId, InteractionTarget, MembershipRef, MessagePurpose,
    ParticipantRef, ProviderRef, Revision, RoleRef, RunTaskSpec, RunnerInstanceRef,
    RunnerPrincipalRef, RuntimeRef, SessionIdentityRef, SessionRef, TargetReferenceRef,
    TerminalEpochRef, WorkerEndpointFence, WorkerEndpointRef, WorkerSessionGeneration,
    WorkflowKindRef, WorkspaceId,
};
use agent_orchestration::service::{create_run_target, worker_session_identity};
use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
    AGENT_SPAWN_SCHEMA_VERSION_V1, AGENT_TIMELINE_SCHEMA_VERSION_V1,
    AgentCheckpointBindingAuthorityV1, AgentCheckpointIdentityV1, AgentCheckpointRecordV1,
    AgentCheckpointWriteRequestV1, AgentExecutionProfileV1, AgentIdV1,
    AgentProviderConversationPlanV1, AgentProviderRegistry, AgentRuntimeTransitionStore,
    AgentSpawnEffortSelectionV1, AgentSpawnInteractionPreferenceV1, AgentSpawnLaunchPlanV1,
    AgentSpawnModelSelectionV1, AgentSpawnPreviewIntentV1, AgentSpawnPromptDigestV1,
    AgentSpawnWorktreePolicyV1, AgentTimelineStore, CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
    ClientViewGenerationAdvanceRequestV1, ClientViewIdentityV1, ClientViewNamespaceV1,
    ClientViewWriteRequestV1, DELEGATE_ONCE_SCHEMA_VERSION_V1, DelegateOnceCompletionRequestV1,
    DelegateOncePromptActivityRequestV1, DelegateOncePromptClaimRequestV1,
    DelegateOncePromptOutcomeRequestV1, DelegateOnceReceiptV1, DelegateOnceRequestV1,
    DelegateOnceSessionBindingRequestV1, DelegateOnceStartFailureRequestV1, DispatchIdV1,
    DomainStore, DomainStoreErrorV1, PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1, ProjectIdV1,
    ProviderIdV1, ProviderLaunchDefaultsPutRequestV1, ProviderLaunchPermissionOverrideV1,
    ProviderPermissionModeV1, RuntimeAdapterRegistry, RuntimeKindIdV1,
    RuntimeSessionProbeReceiptV1, TaskIdV1, WorkflowDispatchStateV1,
    WorkflowEffectiveLaunchRepairRequestV1, WorkflowPromptActivityObservationRequestV1,
    WorkflowPromptActivityObserver, WorkflowPromptActivityReceiptV1, WorkflowPromptActivityStateV1,
    WorkflowPromptDeliverer, WorkflowPromptDeliveryIntentV1, WorkflowPromptDeliveryOutcomeV1,
    WorkflowPromptDeliveryRequestV1, WorkflowPromptDeliveryStateV1, WorkflowSessionGenerationV1,
    WorkflowSessionLaunchFailureDispositionV1, WorkflowSessionLaunchRequestV1,
    WorkflowSessionPrelaunchCommandV1, WorkflowStore, WorkspaceIdV1, prepare_delegate_once,
    prepare_delegate_once_handoff,
};
use dure_app_sqlite::{
    OrchestrationDispatchContextRequestV1, OrchestrationDispatchGenerationV1,
    OrchestrationDispatchSessionRebindRequestV1, OrchestrationManagedCreateKeyStateV1,
    SqliteDomainStore, orchestration_session_identity,
};
use hmux_client::{
    ManagedRehostResolution, PermissionMode as HmuxPermissionMode,
    recovery_journal::managed_create_ledger::completed_create_receipt,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify, Semaphore};
use tokio::time::{Duration, timeout};

use project_catalog::{
    load_project_catalog, register_project, valid_project_id, valid_project_path,
};
mod control_plane_build_identity;
mod provider_extension;
mod runtime_extension;
mod workflow_launch;

use control_plane_build_identity::{
    capabilities as control_plane_capabilities, current_build_id as control_plane_build_id,
    identity_api_version as control_plane_identity_api_version,
    identity_kind as control_plane_identity_kind,
};
use hmux_session_inspection::{
    ExpectedHmuxSession, HmuxSessionInspection, HmuxSessionInspectionFailure,
    parse_exact_hmux_session, parse_exact_hmux_session_for_transition,
};
pub use service_lifecycle::{
    ActivateStagedOptions, ControlPlaneEndpoint, PreparedControlPlane, activate_staged,
    prepare_with_agent_conversation_runtimes, serve,
};

const BACKEND_ID: &str = "dure-local";
const BACKEND_PROTOCOL_API: &str = "dure.backend-transport/v1";
const BACKEND_REQUEST_KIND: &str = "dure.backend.request";
const BACKEND_RESPONSE_KIND: &str = "dure.backend.response";
const BACKEND_ERROR_KIND: &str = "dure.backend.error";
const SERVICE_DESCRIPTOR_SCHEMA_VERSION: u16 = 5;
const CURRENT_SESSION_TARGET_REFERENCE: &str = "orchestration.current-session";
const HMUX_RUNTIME_KIND_ID: &str = "runtime.hmux";
const MAX_REQUEST_BYTES: u64 = 256 * 1024;
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HMUX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_HMUX_SESSION_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_HMUX_SESSION_CATALOG_BYTES: usize = 960 * 1024;
const MAX_PROJECT_QUERY_ITEMS: usize = 128;
const MAX_SESSION_ITEMS: usize = 128;
const MAX_SESSION_READ_LINES: usize = 512;
const MAX_SESSION_PROBE_BUDGET_MS: u64 = 10_000;
const MAX_LOCAL_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;
const HMUX_QUERY_TIMEOUT: Duration = Duration::from_millis(2_500);
#[cfg(test)]
static HMUX_TEST_QUERY_LOCK: Mutex<()> = Mutex::const_new(());
const REQUEST_IO_TIMEOUT: Duration = Duration::from_secs(2);
const PERSISTENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
// Response deadlines bound client waiting. request_execution keeps admitted,
// durable effects alive so a disconnect cannot leave their journaled state
// half-applied. The larger budget still avoids needless retry traffic on a
// loaded machine (owner decision 2026-09-01).
const REQUEST_DEADLINE: Duration = Duration::from_secs(20);
const WORKFLOW_REQUEST_DEADLINE: Duration = Duration::from_secs(180);
const MAX_ACTIVE_REQUESTS: usize = 16;
const MAX_ACTIVE_SUBSCRIPTIONS: usize = 64;
// Long-lived observers must not consume the admission budget ordinary framed
// requests need to inspect, mutate, or close those same conversations.
const MAX_ACTIVE_CONNECTIONS: usize = MAX_ACTIVE_SUBSCRIPTIONS + MAX_ACTIVE_REQUESTS;
const PERSISTENT_CONNECTION_CAPABILITY: &str = "backend.connection.persistent";
const PERSISTENT_CONNECTION_MODE: &str = "persistent_v1";
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneIdentityV1 {
    pub schema_version: u32,
    pub api_version: &'static str,
    pub kind: &'static str,
    pub build_id: &'static str,
    pub capabilities: Vec<&'static str>,
}

pub fn control_plane_identity() -> ControlPlaneIdentityV1 {
    ControlPlaneIdentityV1 {
        schema_version: 1,
        api_version: control_plane_identity_api_version(),
        kind: control_plane_identity_kind(),
        build_id: control_plane_build_id(),
        capabilities: control_plane_capabilities()
            .iter()
            .map(String::as_str)
            .collect(),
    }
}

#[derive(Clone, Debug)]
pub struct ServeOptions {
    pub home: PathBuf,
    pub hmux_bin: PathBuf,
    pub hmux_runtime_bin: PathBuf,
    pub hmux_discovery_root: PathBuf,
    #[cfg(unix)]
    pub claude_structured_runtime: Option<ClaudeStructuredRuntimeOptions>,
    pub launch_executable: Option<PathBuf>,
    pub expected_generation: Option<String>,
    pub activation_source_generation: Option<String>,
    pub staged: bool,
}

#[cfg(unix)]
#[derive(Clone, Debug)]
pub struct ClaudeStructuredRuntimeOptions {
    pub node_bin: PathBuf,
    pub host_entrypoint: PathBuf,
    pub relay_bin: PathBuf,
    pub runtime_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlanePreflightV1 {
    pub schema_version: u16,
    pub kind: &'static str,
    pub build_id: &'static str,
    pub descriptor_schema_version: u16,
    pub hmux_identity: HmuxToolchainIdentity,
}

#[derive(Clone, Debug)]
pub struct GatewayOptions {
    pub socket_path: PathBuf,
    pub expected_generation: String,
}

#[derive(Debug)]
pub enum ControlPlaneError {
    Io(io::Error),
    Invalid(&'static str),
    Message(String),
}

impl std::fmt::Display for ControlPlaneError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Invalid(message) => formatter.write_str(message),
            Self::Message(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ControlPlaneError {}

impl From<io::Error> for ControlPlaneError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtocolVersion {
    major: u16,
    minor: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedProtocol {
    minimum: ProtocolVersion,
    maximum: ProtocolVersion,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedBackend {
    backend_id: String,
    generation: String,
    #[serde(default)]
    scope_id: Option<String>,
    protocol: ExpectedProtocol,
    required_capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendRequest {
    schema_version: u16,
    api_version: String,
    kind: String,
    request_id: String,
    operation: String,
    expected: ExpectedBackend,
    body: Value,
    #[serde(default)]
    connection: Option<BackendConnection>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendConnection {
    mode: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendShutdownBody {
    schema_version: u16,
    mode: String,
    #[serde(default)]
    target: Option<BackendShutdownTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendShutdownTarget {
    generation: String,
    build_id: String,
    control_plane_identity: LocalExecutableIdentity,
    hmux_identity: HmuxToolchainIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalExecutableIdentity {
    executable_path: PathBuf,
    executable_device: String,
    executable_inode: String,
    executable_size: String,
    executable_modified: String,
    executable_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedReplacementIntent {
    schema_version: u16,
    kind: String,
    source: PersistedReplacementSource,
    target: BackendShutdownTarget,
    created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedReplacementSource {
    generation: String,
    build_id: Option<String>,
    hmux_identity: Option<HmuxToolchainIdentity>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HmuxStopFence {
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingEnsureBody {
    schema_version: u16,
    agent_id: AgentIdV1,
    session_id: String,
    workspace_id: String,
    display_name: String,
    worktree_path: String,
    stop_fence: HmuxStopFence,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObserveBody {
    schema_version: u16,
    agent_ids: Vec<AgentIdV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionsListBody {
    schema_version: u16,
    probe_budget_ms: u64,
    max_items: usize,
    #[serde(default)]
    prioritized: Vec<SessionsListPriority>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionsListPriority {
    session_id: String,
    workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HmuxSessionCatalog {
    schema_version: u16,
    complete: bool,
    prioritized_items: usize,
    sessions: Vec<Value>,
    truncation: HmuxSessionCatalogTruncation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HmuxSessionCatalogTruncation {
    items: bool,
    omitted_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionsShowBody {
    schema_version: u16,
    session_id: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionsReadBody {
    schema_version: u16,
    session_id: String,
    workspace_id: String,
    lines: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HmuxReadPayload {
    ok: bool,
    sequence_through: String,
    lines: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegateOnceCompleteBody {
    schema_version: u16,
    task_id: TaskIdV1,
    dispatch_id: DispatchIdV1,
    generation: i64,
    session: WorkflowSessionGenerationV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegateOnceShowBody {
    schema_version: u16,
    task_id: TaskIdV1,
    dispatch_id: DispatchIdV1,
    generation: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestrationInvokeBody {
    api_version: String,
    method: String,
    body: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestrationContextBody {
    schema_version: u16,
    #[serde(default)]
    target: Option<InteractionTarget>,
    session: WorkflowSessionGenerationV1,
    integration_receipt: IntegrationCapabilityReceipt,
    idempotency_key: String,
    resolved_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestrationContextGetBody {
    schema_version: u16,
    session: WorkflowSessionGenerationV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestrationDispatchSessionReconcileBody {
    schema_version: u16,
    expected: OrchestrationDispatchGenerationV1,
    target: WorkflowSessionGenerationV1,
    reconciled_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExactSessionMessageOpenBody {
    schema_version: u16,
    session: WorkflowSessionGenerationV1,
    expected_endpoint_ref: String,
    idempotency_key: String,
    interaction_id: String,
    title: String,
    description_markdown: String,
    opened_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExactSessionDecisionAnswerBody {
    schema_version: u16,
    session: WorkflowSessionGenerationV1,
    expected_dispatch_revision: Revision,
    expected_reply_capability: String,
    idempotency_key: String,
    interaction_id: InteractionId,
    expected_revision: Revision,
    answer: DecisionAnswer,
    answered_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunCreateBody {
    schema_version: u16,
    workflow_kind_ref: WorkflowKindRef,
    task: RunTaskSpec,
    session: WorkflowSessionGenerationV1,
    integration_receipt: IntegrationCapabilityReceipt,
    runtime_ref: RuntimeRef,
    target_reference: TargetReferenceRef,
    idempotency_key: String,
    created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectsListBody {
    schema_version: u16,
    max_items: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectsShowBody {
    schema_version: u16,
    project_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectsRegisterBody {
    schema_version: u16,
    project_id: String,
    display_name: String,
    root: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceDescriptor {
    schema_version: u16,
    backend_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    build_id: Option<String>,
    generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    activation_source_generation: Option<String>,
    socket_path: PathBuf,
    database_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    control_plane_identity: Option<LocalExecutableIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_executable_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_executable_device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_executable_inode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_executable_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_executable_modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_executable_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_runtime_executable_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_runtime_executable_device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_runtime_executable_inode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_runtime_executable_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_runtime_executable_modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_runtime_executable_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_discovery_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_discovery_device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hmux_discovery_inode: Option<String>,
    process_id: u32,
    observed_at_ms: i64,
}

struct ServiceState {
    scope_id: String,
    #[cfg(unix)]
    browser: browser_service::BrowserService,
    #[cfg(unix)]
    slack: slack_connector::SlackConnectorService,
    descriptor: ServiceDescriptor,
    canonical_descriptor_path: PathBuf,
    hmux_identity: HmuxToolchainIdentity,
    projects_catalog_path: PathBuf,
    agent_providers: Arc<AgentProviderRegistry>,
    runtime_adapters: Arc<RuntimeAdapterRegistry>,
    credential_aware_workflow_launcher:
        Arc<dyn workflow_launch::CredentialAwareWorkflowSessionLauncher>,
    workflow_prompt_deliverer: Arc<dyn WorkflowPromptDeliverer>,
    workflow_prompt_activity_observer: Arc<dyn WorkflowPromptActivityObserver>,
    workspace_acquirer: Arc<dyn workspace_git::WorkspaceAcquirer>,
    store: Arc<SqliteDomainStore>,
    credential_profiles:
        Arc<provider_credential_profile::ProviderCredentialProfileRegistry<SqliteDomainStore>>,
    #[cfg(unix)]
    claude_runtime:
        Option<Arc<claude_structured_runtime::ClaudeStructuredRuntimeManager<SqliteDomainStore>>>,
    #[cfg(unix)]
    structured_runtimes: Arc<structured_provider_runtime::StructuredProviderRuntimeRegistry>,
    agent_conversation_runtimes: Arc<agent_conversation_api::AgentConversationRuntimeRegistry>,
    agent_conversations: Arc<agent_conversation_api::AgentConversationApi<SqliteDomainStore>>,
    agent_operations: agent_operation_lock::AgentOperationLocks,
    agent_runtime_recovery_wake: Notify,
    goal_wakeup: Notify,
    runtime_idle: agent_runtime_transition_apply::deferred::idle::IdleRuntime,
    project_catalog_lock: Mutex<()>,
    workflow_lock: Mutex<()>,
    request_slots: Arc<Semaphore>,
    subscription_slots: Arc<Semaphore>,
    connection_slots: Arc<Semaphore>,
    shutdown: Notify,
}

impl ServiceState {
    async fn wait_for_mutation_authority(&self) {
        // Staged activation is published by another process. Both persisted
        // Slack ingress and goal continuation wait for this same authority.
        while !self.is_mutation_authority() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn is_canonical_authority(&self) -> bool {
        read_descriptor(&self.canonical_descriptor_path)
            .ok()
            .flatten()
            .is_some_and(|descriptor| descriptor == self.descriptor)
    }

    fn is_mutation_authority(&self) -> bool {
        if !self.is_canonical_authority() {
            return false;
        }
        let Some(source_generation) = self.descriptor.activation_source_generation.as_deref()
        else {
            return true;
        };
        let Some(root) = self.canonical_descriptor_path.parent() else {
            return false;
        };
        match fs::symlink_metadata(
            root.join("replacement-intents")
                .join(format!("{source_generation}.json")),
        ) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Ok(_) | Err(_) => false,
        }
    }
}

pub fn decode_gateway_socket_hex(value: &str) -> Result<PathBuf, ControlPlaneError> {
    if value.is_empty() || value.len() > 8 * 1024 || value.len() % 2 != 0 {
        return Err(ControlPlaneError::Invalid(
            "gateway socket encoding is invalid",
        ));
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16);
        let low = (pair[1] as char).to_digit(16);
        let (Some(high), Some(low)) = (high, low) else {
            return Err(ControlPlaneError::Invalid(
                "gateway socket encoding is invalid",
            ));
        };
        decoded.push(((high << 4) | low) as u8);
    }
    let decoded = String::from_utf8(decoded)
        .map_err(|_| ControlPlaneError::Invalid("gateway socket encoding is invalid"))?;
    if decoded.chars().any(char::is_control) {
        return Err(ControlPlaneError::Invalid(
            "gateway socket encoding is invalid",
        ));
    }
    let path = PathBuf::from(decoded);
    if !path.is_absolute() {
        return Err(ControlPlaneError::Invalid(
            "gateway socket path must be absolute",
        ));
    }
    Ok(path)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum BackendFailureDispositionV1 {
    Unassigned,
    StaleGeneration,
    RetrySame,
    Terminal,
}

#[derive(Debug)]
struct BackendDispatchError {
    code: String,
    message: String,
    details: Option<Value>,
    disposition: BackendFailureDispositionV1,
}

impl BackendDispatchError {
    fn terminal(code: &str) -> Self {
        Self::from(code).with_disposition(BackendFailureDispositionV1::Terminal)
    }

    fn with_disposition(mut self, disposition: BackendFailureDispositionV1) -> Self {
        self.disposition = disposition;
        self
    }

    fn stale_as_terminal(mut self) -> Self {
        if matches!(
            self.disposition,
            BackendFailureDispositionV1::Unassigned | BackendFailureDispositionV1::StaleGeneration
        ) {
            self.disposition = BackendFailureDispositionV1::Terminal;
        }
        self
    }
}

impl From<String> for BackendDispatchError {
    fn from(message: String) -> Self {
        let code = message
            .split(':')
            .next()
            .unwrap_or("backend_operation_failed")
            .to_string();
        Self {
            code,
            message,
            details: None,
            disposition: BackendFailureDispositionV1::RetrySame,
        }
    }
}

impl From<&str> for BackendDispatchError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

fn now_ms() -> Result<i64, ControlPlaneError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ControlPlaneError::Invalid("system clock is before the Unix epoch"))?
        .as_millis();
    i64::try_from(value).map_err(|_| ControlPlaneError::Invalid("system clock is out of range"))
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

fn valid_generation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
fn generation_socket_path(root: &Path, generation: &str) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(generation.as_bytes()));
    root.join(format!("cp.{}.sock", &digest[..32]))
}

fn candidate_descriptor_path(root: &Path, generation: &str) -> PathBuf {
    root.join(format!("control-plane.{generation}.candidate.json"))
}

fn descriptor_socket_path_is_valid(root: &Path, descriptor: &ServiceDescriptor) -> bool {
    backend_runtime_root::from_durable(root)
        .and_then(|runtime_root| {
            runtime_root.control_plane_socket(descriptor.schema_version, &descriptor.generation)
        })
        .is_ok_and(|expected| descriptor.socket_path == expected)
}

fn descriptor_hmux_identity(descriptor: &ServiceDescriptor) -> Option<HmuxToolchainIdentity> {
    Some(HmuxToolchainIdentity {
        executable_path: descriptor.hmux_executable_path.clone()?,
        executable_device: descriptor.hmux_executable_device.clone()?,
        executable_inode: descriptor.hmux_executable_inode.clone()?,
        executable_size: descriptor.hmux_executable_size.clone()?,
        executable_modified: descriptor.hmux_executable_modified.clone()?,
        executable_sha256: descriptor.hmux_executable_sha256.clone()?,
        runtime_executable_path: descriptor.hmux_runtime_executable_path.clone()?,
        runtime_executable_device: descriptor.hmux_runtime_executable_device.clone()?,
        runtime_executable_inode: descriptor.hmux_runtime_executable_inode.clone()?,
        runtime_executable_size: descriptor.hmux_runtime_executable_size.clone()?,
        runtime_executable_modified: descriptor.hmux_runtime_executable_modified.clone()?,
        runtime_executable_sha256: descriptor.hmux_runtime_executable_sha256.clone()?,
        discovery_root: descriptor.hmux_discovery_root.clone()?,
        discovery_device: descriptor.hmux_discovery_device.clone()?,
        discovery_inode: descriptor.hmux_discovery_inode.clone()?,
    })
}

fn descriptor_hmux_identity_matches(
    descriptor: &ServiceDescriptor,
    identity: &HmuxToolchainIdentity,
) -> bool {
    descriptor_hmux_identity(descriptor).as_ref() == Some(identity)
}

fn control_plane_build_sequence(build_id: &str) -> Option<u64> {
    if !valid_token(build_id) {
        return None;
    }
    let value = build_id.strip_prefix("dure-control-plane/v")?;
    let (sequence, label) = value.split_once('-')?;
    if sequence.is_empty()
        || sequence.starts_with('0')
        || label.is_empty()
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    sequence.parse().ok()
}

fn valid_replacement_direction(source_build_id: Option<&str>, target_build_id: &str) -> bool {
    let Some(source_sequence) = source_build_id.and_then(control_plane_build_sequence) else {
        return control_plane_build_sequence(target_build_id).is_some();
    };
    let Some(target_sequence) = control_plane_build_sequence(target_build_id) else {
        return false;
    };
    target_sequence > source_sequence
        || (target_sequence == source_sequence && source_build_id == Some(target_build_id))
}

fn decimal_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn modified_identity(value: &str) -> bool {
    let Some((seconds, nanos)) = value.split_once(':') else {
        return false;
    };
    !seconds.is_empty()
        && seconds.len() <= 32
        && seconds.bytes().all(|byte| byte.is_ascii_digit())
        && !nanos.is_empty()
        && nanos.len() <= 32
        && nanos.bytes().all(|byte| byte.is_ascii_digit())
}

fn sha256_identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_executable_identity_values(
    path: &Path,
    device: &str,
    inode: &str,
    size: &str,
    modified: &str,
    sha256: &str,
) -> bool {
    path.is_absolute()
        && decimal_identity(device)
        && decimal_identity(inode)
        && decimal_identity(size)
        && modified_identity(modified)
        && sha256_identity(sha256)
}

fn valid_local_executable_identity(identity: &LocalExecutableIdentity) -> bool {
    valid_executable_identity_values(
        &identity.executable_path,
        &identity.executable_device,
        &identity.executable_inode,
        &identity.executable_size,
        &identity.executable_modified,
        &identity.executable_sha256,
    )
}

fn valid_replacement_hmux(identity: &HmuxToolchainIdentity) -> bool {
    valid_executable_identity_values(
        &identity.executable_path,
        &identity.executable_device,
        &identity.executable_inode,
        &identity.executable_size,
        &identity.executable_modified,
        &identity.executable_sha256,
    ) && valid_executable_identity_values(
        &identity.runtime_executable_path,
        &identity.runtime_executable_device,
        &identity.runtime_executable_inode,
        &identity.runtime_executable_size,
        &identity.runtime_executable_modified,
        &identity.runtime_executable_sha256,
    ) && identity.discovery_root.is_absolute()
        && decimal_identity(&identity.discovery_device)
        && decimal_identity(&identity.discovery_inode)
}

fn assert_owner_directory(path: &Path) -> Result<(), ControlPlaneError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ControlPlaneError::Invalid(
            "backend root must be a non-symlink directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(ControlPlaneError::Invalid(
                "backend root must be owner-only",
            ));
        }
    }
    Ok(())
}

fn ensure_backend_root(
    home: &Path,
) -> Result<backend_runtime_root::BackendRuntimeRoot, ControlPlaneError> {
    backend_runtime_root::ensure(home)
}

#[cfg(unix)]
fn ensure_owner_subdirectory(parent: &Path, name: &str) -> Result<PathBuf, ControlPlaneError> {
    let path = parent.join(name);
    match fs::DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    assert_owner_directory(&path)?;
    Ok(path.canonicalize()?)
}

fn owner_file(path: &Path) -> Result<File, ControlPlaneError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(ControlPlaneError::Invalid(
            "backend file must be a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(ControlPlaneError::Invalid(
                "backend file must be owner-only",
            ));
        }
    }
    Ok(file)
}

fn random_generation() -> Result<String, ControlPlaneError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        ControlPlaneError::Message(format!("random generation failed: {error}"))
    })?;
    let mut generation = String::with_capacity("local-v1-".len() + bytes.len() * 2);
    generation.push_str("local-v1-");
    for byte in bytes {
        write!(&mut generation, "{byte:02x}")
            .map_err(|_| ControlPlaneError::Invalid("random generation formatting failed"))?;
    }
    Ok(generation)
}

fn random_opaque_reference(prefix: &str) -> Result<String, BackendDispatchError> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| BackendDispatchError::from("orchestration_entropy_unavailable"))?;
    let mut value = String::with_capacity(prefix.len() + 1 + bytes.len() * 2);
    value.push_str(prefix);
    value.push('-');
    for byte in bytes {
        write!(&mut value, "{byte:02x}")
            .map_err(|_| BackendDispatchError::from("orchestration_entropy_unavailable"))?;
    }
    Ok(value)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HmuxToolchainIdentity {
    pub executable_path: PathBuf,
    pub executable_device: String,
    pub executable_inode: String,
    pub executable_size: String,
    pub executable_modified: String,
    pub executable_sha256: String,
    pub runtime_executable_path: PathBuf,
    pub runtime_executable_device: String,
    pub runtime_executable_inode: String,
    pub runtime_executable_size: String,
    pub runtime_executable_modified: String,
    pub runtime_executable_sha256: String,
    pub discovery_root: PathBuf,
    pub discovery_device: String,
    pub discovery_inode: String,
}

struct ExecutableIdentity {
    path: PathBuf,
    device: String,
    inode: String,
    size: String,
    modified: String,
    sha256: String,
}

fn resolve_executable_identity(executable: &Path) -> Result<ExecutableIdentity, ControlPlaneError> {
    use std::os::unix::fs::MetadataExt;

    if !executable.is_absolute() {
        return Err(ControlPlaneError::Invalid(
            "executable identity paths must be absolute",
        ));
    }
    let path = fs::canonicalize(executable)?;
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file()
        || metadata.mode() & 0o111 == 0
        || metadata.len() == 0
        || metadata.len() > MAX_LOCAL_EXECUTABLE_BYTES
    {
        return Err(ControlPlaneError::Invalid(
            "executable identities must reference executable regular files",
        ));
    }
    let mut file = File::open(&path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(ExecutableIdentity {
        path,
        device: metadata.dev().to_string(),
        inode: metadata.ino().to_string(),
        size: metadata.size().to_string(),
        modified: format!("{}:{}", metadata.mtime(), metadata.mtime_nsec()),
        sha256: format!("{:x}", hasher.finalize()),
    })
}

fn resolve_control_plane_executable_identity(
    executable: &Path,
) -> Result<LocalExecutableIdentity, ControlPlaneError> {
    let identity = resolve_executable_identity(executable)?;
    Ok(LocalExecutableIdentity {
        executable_path: identity.path,
        executable_device: identity.device,
        executable_inode: identity.inode,
        executable_size: identity.size,
        executable_modified: identity.modified,
        executable_sha256: identity.sha256,
    })
}

fn resolve_hmux_toolchain_identity(
    executable: &Path,
    runtime_executable: &Path,
    discovery_root: &Path,
) -> Result<HmuxToolchainIdentity, ControlPlaneError> {
    use std::os::unix::fs::MetadataExt;

    if !discovery_root.is_absolute() {
        return Err(ControlPlaneError::Invalid(
            "Hmux discovery root must be absolute",
        ));
    }
    let executable = resolve_executable_identity(executable)?;
    let runtime_executable = resolve_executable_identity(runtime_executable)?;
    let discovery_root = fs::canonicalize(discovery_root)?;
    let discovery_metadata = fs::metadata(&discovery_root)?;
    if !discovery_metadata.is_dir() {
        return Err(ControlPlaneError::Invalid(
            "Hmux discovery root must be a directory",
        ));
    }
    Ok(HmuxToolchainIdentity {
        executable_path: executable.path,
        executable_device: executable.device,
        executable_inode: executable.inode,
        executable_size: executable.size,
        executable_modified: executable.modified,
        executable_sha256: executable.sha256,
        runtime_executable_path: runtime_executable.path,
        runtime_executable_device: runtime_executable.device,
        runtime_executable_inode: runtime_executable.inode,
        runtime_executable_size: runtime_executable.size,
        runtime_executable_modified: runtime_executable.modified,
        runtime_executable_sha256: runtime_executable.sha256,
        discovery_root,
        discovery_device: discovery_metadata.dev().to_string(),
        discovery_inode: discovery_metadata.ino().to_string(),
    })
}

fn hmux_toolchain_metadata_matches(
    identity: &HmuxToolchainIdentity,
) -> Result<bool, ControlPlaneError> {
    use std::os::unix::fs::MetadataExt;

    let executable_path = fs::canonicalize(&identity.executable_path)?;
    let executable = fs::metadata(&executable_path)?;
    let runtime_executable_path = fs::canonicalize(&identity.runtime_executable_path)?;
    let runtime_executable = fs::metadata(&runtime_executable_path)?;
    let discovery_root = fs::canonicalize(&identity.discovery_root)?;
    let discovery = fs::metadata(&discovery_root)?;
    Ok(executable_path == identity.executable_path
        && executable.is_file()
        && executable.mode() & 0o111 != 0
        && executable.dev().to_string() == identity.executable_device
        && executable.ino().to_string() == identity.executable_inode
        && executable.size().to_string() == identity.executable_size
        && format!("{}:{}", executable.mtime(), executable.mtime_nsec())
            == identity.executable_modified
        && runtime_executable_path == identity.runtime_executable_path
        && runtime_executable.is_file()
        && runtime_executable.mode() & 0o111 != 0
        && runtime_executable.dev().to_string() == identity.runtime_executable_device
        && runtime_executable.ino().to_string() == identity.runtime_executable_inode
        && runtime_executable.size().to_string() == identity.runtime_executable_size
        && format!(
            "{}:{}",
            runtime_executable.mtime(),
            runtime_executable.mtime_nsec()
        ) == identity.runtime_executable_modified
        && discovery_root == identity.discovery_root
        && discovery.is_dir()
        && discovery.dev().to_string() == identity.discovery_device
        && discovery.ino().to_string() == identity.discovery_inode)
}

fn read_descriptor(path: &Path) -> Result<Option<ServiceDescriptor>, ControlPlaneError> {
    let Some(source) = private_record::read(path)? else {
        return Ok(None);
    };
    let descriptor: ServiceDescriptor = serde_json::from_slice(&source)
        .map_err(|error| ControlPlaneError::Message(format!("invalid descriptor: {error}")))?;
    let root = path
        .parent()
        .ok_or(ControlPlaneError::Invalid("invalid descriptor path"))?;
    let descriptor_root = backend_runtime_root::from_durable(root).ok();
    let hmux_executable_identity_complete = descriptor.hmux_executable_path.is_some()
        && descriptor.hmux_executable_device.is_some()
        && descriptor.hmux_executable_inode.is_some()
        && descriptor.hmux_executable_size.is_some()
        && descriptor.hmux_executable_modified.is_some()
        && descriptor.hmux_executable_sha256.is_some();
    let hmux_runtime_identity_complete = descriptor.hmux_runtime_executable_path.is_some()
        && descriptor.hmux_runtime_executable_device.is_some()
        && descriptor.hmux_runtime_executable_inode.is_some()
        && descriptor.hmux_runtime_executable_size.is_some()
        && descriptor.hmux_runtime_executable_modified.is_some()
        && descriptor.hmux_runtime_executable_sha256.is_some();
    let hmux_runtime_identity_absent = descriptor.hmux_runtime_executable_path.is_none()
        && descriptor.hmux_runtime_executable_device.is_none()
        && descriptor.hmux_runtime_executable_inode.is_none()
        && descriptor.hmux_runtime_executable_size.is_none()
        && descriptor.hmux_runtime_executable_modified.is_none()
        && descriptor.hmux_runtime_executable_sha256.is_none();
    let hmux_discovery_identity_complete = descriptor.hmux_discovery_root.is_some()
        && descriptor.hmux_discovery_device.is_some()
        && descriptor.hmux_discovery_inode.is_some();
    let hmux_identity_complete = hmux_executable_identity_complete
        && hmux_runtime_identity_complete
        && hmux_discovery_identity_complete;
    let hmux_legacy_identity = descriptor.build_id.as_deref() != Some(control_plane_build_id())
        && hmux_executable_identity_complete
        && hmux_runtime_identity_absent
        && hmux_discovery_identity_complete;
    let hmux_identity_absent = descriptor.hmux_executable_path.is_none()
        && descriptor.hmux_executable_device.is_none()
        && descriptor.hmux_executable_inode.is_none()
        && descriptor.hmux_executable_size.is_none()
        && descriptor.hmux_executable_modified.is_none()
        && descriptor.hmux_executable_sha256.is_none()
        && hmux_runtime_identity_absent
        && descriptor.hmux_discovery_root.is_none()
        && descriptor.hmux_discovery_device.is_none()
        && descriptor.hmux_discovery_inode.is_none();
    let control_plane_identity_valid = descriptor
        .control_plane_identity
        .as_ref()
        .is_some_and(valid_local_executable_identity);
    let control_plane_identity_invalid = match descriptor.schema_version {
        1..=3 => descriptor.control_plane_identity.is_some(),
        4 | SERVICE_DESCRIPTOR_SCHEMA_VERSION => {
            !descriptor
                .build_id
                .as_deref()
                .is_some_and(|build_id| control_plane_build_sequence(build_id).is_some())
                || !control_plane_identity_valid
        }
        _ => true,
    };
    if !matches!(
        descriptor.schema_version,
        1 | 2 | 3 | 4 | SERVICE_DESCRIPTOR_SCHEMA_VERSION
    ) || descriptor.backend_id != BACKEND_ID
        || !valid_generation(&descriptor.generation)
        || descriptor
            .activation_source_generation
            .as_deref()
            .is_some_and(|source| {
                !matches!(
                    descriptor.schema_version,
                    3 | 4 | SERVICE_DESCRIPTOR_SCHEMA_VERSION
                ) || !valid_generation(source)
                    || source == descriptor.generation
            })
        || !descriptor_socket_path_is_valid(root, &descriptor)
        || descriptor_root.as_ref().is_none_or(|descriptor_root| {
            descriptor.database_path != descriptor_root.durable().join("application-state.sqlite3")
        })
        || control_plane_identity_invalid
        || (!hmux_identity_complete && !hmux_legacy_identity && !hmux_identity_absent)
        || (descriptor.build_id.as_deref() == Some(control_plane_build_id())
            && !hmux_identity_complete)
        || descriptor
            .hmux_executable_path
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        || descriptor
            .hmux_discovery_root
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        || descriptor
            .hmux_runtime_executable_path
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        || [
            descriptor.hmux_executable_device.as_deref(),
            descriptor.hmux_executable_inode.as_deref(),
            descriptor.hmux_executable_size.as_deref(),
            descriptor.hmux_executable_modified.as_deref(),
            descriptor.hmux_executable_sha256.as_deref(),
            descriptor.hmux_runtime_executable_device.as_deref(),
            descriptor.hmux_runtime_executable_inode.as_deref(),
            descriptor.hmux_runtime_executable_size.as_deref(),
            descriptor.hmux_runtime_executable_modified.as_deref(),
            descriptor.hmux_runtime_executable_sha256.as_deref(),
            descriptor.hmux_discovery_device.as_deref(),
            descriptor.hmux_discovery_inode.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(str::is_empty)
    {
        return Err(ControlPlaneError::Invalid(
            "invalid control-plane descriptor",
        ));
    }
    Ok(Some(descriptor))
}

fn read_replacement_intent(
    root: &Path,
    source_generation: &str,
) -> Result<PersistedReplacementIntent, BackendDispatchError> {
    use std::os::unix::fs::MetadataExt;

    let intent_directory = root.join("replacement-intents");
    let path = intent_directory.join(format!("{source_generation}.json"));
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| BackendDispatchError::from("backend_shutdown_intent_unavailable"))?;
    assert_owner_directory(root)
        .map_err(|_| BackendDispatchError::from("backend_shutdown_intent_invalid"))?;
    assert_owner_directory(&intent_directory)
        .map_err(|_| BackendDispatchError::from("backend_shutdown_intent_invalid"))?;
    let before = file
        .metadata()
        .map_err(|_| BackendDispatchError::from("backend_shutdown_intent_unavailable"))?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o077 != 0
        || before.len() == 0
        || before.len() > 16 * 1024
    {
        return Err("backend_shutdown_intent_invalid".into());
    }
    let mut source = Vec::with_capacity(before.len() as usize);
    let mut bounded = std::io::Read::take(&mut file, 16 * 1024 + 1);
    std::io::Read::read_to_end(&mut bounded, &mut source)
        .map_err(|_| BackendDispatchError::from("backend_shutdown_intent_unavailable"))?;
    let after = file
        .metadata()
        .map_err(|_| BackendDispatchError::from("backend_shutdown_intent_unavailable"))?;
    if source.len() as u64 != before.len()
        || after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
    {
        return Err("backend_shutdown_intent_changed".into());
    }
    let intent: PersistedReplacementIntent = serde_json::from_slice(&source)
        .map_err(|_| BackendDispatchError::from("backend_shutdown_intent_invalid"))?;
    if intent.schema_version != 1
        || intent.kind != "dure.local_backend_replacement_intent"
        || intent.created_at_ms < 0
        || intent.source.generation != source_generation
        || !valid_generation(&intent.target.generation)
        || intent.target.generation == source_generation
        || control_plane_build_sequence(&intent.target.build_id).is_none()
        || !valid_local_executable_identity(&intent.target.control_plane_identity)
        || !valid_replacement_hmux(&intent.target.hmux_identity)
    {
        return Err("backend_shutdown_intent_invalid".into());
    }
    Ok(intent)
}

fn read_shutdown_replacement_intent(
    state: &ServiceState,
) -> Result<PersistedReplacementIntent, BackendDispatchError> {
    let root = state
        .canonical_descriptor_path
        .parent()
        .ok_or_else(|| BackendDispatchError::from("backend_shutdown_intent_invalid"))?;
    let intent = read_replacement_intent(root, &state.descriptor.generation)?;
    if intent.source.build_id != state.descriptor.build_id
        || intent.source.hmux_identity.as_ref() != Some(&state.hmux_identity)
    {
        return Err("backend_shutdown_intent_invalid".into());
    }
    Ok(intent)
}

fn assert_owner_socket(path: &Path) -> Result<(), ControlPlaneError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() {
        return Err(ControlPlaneError::Invalid(
            "gateway endpoint must be a Unix socket",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(ControlPlaneError::Invalid(
                "gateway endpoint must be owner-only",
            ));
        }
    }
    Ok(())
}

async fn relay_gateway<R, W>(
    stream: UnixStream,
    mut input: R,
    mut output: W,
) -> Result<(), ControlPlaneError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let (mut backend_read, mut backend_write) = stream.into_split();
    let upload = async {
        tokio::io::copy(&mut input, &mut backend_write).await?;
        backend_write.shutdown().await
    };
    let download = async {
        tokio::io::copy(&mut backend_read, &mut output).await?;
        output.flush().await
    };
    tokio::pin!(upload);
    tokio::pin!(download);
    tokio::select! {
        uploaded = &mut upload => {
            uploaded?;
            timeout(REQUEST_DEADLINE + REQUEST_IO_TIMEOUT, &mut download)
                .await
                .map_err(|_| ControlPlaneError::Invalid("gateway response timed out"))??;
        }
        downloaded = &mut download => downloaded?,
    }
    Ok(())
}

async fn gateway_with_io<R, W>(
    options: GatewayOptions,
    input: R,
    output: W,
) -> Result<(), ControlPlaneError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    if !valid_generation(&options.expected_generation) {
        return Err(ControlPlaneError::Invalid(
            "gateway endpoint identity is invalid",
        ));
    }
    let socket_parent = options
        .socket_path
        .parent()
        .ok_or(ControlPlaneError::Invalid(
            "gateway endpoint identity is invalid",
        ))?;
    let backend_root = backend_runtime_root::resolve_socket_parent(socket_parent)?;
    let descriptor_path = backend_root.durable().join("control-plane.json");
    let descriptor = read_descriptor(&descriptor_path)?
        .ok_or(ControlPlaneError::Invalid("control plane is unavailable"))?;
    if descriptor.socket_path != options.socket_path
        || descriptor.generation != options.expected_generation
    {
        return Err(ControlPlaneError::Invalid(
            "gateway backend generation does not match",
        ));
    }
    assert_owner_socket(&options.socket_path)?;
    let stream = UnixStream::connect(&options.socket_path).await?;
    if peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Err(ControlPlaneError::Invalid(
            "gateway backend peer is not the current owner",
        ));
    }
    let observed = read_descriptor(&descriptor_path)?
        .ok_or(ControlPlaneError::Invalid("control plane is unavailable"))?;
    if observed != descriptor {
        return Err(ControlPlaneError::Invalid(
            "control-plane descriptor changed before gateway relay",
        ));
    }
    relay_gateway(stream, input, output).await
}

pub async fn gateway(options: GatewayOptions) -> Result<(), ControlPlaneError> {
    gateway_with_io(options, tokio::io::stdin(), tokio::io::stdout()).await
}

fn write_descriptor(path: &Path, descriptor: &ServiceDescriptor) -> Result<(), ControlPlaneError> {
    private_record::write(path, descriptor)
}

fn assert_owner_regular_file(path: &Path) -> Result<(), ControlPlaneError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ControlPlaneError::Invalid(
            "backend database must be a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(ControlPlaneError::Invalid(
                "backend database must be owner-only",
            ));
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut uid = 0;
    let mut gid = 0;
    let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if result == 0 {
        Ok(uid)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut length,
        )
    };
    if result == 0 {
        Ok(credentials.uid)
    } else {
        Err(io::Error::last_os_error())
    }
}

struct BackendRequestAuthority {
    backend_id: String,
    generation: String,
}

fn validate_request(
    request: &BackendRequest,
    state: &ServiceState,
) -> Result<BackendRequestAuthority, String> {
    let descriptor = &state.descriptor;
    if request.schema_version != 1
        || request.api_version != BACKEND_PROTOCOL_API
        || request.kind != BACKEND_REQUEST_KIND
        || !valid_token(&request.request_id)
        || !valid_token(&request.operation)
    {
        return Err("backend_request_invalid".into());
    }
    if request.connection.is_some() && !requests_persistent_connection(request) {
        return Err("backend_request_invalid".into());
    }
    let expected = &request.expected;
    if expected
        .scope_id
        .as_ref()
        .is_some_and(|scope| scope != &state.scope_id)
    {
        return Err("backend_scope_mismatch".into());
    }
    if expected.backend_id != descriptor.backend_id
        || expected.generation != descriptor.generation
        || expected.protocol.minimum.major != 1
        || expected.protocol.minimum.minor != 0
        || expected.protocol.maximum.major != 1
        || expected.protocol.maximum.minor != 0
        || expected
            .required_capabilities
            .iter()
            .any(|capability| !control_plane_capabilities().contains(capability))
    {
        return Err("backend_expectation_mismatch".into());
    }
    Ok(BackendRequestAuthority {
        backend_id: descriptor.backend_id.clone(),
        generation: descriptor.generation.clone(),
    })
}

fn requests_persistent_connection(request: &BackendRequest) -> bool {
    request.connection.as_ref().is_some_and(|connection| {
        connection.mode == PERSISTENT_CONNECTION_MODE
            && request
                .expected
                .required_capabilities
                .iter()
                .any(|capability| capability == PERSISTENT_CONNECTION_CAPABILITY)
    })
}

async fn query_hmux(
    hmux_identity: &HmuxToolchainIdentity,
    session_id: &str,
    workspace_id: &str,
    stop_fence: &HmuxStopFence,
) -> Result<HmuxSessionInspection, String> {
    query_hmux_with_lifecycle(hmux_identity, session_id, workspace_id, stop_fence, false)
        .await
        .map_err(|failure| failure.code().into())
}

async fn query_hmux_for_runtime_transition(
    hmux_identity: &HmuxToolchainIdentity,
    session_id: &str,
    workspace_id: &str,
    stop_fence: &HmuxStopFence,
) -> Result<HmuxSessionInspection, HmuxSessionInspectionFailure> {
    query_hmux_with_lifecycle(hmux_identity, session_id, workspace_id, stop_fence, true).await
}

async fn query_hmux_with_lifecycle(
    hmux_identity: &HmuxToolchainIdentity,
    session_id: &str,
    workspace_id: &str,
    stop_fence: &HmuxStopFence,
    allow_exited: bool,
) -> Result<HmuxSessionInspection, HmuxSessionInspectionFailure> {
    #[cfg(test)]
    let _test_query_guard = HMUX_TEST_QUERY_LOCK.lock().await;
    if !hmux_toolchain_metadata_matches(hmux_identity)
        .map_err(|_| HmuxSessionInspectionFailure::RuntimeIdentityChanged)?
    {
        return Err(HmuxSessionInspectionFailure::RuntimeIdentityChanged);
    }
    let mut command = Command::new(&hmux_identity.executable_path);
    command
        .kill_on_drop(true)
        .env_remove("DURE_HMUX_BIN")
        .env_remove("HMUX_DISCOVERY_ROOT")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .arg("--discovery-root")
        .arg(&hmux_identity.discovery_root)
        .args([
            "--json",
            "session",
            "show",
            session_id,
            "--workspace",
            workspace_id,
        ]);
    let mut child = command
        .spawn()
        .map_err(|_| HmuxSessionInspectionFailure::DescriptorUnavailable)?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or(HmuxSessionInspectionFailure::DescriptorUnavailable)?;
    let output = timeout(HMUX_QUERY_TIMEOUT, async {
        let mut bytes = Vec::new();
        let mut bounded = (&mut stdout).take(MAX_HMUX_OUTPUT_BYTES as u64 + 1);
        bounded
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| HmuxSessionInspectionFailure::DescriptorUnavailable)?;
        if bytes.len() > MAX_HMUX_OUTPUT_BYTES {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(HmuxSessionInspectionFailure::DescriptorUnavailable);
        }
        let status = child
            .wait()
            .await
            .map_err(|_| HmuxSessionInspectionFailure::DescriptorUnavailable)?;
        Ok((status, bytes))
    })
    .await
    .map_err(|_| HmuxSessionInspectionFailure::DescriptorTimeout)??;
    if !output.0.success() {
        return Err(HmuxSessionInspectionFailure::DescriptorUnavailable);
    }
    let expected = ExpectedHmuxSession {
        session_id,
        workspace_id,
        runner_principal: &stop_fence.runner_principal,
        runner_instance: &stop_fence.runner_instance,
        channel_epoch: &stop_fence.channel_epoch,
        host_instance_id: &stop_fence.host_instance_id,
        terminal_epoch: &stop_fence.terminal_epoch,
    };
    if allow_exited {
        parse_exact_hmux_session_for_transition(&output.1, &expected)
    } else {
        parse_exact_hmux_session(&output.1, &expected)
    }
}

async fn query_hmux_sessions(
    hmux_identity: &HmuxToolchainIdentity,
    arguments: &[String],
) -> Result<Value, String> {
    #[cfg(test)]
    let _test_query_guard = HMUX_TEST_QUERY_LOCK.lock().await;
    if !hmux_toolchain_metadata_matches(hmux_identity)
        .map_err(|_| "hmux_session_runtime_identity_changed".to_string())?
    {
        return Err("hmux_session_runtime_identity_changed".into());
    }
    let mut command = Command::new(&hmux_identity.executable_path);
    command
        .kill_on_drop(true)
        .env_remove("DURE_HMUX_BIN")
        .env_remove("HMUX_DISCOVERY_ROOT")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .arg("--discovery-root")
        .arg(&hmux_identity.discovery_root)
        .arg("--json")
        .args(arguments);
    let mut child = command
        .spawn()
        .map_err(|_| "hmux_session_query_unavailable".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "hmux_session_query_unavailable".to_string())?;
    let output = timeout(HMUX_QUERY_TIMEOUT, async {
        let mut bytes = Vec::new();
        let mut bounded = (&mut stdout).take(MAX_HMUX_SESSION_OUTPUT_BYTES as u64 + 1);
        bounded
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "hmux_session_query_unavailable".to_string())?;
        if bytes.len() > MAX_HMUX_SESSION_OUTPUT_BYTES {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("hmux_session_query_output_limit".to_string());
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "hmux_session_query_unavailable".to_string())?;
        Ok((status, bytes))
    })
    .await
    .map_err(|_| "hmux_session_query_timeout".to_string())??;
    if !output.0.success() {
        return Err("hmux_session_query_failed".into());
    }
    serde_json::from_slice(&output.1).map_err(|_| "hmux_session_payload_invalid".to_string())
}

async fn list_sessions(state: &ServiceState, body: SessionsListBody) -> Result<Value, String> {
    let unique_priorities = body
        .prioritized
        .iter()
        .map(|priority| (&priority.workspace_id, &priority.session_id))
        .collect::<std::collections::BTreeSet<_>>();
    if body.schema_version != 1
        || body.max_items != MAX_SESSION_ITEMS
        || body.probe_budget_ms > MAX_SESSION_PROBE_BUDGET_MS
        || body.prioritized.len() > body.max_items
        || unique_priorities.len() != body.prioritized.len()
        || body.prioritized.iter().any(|priority| {
            !valid_token(&priority.session_id) || !valid_token(&priority.workspace_id)
        })
    {
        return Err("dure_session_query_invalid".into());
    }
    let requested_priorities = body.prioritized.len();
    let catalog_query = json!({
        "schemaVersion": 1,
        "maxItems": body.max_items,
        "maxOutputBytes": MAX_HMUX_SESSION_CATALOG_BYTES,
        "prioritized": body.prioritized,
    });
    let payload = query_hmux_sessions(
        &state.hmux_identity,
        &[
            "session".into(),
            "list".into(),
            "--probe-budget-ms".into(),
            body.probe_budget_ms.to_string(),
            "--catalog-query-json".into(),
            catalog_query.to_string(),
        ],
    )
    .await?;
    let catalog: HmuxSessionCatalog =
        serde_json::from_value(payload).map_err(|_| "hmux_session_payload_invalid".to_string())?;
    if !catalog.complete {
        return Err("hmux_session_census_incomplete".into());
    }
    if catalog.schema_version != 1
        || catalog.sessions.len() > MAX_SESSION_ITEMS
        || catalog.prioritized_items > requested_priorities
        || catalog.prioritized_items > catalog.sessions.len()
        || catalog.truncation.items != (catalog.truncation.omitted_count > 0)
    {
        return Err("hmux_session_payload_invalid".into());
    }
    let mut response = json!({
        "schemaVersion": 1,
        "complete": true,
        "sessions": catalog.sessions,
    });
    if catalog.truncation.items {
        response["truncation"] = json!({
            "items": true,
            "omittedCount": catalog.truncation.omitted_count,
        });
    }
    Ok(response)
}

async fn show_session(state: &ServiceState, body: SessionsShowBody) -> Result<Value, String> {
    if body.schema_version != 1
        || !valid_token(&body.session_id)
        || body
            .workspace_id
            .as_deref()
            .is_some_and(|workspace_id| !valid_token(workspace_id))
    {
        return Err("dure_session_query_invalid".into());
    }
    let mut arguments = vec!["session".into(), "show".into(), body.session_id.clone()];
    if let Some(workspace_id) = &body.workspace_id {
        arguments.extend(["--workspace".into(), workspace_id.clone()]);
    }
    let session = query_hmux_sessions(&state.hmux_identity, &arguments).await?;
    if !session.is_object()
        || session["session_id"] != body.session_id
        || body
            .workspace_id
            .as_deref()
            .is_some_and(|workspace_id| session["workspace_id"] != workspace_id)
    {
        return Err("dure_session_query_identity_mismatch".into());
    }
    Ok(json!({ "schemaVersion": 1, "session": session }))
}

async fn read_session(state: &ServiceState, body: SessionsReadBody) -> Result<Value, String> {
    if body.schema_version != 1
        || !valid_token(&body.session_id)
        || !valid_token(&body.workspace_id)
        || !(1..=MAX_SESSION_READ_LINES).contains(&body.lines)
    {
        return Err("dure_session_read_invalid".into());
    }
    let payload = query_hmux_sessions(
        &state.hmux_identity,
        &[
            "read".into(),
            body.session_id.clone(),
            "--workspace".into(),
            body.workspace_id.clone(),
            "--lines".into(),
            body.lines.to_string(),
        ],
    )
    .await?;
    let payload: HmuxReadPayload = serde_json::from_value(payload)
        .map_err(|_| "dure_session_read_payload_invalid".to_string())?;
    if !payload.ok
        || payload.sequence_through.parse::<u64>().is_err()
        || payload.lines.len() > body.lines
    {
        return Err("dure_session_read_payload_invalid".into());
    }
    Ok(json!({
        "schemaVersion": 1,
        "sessionId": body.session_id,
        "workspaceId": body.workspace_id,
        "sequenceThrough": payload.sequence_through,
        "lines": payload.lines,
    }))
}

async fn projects_catalog(state: &ServiceState) -> Result<project_catalog::ProjectCatalog, String> {
    let path = state.projects_catalog_path.clone();
    tokio::task::spawn_blocking(move || load_project_catalog(&path))
        .await
        .map_err(|_| "backend_projects_catalog_unavailable".to_string())?
        .map_err(str::to_string)
}

async fn list_projects(state: &ServiceState, body: ProjectsListBody) -> Result<Value, String> {
    if body.schema_version != 1 || !(1..=MAX_PROJECT_QUERY_ITEMS).contains(&body.max_items) {
        return Err("backend_projects_request_invalid".into());
    }
    let mut projects = projects_catalog(state).await?.projections();
    let complete = projects.len() <= body.max_items;
    projects.truncate(body.max_items);
    Ok(json!({
        "schemaVersion": 1,
        "complete": complete,
        "projects": projects,
    }))
}

async fn show_project(state: &ServiceState, body: ProjectsShowBody) -> Result<Value, String> {
    if body.schema_version != 1 || !valid_project_id(&body.project_id) {
        return Err("backend_projects_request_invalid".into());
    }
    let project = projects_catalog(state)
        .await?
        .project(&body.project_id)
        .ok_or_else(|| "backend_project_not_found".to_string())?;
    Ok(json!({ "schemaVersion": 1, "project": project.projection() }))
}

async fn register_backend_project(
    state: &ServiceState,
    body: ProjectsRegisterBody,
) -> Result<Value, String> {
    if body.schema_version != 1 {
        return Err("backend_project_registration_invalid".into());
    }
    let _guard = state.project_catalog_lock.lock().await;
    let project = register_project(
        &state.projects_catalog_path,
        body.project_id,
        body.display_name,
        body.root,
    )
    .map_err(str::to_string)?;
    Ok(json!({ "schemaVersion": 1, "project": project }))
}

fn default_agent_execution_profile() -> AgentExecutionProfileV1 {
    AgentExecutionProfileV1::ProviderDefault
}

fn provider_launch_defaults_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    match error {
        DomainStoreErrorV1::ProviderLaunchDefaultsRevisionConflict {
            expected_revision,
            actual_revision,
        } => BackendDispatchError {
            code: "provider_launch_defaults_revision_conflict".into(),
            message: "provider launch defaults changed before the write committed".into(),
            details: Some(json!({
                "expectedRevision": expected_revision,
                "actualRevision": actual_revision,
            })),
            disposition: BackendFailureDispositionV1::RetrySame,
        },
        DomainStoreErrorV1::IdempotencyConflict { .. } => BackendDispatchError {
            code: "provider_launch_defaults_idempotency_conflict".into(),
            message: "provider launch defaults idempotency key has different input".into(),
            details: None,
            disposition: BackendFailureDispositionV1::RetrySame,
        },
        DomainStoreErrorV1::InvalidRecord { .. } => BackendDispatchError {
            code: "provider_launch_defaults_request_invalid".into(),
            message: "provider launch defaults request is invalid".into(),
            details: None,
            disposition: BackendFailureDispositionV1::RetrySame,
        },
        DomainStoreErrorV1::Storage {
            code: "corrupt_provider_launch_defaults",
            ..
        } => BackendDispatchError {
            code: "provider_launch_defaults_malformed".into(),
            message: "provider launch defaults authority is malformed".into(),
            details: None,
            disposition: BackendFailureDispositionV1::RetrySame,
        },
        _ => BackendDispatchError {
            code: "provider_launch_defaults_unavailable".into(),
            message: "provider launch defaults authority is unavailable".into(),
            details: None,
            disposition: BackendFailureDispositionV1::RetrySame,
        },
    }
}

async fn show_agent_spawn(
    state: &ServiceState,
    body: agent_spawn_api::AgentSpawnStatusBody,
) -> Result<Value, String> {
    let receipt = agent_spawn_api::status(&state.store, body).await?;
    Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
}

async fn apply_agent_spawn(
    state: &ServiceState,
    authority: &BackendRequestAuthority,
    body: agent_spawn_apply::AgentSpawnApplyBody,
) -> Result<Value, BackendDispatchError> {
    // The request authority already fences this dispatch to the active service
    // generation. The persisted plan generation identifies its creator; it
    // must remain resumable by a validated successor serving the same store.
    let observed = agent_spawn_apply::authorize(&state.store, &authority.backend_id, &body).await?;
    let mut locked_agent_ids = vec![observed.plan.agent_id.clone()];
    if agent_spawn_apply::requires_external_context(&observed) {
        if let AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } =
            &observed.plan.request.worktree
        {
            locked_agent_ids.push(source.source_agent_id.clone());
        }
    }
    let _agent_guards = state.agent_operations.acquire_all(locked_agent_ids).await;
    let receipt = agent_spawn_apply::authorize(&state.store, &authority.backend_id, &body).await?;
    let requires_external_context = agent_spawn_apply::requires_external_context(&receipt);
    #[cfg(unix)]
    let structured_launcher = state
        .structured_runtimes
        .resolve(&receipt.plan.request.provider_id)
        .map(|runtime| {
            agent_spawn_structured::RegisteredStructuredAgentSessionLauncher::new(
                runtime,
                Arc::clone(&state.agent_conversations),
            )
        });
    let execution = if requires_external_context {
        let project = projects_catalog(state)
            .await?
            .project(receipt.plan.authority.project_id.as_str())
            .ok_or_else(|| "agent_spawn_project_not_found".to_string())?;
        project_catalog::validate_project_root(&project).map_err(str::to_string)?;
        agent_spawn_apply::validate_project_authority(&receipt, &project)?;
        let launch = match &receipt.plan.launch {
            AgentSpawnLaunchPlanV1::NativeCli { runtime, .. } => {
                if !state
                    .runtime_adapters
                    .contains_runtime_kind(&runtime.runtime_kind_id)
                {
                    return Err("agent_spawn_runtime_unavailable".into());
                }
                let provider = state
                    .agent_providers
                    .session_launch_plan(
                        &receipt.plan.request.provider_id,
                        &receipt.plan.request.permission_mode,
                        receipt.plan.request.model.as_ref(),
                        receipt.plan.request.effort.as_ref(),
                        receipt.plan.request.provider_conversation_ref.as_option(),
                        hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
                    )
                    .map_err(|_| "agent_spawn_provider_preflight_failed".to_string())?
                    .ok_or_else(|| "agent_spawn_provider_unavailable".to_string())?;
                let prompt_target = state
                    .agent_providers
                    .prompt_target(
                        &receipt.plan.request.provider_id,
                        receipt.plan.request.provider_conversation_ref.as_option(),
                    )
                    .ok_or_else(|| "agent_spawn_provider_unavailable".to_string())?;
                let provider_executable = resolve_provider_executable(&provider.launch.executable)
                    .map_err(|mut error| {
                        error.code = "agent_spawn_provider_unavailable".into();
                        error.with_disposition(BackendFailureDispositionV1::RetrySame)
                    })?
                    .to_str()
                    .ok_or_else(|| "agent_spawn_provider_path_invalid".to_string())?
                    .to_string();
                agent_spawn_apply::AgentSpawnLaunchExecution::NativeCli {
                    provider_executable,
                    provider_arguments: provider.launch.arguments,
                    provider_resume_arguments: provider.resume_arguments,
                    prompt_target,
                    launcher: state.credential_aware_workflow_launcher.as_ref(),
                    provider_state_preparer: state.credential_profiles.as_ref(),
                    prompt_deliverer: state.workflow_prompt_deliverer.as_ref(),
                    prompt_activity_observer: state.workflow_prompt_activity_observer.as_ref(),
                }
            }
            AgentSpawnLaunchPlanV1::StructuredProtocol => {
                #[cfg(unix)]
                {
                    let launcher = structured_launcher
                        .as_ref()
                        .ok_or_else(|| "agent_spawn_structured_runtime_unavailable".to_string())?;
                    agent_spawn_apply::AgentSpawnLaunchExecution::StructuredProtocol { launcher }
                }
                #[cfg(not(unix))]
                {
                    return Err("agent_spawn_structured_runtime_unavailable".into());
                }
            }
        };
        Some(agent_spawn_apply::AgentSpawnExecution {
            project_root: project.root().to_path_buf(),
            project_display_name: project.projection().display_name.clone(),
            workspace_acquirer: state.workspace_acquirer.as_ref(),
            launch,
        })
    } else {
        None
    };
    if requires_external_context {
        validate_agent_spawn_source_authority(state, &receipt).await?;
    }
    let applied = agent_spawn_apply::apply(&state.store, receipt, &body, execution).await?;
    Ok(json!({ "schemaVersion": 1, "receipt": applied }))
}

async fn validate_agent_spawn_source_authority(
    state: &ServiceState,
    receipt: &dure_app::AgentSpawnJournalReceiptV1,
) -> Result<(), String> {
    let AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } = &receipt.plan.request.worktree
    else {
        return Ok(());
    };
    let agent = state
        .store
        .agent(&source.source_agent_id)
        .await
        .map_err(|_| "agent_spawn_source_authority_unavailable".to_string())?
        .ok_or_else(|| "agent_spawn_source_authority_changed".to_string())?;
    let workspace = state
        .store
        .workspace(&source.workspace_id)
        .await
        .map_err(|_| "agent_spawn_source_authority_unavailable".to_string())?
        .ok_or_else(|| "agent_spawn_source_authority_changed".to_string())?;
    let observed = agent_runtime_projection::read_locked(state, &source.source_agent_id).await?;
    let agent_runtime_projection::AgentRuntimeObservedV1::Stable {
        selection,
        authority,
    } = observed
    else {
        return Err("agent_spawn_source_authority_changed".into());
    };
    let current =
        agent_spawn_api::existing_workspace_authority(&agent, &workspace, &selection, &authority)?;
    if current != **source {
        return Err("agent_spawn_source_authority_changed".into());
    }
    Ok(())
}

async fn binding_authority(
    store: &SqliteDomainStore,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentCheckpointBindingAuthorityV1>, String> {
    store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .map_err(|_| "agent_checkpoint_binding_store_failed".to_string())
}

fn authority_stop_fence(authority: &AgentCheckpointBindingAuthorityV1) -> HmuxStopFence {
    HmuxStopFence {
        runner_principal: authority.runner_principal.clone(),
        runner_instance: authority.runner_instance.clone(),
        channel_epoch: authority.channel_epoch.clone(),
        host_instance_id: authority.host_instance_id.clone(),
        terminal_epoch: authority.terminal_epoch.clone(),
    }
}

async fn probe_runtime_binding(
    runtime_adapters: &RuntimeAdapterRegistry,
    authority: AgentCheckpointBindingAuthorityV1,
) -> Result<RuntimeSessionProbeReceiptV1, String> {
    runtime_adapters
        .probe_session(authority)
        .await
        .map_err(|error| error.code.as_str().to_owned())?
        .ok_or_else(|| "runtime_adapter_unavailable".to_string())
}

fn workflow_store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    let code = match error {
        DomainStoreErrorV1::InvalidRecord { .. } => "workflow_request_invalid",
        DomainStoreErrorV1::NotFound { .. } => "workflow_record_not_found",
        DomainStoreErrorV1::IdentityConflict { .. } => "workflow_identity_conflict",
        DomainStoreErrorV1::IdempotencyConflict { .. } => "workflow_idempotency_conflict",
        _ => "workflow_store_failed",
    };
    BackendDispatchError {
        code: code.into(),
        message: "workflow store rejected the transition".into(),
        details: None,
        disposition: BackendFailureDispositionV1::RetrySame,
    }
}

async fn workflow_launch_request(
    state: &ServiceState,
    request: &DelegateOnceRequestV1,
    receipt: &DelegateOnceReceiptV1,
) -> Result<WorkflowSessionLaunchRequestV1, BackendDispatchError> {
    if request.target_reference != "backend-profile:local" {
        return Err(BackendDispatchError::terminal(
            "workflow_target_unavailable",
        ));
    }
    if !state
        .runtime_adapters
        .contains_runtime_kind(&request.runtime_kind_id)
    {
        return Err(BackendDispatchError::terminal(
            "workflow_runtime_unavailable",
        ));
    }
    let authority = binding_authority(&state.store, &request.coordinator.agent_id)
        .await
        .map_err(|_| BackendDispatchError::terminal("workflow_coordinator_binding_unavailable"))?
        .ok_or_else(|| {
            BackendDispatchError::terminal("workflow_coordinator_binding_unavailable")
        })?;
    if authority.binding.session_id != request.coordinator.session_id
        || authority.binding.binding_generation != request.coordinator.binding_generation
    {
        return Err(BackendDispatchError::terminal(
            "workflow_coordinator_binding_mismatch",
        ));
    }
    let probe = probe_runtime_binding(&state.runtime_adapters, authority.clone())
        .await
        .map_err(|_| BackendDispatchError::terminal("workflow_coordinator_unavailable"))?;
    if probe.runtime_kind_id != authority.binding.runtime_kind_id
        || probe.session_id != authority.binding.session_id
        || probe.workspace_id != authority.runtime_workspace_id
    {
        return Err(BackendDispatchError::terminal(
            "workflow_coordinator_binding_mismatch",
        ));
    }

    let agent = state
        .store
        .agent(&request.coordinator.agent_id)
        .await
        .map_err(|_| BackendDispatchError::terminal("workflow_coordinator_workspace_unavailable"))?
        .ok_or_else(|| {
            BackendDispatchError::terminal("workflow_coordinator_workspace_unavailable")
        })?;
    let source_create = completed_create_receipt(
        &state.hmux_identity.discovery_root,
        &authority.runtime_workspace_id,
        &authority.binding.session_id,
    )
    .map_err(|_| BackendDispatchError::terminal("workflow_coordinator_permission_unavailable"))?
    .ok_or_else(|| BackendDispatchError::terminal("workflow_coordinator_permission_unavailable"))?;
    let source_provider_id = agent
        .provider_id
        .as_str()
        .strip_prefix("provider.")
        .unwrap_or_else(|| agent.provider_id.as_str());
    let source_fence = source_create.generation_fence().ok_or_else(|| {
        BackendDispatchError::terminal("workflow_coordinator_permission_mismatch")
    })?;
    if source_create.provider_id() != source_provider_id
        || !source_fence.matches_generation(
            &authority.runner_principal,
            &authority.runner_instance,
            &authority.channel_epoch,
            &authority.host_instance_id,
            &authority.terminal_epoch,
        )
    {
        return Err(BackendDispatchError::terminal(
            "workflow_coordinator_permission_mismatch",
        ));
    }
    let permission_override = match source_create.permission_mode() {
        HmuxPermissionMode::Default => ProviderLaunchPermissionOverrideV1::RequireApprovals,
        HmuxPermissionMode::BypassApprovals => ProviderLaunchPermissionOverrideV1::BypassApprovals,
    };
    let provider_defaults = state
        .store
        .provider_launch_defaults()
        .await
        .map_err(|error| match error {
            DomainStoreErrorV1::Storage {
                code: "corrupt_provider_launch_defaults",
                ..
            } => BackendDispatchError::from("workflow_provider_defaults_malformed"),
            _ => BackendDispatchError::from("workflow_provider_defaults_unavailable"),
        })?;
    let permission_mode =
        provider_defaults.resolve_permission_mode(&request.provider_id, Some(permission_override));
    let plan = state
        .agent_providers
        .session_launch_plan(
            &request.provider_id,
            &permission_mode,
            None,
            None,
            None,
            hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        )
        .map_err(|_| BackendDispatchError::terminal("workflow_provider_preflight_failed"))?
        .ok_or_else(|| BackendDispatchError::terminal("workflow_provider_unavailable"))?;
    let executable = resolve_provider_executable(&plan.launch.executable)?;
    let workspace = state
        .store
        .workspace(&agent.workspace_id)
        .await
        .map_err(|_| BackendDispatchError::terminal("workflow_coordinator_workspace_unavailable"))?
        .ok_or_else(|| {
            BackendDispatchError::terminal("workflow_coordinator_workspace_unavailable")
        })?;
    let working_directory = fs::canonicalize(&workspace.root_path).map_err(|_| {
        BackendDispatchError::terminal("workflow_coordinator_workspace_unavailable")
    })?;
    if !working_directory.is_dir() {
        return Err(BackendDispatchError::terminal(
            "workflow_coordinator_workspace_unavailable",
        ));
    }

    let session_id = dure_app::workflow_prepared_session_id(&receipt.dispatch_id)
        .map_err(|_| BackendDispatchError::terminal("workflow_dispatch_identity_invalid"))?;
    let launch = WorkflowSessionLaunchRequestV1 {
        runtime_kind_id: request.runtime_kind_id.clone(),
        launch_idempotency_key: receipt.launch_idempotency_key.clone(),
        session_id,
        workspace_id: authority.runtime_workspace_id,
        provider_id: request.provider_id.clone(),
        provider_conversation_ref: None,
        permission_mode,
        provider_executable: executable
            .to_str()
            .ok_or_else(|| BackendDispatchError::terminal("workflow_provider_path_invalid"))?
            .into(),
        provider_arguments: plan.launch.arguments,
        provider_resume: dure_app::WorkflowSessionResumePlanV1::from_arguments(
            plan.resume_arguments,
            &dure_app::AgentExecutionProfileV1::ProviderDefault,
        ),
        initial_prompt: None,
        working_directory: working_directory
            .to_str()
            .ok_or_else(|| BackendDispatchError::terminal("workflow_workspace_path_invalid"))?
            .into(),
        prelaunch_command: None,
    };
    launch
        .validate()
        .map_err(|_| BackendDispatchError::terminal("workflow_launch_invalid"))?;
    Ok(launch)
}

async fn delegate_once(
    state: &ServiceState,
    request: DelegateOnceRequestV1,
) -> Result<Value, BackendDispatchError> {
    let prepared = prepare_delegate_once(&request).map_err(workflow_store_error)?;
    let workflow_guard = state.workflow_lock.lock().await;

    let observed_receipt = state
        .store
        .delegate_once_receipt(&request.idempotency_key)
        .await
        .map_err(workflow_store_error)?;
    let existing_receipt = if observed_receipt.is_some() {
        let receipt = state
            .store
            .create_delegate_once(&request)
            .await
            .map_err(workflow_store_error)?;
        let receipt = ensure_delegate_once_effective_launch(state, receipt).await?;
        if !delegate_once_needs_progress(&receipt) {
            return Ok(json!({ "schemaVersion": 1, "receipt": receipt }));
        }
        Some(receipt)
    } else {
        None
    };

    let needs_launch = existing_receipt
        .as_ref()
        .is_none_or(|receipt| receipt.status == WorkflowDispatchStateV1::Starting);
    // A worker may already exist before its binding commits. Its retained
    // launch is independent of later coordinator or workspace changes.
    let retained_launch = if needs_launch {
        state
            .store
            .delegate_once_launch(&request.idempotency_key)
            .await
            .map_err(workflow_store_error)?
    } else {
        None
    };
    let binding_guard = if needs_launch && retained_launch.is_none() {
        Some(
            state
                .agent_operations
                .acquire(&request.coordinator.agent_id)
                .await,
        )
    } else {
        None
    };
    let launch = if needs_launch {
        let launch_receipt = existing_receipt.as_ref().unwrap_or(&prepared.receipt);
        let launch = match retained_launch {
            Some(launch) => launch,
            None => workflow_launch_request(state, &request, launch_receipt).await?,
        };
        let provider_state_environment =
            provider_credential_profile::native_provider_state_environment(
                &launch.provider_id,
                None,
            )
            .map_err(|_| BackendDispatchError::terminal("workflow_provider_state_unavailable"))?;
        Some((launch, provider_state_environment))
    } else {
        None
    };
    let receipt = match existing_receipt {
        Some(receipt) => receipt,
        None => state
            .store
            .create_delegate_once(&request)
            .await
            .map_err(workflow_store_error)?,
    };
    let active = if receipt.status == WorkflowDispatchStateV1::Starting {
        let (launch, provider_state_environment) = launch
            .ok_or_else(|| BackendDispatchError::terminal("workflow_launch_state_inconsistent"))?;
        let launch = state
            .store
            .prepare_delegate_once_launch(&request, &launch)
            .await
            .map_err(workflow_store_error)?;
        drop(binding_guard);
        let launched = match workflow_launch::launch_independent(
            state,
            launch.clone(),
            provider_state_environment,
        )
        .await
        {
            Ok(session) => session,
            Err(failure)
                if failure.disposition == WorkflowSessionLaunchFailureDispositionV1::Rejected =>
            {
                let failed = state
                    .store
                    .fail_delegate_once_start(&DelegateOnceStartFailureRequestV1 {
                        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
                        task_id: receipt.task_id,
                        dispatch_id: receipt.dispatch_id,
                        generation: receipt.generation,
                        launch_idempotency_key: receipt.launch_idempotency_key,
                        error_code: failure.code,
                        failed_at_ms: now_ms()
                            .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
                            .max(receipt.created_at_ms),
                    })
                    .await
                    .map_err(workflow_store_error)?;
                return Ok(json!({ "schemaVersion": 1, "receipt": failed }));
            }
            Err(failure) => {
                return Err(BackendDispatchError {
                    code: failure.code,
                    message: "workflow Session launch did not produce a definitive receipt".into(),
                    details: Some(json!({ "receipt": receipt })),
                    disposition: BackendFailureDispositionV1::RetrySame,
                });
            }
        };
        if launched.validate_for_request(&launch).is_err() {
            return Err(BackendDispatchError {
                code: "workflow_launch_identity_mismatch".into(),
                message: "workflow Session launch returned a different identity".into(),
                details: Some(json!({ "receipt": receipt })),
                disposition: BackendFailureDispositionV1::RetrySame,
            });
        }
        let effective_launch_idempotency_key = launched.launch_idempotency_key;
        let launched_session = launched.session;
        state
            .store
            .bind_delegate_once_session(&DelegateOnceSessionBindingRequestV1 {
                schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
                task_id: receipt.task_id,
                dispatch_id: receipt.dispatch_id,
                generation: receipt.generation,
                launch_idempotency_key: receipt.launch_idempotency_key,
                effective_launch_idempotency_key,
                session: launched_session,
                bound_at_ms: now_ms()
                    .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
                    .max(receipt.created_at_ms),
            })
            .await
            .map_err(workflow_store_error)?
    } else {
        receipt
    };

    drop(workflow_guard);
    let delivered = deliver_delegate_once_prompt(state, &request, active).await?;
    let observed =
        observe_delegate_once_prompt_activity(state, delivered, &request.runtime_kind_id).await?;
    Ok(json!({ "schemaVersion": 1, "receipt": observed }))
}

async fn ensure_delegate_once_effective_launch(
    state: &ServiceState,
    receipt: DelegateOnceReceiptV1,
) -> Result<DelegateOnceReceiptV1, BackendDispatchError> {
    if receipt.effective_launch_idempotency_key.is_some()
        || !matches!(
            receipt.status,
            WorkflowDispatchStateV1::Active | WorkflowDispatchStateV1::Completed
        )
    {
        return Ok(receipt);
    }
    let session = receipt
        .session
        .as_ref()
        .ok_or_else(|| BackendDispatchError::from("workflow_launch_identity_mismatch"))?
        .clone();
    let effective_launch_idempotency_key = exact_managed_create_key(state, &session)?;
    state
        .store
        .repair_workflow_effective_launch(&WorkflowEffectiveLaunchRepairRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: receipt.task_id,
            dispatch_id: receipt.dispatch_id,
            generation: receipt.generation,
            session,
            effective_launch_idempotency_key,
            repaired_at_ms: now_ms()
                .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
                .max(receipt.updated_at_ms),
        })
        .await
        .map_err(workflow_store_error)?;
    state
        .store
        .delegate_once_receipt(&receipt.idempotency_key)
        .await
        .map_err(workflow_store_error)?
        .ok_or_else(|| BackendDispatchError::from("workflow_receipt_unavailable"))
}

fn delegate_once_needs_progress(receipt: &DelegateOnceReceiptV1) -> bool {
    receipt.status == WorkflowDispatchStateV1::Starting
        || (receipt.status == WorkflowDispatchStateV1::Active
            && receipt.prompt_delivery.as_ref().is_some_and(|prompt| {
                prompt.state == WorkflowPromptDeliveryStateV1::Pending
                    || (prompt.state == WorkflowPromptDeliveryStateV1::WrittenToPty
                        && prompt
                            .evidence
                            .as_ref()
                            .is_some_and(|evidence| evidence.activity().is_none()))
            }))
}

async fn deliver_delegate_once_prompt(
    state: &ServiceState,
    request: &DelegateOnceRequestV1,
    receipt: DelegateOnceReceiptV1,
) -> Result<DelegateOnceReceiptV1, BackendDispatchError> {
    if receipt.status != WorkflowDispatchStateV1::Active {
        return Ok(receipt);
    }
    let prompt = receipt
        .prompt_delivery
        .as_ref()
        .ok_or_else(|| BackendDispatchError::from("workflow_prompt_receipt_missing"))?;
    if prompt.state != WorkflowPromptDeliveryStateV1::Pending {
        return Ok(receipt);
    }
    let session = receipt
        .session
        .clone()
        .ok_or_else(|| BackendDispatchError::from("workflow_prompt_session_missing"))?;
    let handoff = prepare_delegate_once_handoff(request, &receipt).map_err(workflow_store_error)?;
    let delivery = WorkflowPromptDeliveryRequestV1 {
        runtime_kind_id: request.runtime_kind_id.clone(),
        delivery_idempotency_key: prompt.idempotency_key.clone(),
        session: session.clone(),
        intent: WorkflowPromptDeliveryIntentV1::FreshAgent,
        handoff,
    };
    let claimed_at_ms = now_ms()
        .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
        .max(receipt.updated_at_ms);
    let claim = state
        .store
        .claim_delegate_once_prompt(&DelegateOncePromptClaimRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: receipt.task_id.clone(),
            dispatch_id: receipt.dispatch_id.clone(),
            generation: receipt.generation,
            delivery_idempotency_key: prompt.idempotency_key.clone(),
            session: session.clone(),
            claimed_at_ms,
        })
        .await
        .map_err(workflow_store_error)?;
    if !claim.claimed {
        return Ok(claim.receipt);
    }
    let claimed = claim.receipt;
    if claimed.prompt_delivery.as_ref().map(|value| value.state)
        != Some(WorkflowPromptDeliveryStateV1::Uncertain)
    {
        return Ok(claimed);
    }

    let outcome = match state.workflow_prompt_deliverer.deliver(delivery).await {
        Ok(evidence) => WorkflowPromptDeliveryOutcomeV1::WrittenToPty(evidence),
        Err(failure) if !failure.may_have_written => WorkflowPromptDeliveryOutcomeV1::Failed {
            error_code: failure.code,
        },
        Err(failure) => {
            return Err(BackendDispatchError {
                code: failure.code,
                message: "workflow prompt delivery crossed an uncertain Hmux input boundary".into(),
                details: Some(json!({ "receipt": claimed })),
                disposition: BackendFailureDispositionV1::RetrySame,
            });
        }
    };
    let recorded_at_ms = now_ms()
        .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
        .max(claimed.updated_at_ms);
    state
        .store
        .record_delegate_once_prompt_outcome(&DelegateOncePromptOutcomeRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: claimed.task_id,
            dispatch_id: claimed.dispatch_id,
            generation: claimed.generation,
            delivery_idempotency_key: prompt.idempotency_key.clone(),
            session,
            outcome,
            recorded_at_ms,
        })
        .await
        .map_err(workflow_store_error)
}

async fn observe_delegate_once_prompt_activity(
    state: &ServiceState,
    receipt: DelegateOnceReceiptV1,
    runtime_kind_id: &RuntimeKindIdV1,
) -> Result<DelegateOnceReceiptV1, BackendDispatchError> {
    if receipt.status != WorkflowDispatchStateV1::Active {
        return Ok(receipt);
    }
    let prompt = receipt
        .prompt_delivery
        .as_ref()
        .ok_or_else(|| BackendDispatchError::from("workflow_prompt_receipt_missing"))?;
    if prompt.state != WorkflowPromptDeliveryStateV1::WrittenToPty {
        return Ok(receipt);
    }
    let evidence = prompt
        .evidence
        .as_ref()
        .ok_or_else(|| BackendDispatchError::from("workflow_prompt_evidence_missing"))?;
    if evidence.activity().is_some() {
        return Ok(receipt);
    }
    let session = receipt
        .session
        .clone()
        .ok_or_else(|| BackendDispatchError::from("workflow_prompt_session_missing"))?;
    let observation = WorkflowPromptActivityObservationRequestV1 {
        runtime_kind_id: runtime_kind_id.clone(),
        session: session.clone(),
        input_baseline_output_sequence: evidence.input_baseline_output_sequence().into(),
    };
    let activity = match state
        .workflow_prompt_activity_observer
        .observe(observation)
        .await
    {
        Ok(activity) => activity,
        Err(failure) => WorkflowPromptActivityReceiptV1 {
            state: WorkflowPromptActivityStateV1::Failed,
            observed_output_seq: failure.observed_output_seq,
            error_code: Some(failure.code),
        },
    };
    let observed_at_ms = now_ms()
        .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?
        .max(receipt.updated_at_ms);
    state
        .store
        .record_delegate_once_prompt_activity(&DelegateOncePromptActivityRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: receipt.task_id,
            dispatch_id: receipt.dispatch_id,
            generation: receipt.generation,
            delivery_idempotency_key: prompt.idempotency_key.clone(),
            session,
            activity,
            observed_at_ms,
        })
        .await
        .map_err(workflow_store_error)
}

async fn complete_delegate_once(
    state: &ServiceState,
    body: DelegateOnceCompleteBody,
) -> Result<Value, BackendDispatchError> {
    let completed_at_ms =
        now_ms().map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?;
    DelegateOnceCompletionRequestV1 {
        schema_version: body.schema_version,
        task_id: body.task_id.clone(),
        dispatch_id: body.dispatch_id.clone(),
        generation: body.generation,
        session: body.session.clone(),
        result: body.result.clone(),
        completed_at_ms,
    }
    .validate()
    .map_err(workflow_store_error)?;
    let context = state
        .store
        .orchestration_dispatch_context_for_exact_session(
            &body.task_id,
            &body.dispatch_id,
            body.generation,
            &body.session,
        )
        .await
        .map_err(orchestration_store_error)?;
    let result_markdown = body
        .result
        .unwrap_or_else(|| "The task is complete.".into());
    let current = state
        .store
        .delegate_once_receipt_for_dispatch(&body.task_id, &body.dispatch_id, body.generation)
        .await
        .map_err(workflow_store_error)?;
    if current.status == WorkflowDispatchStateV1::Completed {
        if current.result.as_deref() != Some(result_markdown.as_str()) {
            return Err(BackendDispatchError::from(
                "orchestration_idempotency_conflict",
            ));
        }
        let current = ensure_delegate_once_effective_launch(state, current).await?;
        return Ok(json!({ "schemaVersion": 1, "receipt": current }));
    }
    let identity = format!("{}:{}", body.dispatch_id, body.generation);
    let message_id = InteractionId::new(format!(
        "completion-{:x}",
        Sha256::digest(identity.as_bytes())
    ))
    .map_err(|_| BackendDispatchError::from("workflow_completion_identity_invalid"))?;
    state
        .store
        .interaction_service()
        .complete(CompleteDispatchRequest {
            schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
            idempotency_key: format!("legacy-complete-{:x}", Sha256::digest(identity.as_bytes())),
            message_id,
            target: context.target.clone(),
            expected_dispatch_revision: context.dispatch_revision,
            completed_by: context.participant,
            endpoint_fence: context.endpoint_fence,
            audience: Audience {
                grants: vec![context.coordinator_grant],
            },
            completion_capability: context.completion_capability,
            title: "Task complete".into(),
            result_markdown,
            completed_at_ms,
        })
        .await
        .map_err(orchestration_service_error)?;
    let receipt = state
        .store
        .delegate_once_receipt_for_dispatch(&body.task_id, &body.dispatch_id, body.generation)
        .await
        .map_err(workflow_store_error)?;
    let receipt = ensure_delegate_once_effective_launch(state, receipt).await?;
    Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
}

async fn show_delegate_once(
    state: &ServiceState,
    body: DelegateOnceShowBody,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != DELEGATE_ONCE_SCHEMA_VERSION_V1 || body.generation < 1 {
        return Err("workflow_request_invalid".into());
    }
    let receipt = state
        .store
        .delegate_once_receipt_for_dispatch(&body.task_id, &body.dispatch_id, body.generation)
        .await
        .map_err(workflow_store_error)?;
    let receipt = ensure_delegate_once_effective_launch(state, receipt).await?;
    Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
}

async fn create_existing_session_run(
    state: &ServiceState,
    body: RunCreateBody,
) -> Result<agent_orchestration::contract::CreateRunReceipt, BackendDispatchError> {
    if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION
        || body.target_reference.as_str() != CURRENT_SESSION_TARGET_REFERENCE
    {
        return Err("orchestration_request_invalid".into());
    }
    let session = neutral_worker_session(&body.session)?;
    verify_exact_orchestration_session(state, &body.session).await?;
    let run_authority = state
        .store
        .orchestration_run_authority_for_exact_session(&body.session)
        .await
        .map_err(orchestration_store_error)?;
    if run_authority.runtime_ref != body.runtime_ref {
        return Err("orchestration_generation_conflict".into());
    }

    let request = CreateRunRequest {
        schema_version: body.schema_version,
        authority: run_authority.authority,
        workflow_kind_ref: body.workflow_kind_ref,
        task: body.task,
        session,
        integration_receipt: body.integration_receipt,
        runtime_ref: body.runtime_ref,
        target_reference: body.target_reference,
        idempotency_key: body.idempotency_key,
        created_at_ms: body.created_at_ms,
    };
    let target = create_run_target(&request).map_err(orchestration_service_error)?;
    let context = orchestration_context_proposal(
        &target,
        worker_session_identity(&request.session).map_err(orchestration_service_error)?,
        &request.integration_receipt,
    )?;
    state
        .store
        .interaction_service()
        .create_run(request, context)
        .await
        .map_err(orchestration_service_error)
}

async fn verify_exact_orchestration_session(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
) -> Result<(), BackendDispatchError> {
    session.validate().map_err(orchestration_store_error)?;
    let stop_fence = HmuxStopFence {
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch: session.channel_epoch.clone(),
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
    };
    let hmux = query_hmux(
        &state.hmux_identity,
        &session.session_id,
        &session.workspace_id,
        &stop_fence,
    )
    .await
    .map_err(|_| {
        BackendDispatchError::from("orchestration_generation_conflict")
            .with_disposition(BackendFailureDispositionV1::StaleGeneration)
    })?;
    if hmux.provider_id != session.provider_id.as_str() {
        return Err(
            BackendDispatchError::from("orchestration_generation_conflict")
                .with_disposition(BackendFailureDispositionV1::StaleGeneration),
        );
    }
    Ok(())
}

fn rehost_generation_matches_session(
    generation: &hmux_client::ManagedRehostGeneration,
    session: &WorkflowSessionGenerationV1,
) -> bool {
    generation.session_id() == session.session_id
        && generation.workspace_id() == session.workspace_id
        && generation.runner_principal() == session.runner_principal
        && generation.runner_instance() == session.runner_instance
        && generation.channel_epoch() == session.channel_epoch
        && generation.host_instance_id() == session.host_instance_id
        && generation.terminal_epoch() == session.terminal_epoch
}

fn exact_managed_create_key(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
) -> Result<String, BackendDispatchError> {
    let receipt = completed_create_receipt(
        &state.hmux_identity.discovery_root,
        &session.workspace_id,
        &session.session_id,
    )
    .map_err(|_| BackendDispatchError::from("orchestration_generation_conflict"))?
    .ok_or_else(|| BackendDispatchError::from("orchestration_generation_conflict"))?;
    let fence = receipt
        .generation_fence()
        .ok_or_else(|| BackendDispatchError::from("orchestration_generation_conflict"))?;
    if receipt.provider_id() != session.provider_id.as_str()
        || !fence.matches_generation(
            &session.runner_principal,
            &session.runner_instance,
            &session.channel_epoch,
            &session.host_instance_id,
            &session.terminal_epoch,
        )
    {
        return Err(BackendDispatchError::from(
            "orchestration_generation_conflict",
        ));
    }
    Ok(receipt.idempotency_key().to_owned())
}

async fn exact_hmux_rehost_operation_id(
    state: &ServiceState,
    source: &WorkflowSessionGenerationV1,
    target: &WorkflowSessionGenerationV1,
    expected_permission_mode: Option<&ProviderPermissionModeV1>,
) -> Result<String, ExactHmuxRehostError> {
    let resolution_value = query_hmux_sessions(
        &state.hmux_identity,
        &[
            "managed-rehost-resolve".into(),
            "--session".into(),
            source.session_id.clone(),
            "--workspace".into(),
            source.workspace_id.clone(),
        ],
    )
    .await
    .map_err(|_| ExactHmuxRehostError::Unavailable)?;
    match resolution_value.get("state").and_then(Value::as_str) {
        Some("retry_required") => return Err(ExactHmuxRehostError::Unavailable),
        Some("not_found") => return Err(ExactHmuxRehostError::Conflict),
        _ => {}
    }
    let resolution: ManagedRehostResolution =
        serde_json::from_value(resolution_value).map_err(|_| ExactHmuxRehostError::Conflict)?;
    resolution
        .validate()
        .map_err(|_| ExactHmuxRehostError::Conflict)?;
    if resolution.provider_id() != source.provider_id.as_str()
        || source.provider_id != target.provider_id
        || !rehost_generation_matches_session(resolution.source_generation(), source)
        || !rehost_generation_matches_session(resolution.current_generation(), target)
        || expected_permission_mode.is_some_and(|expected| {
            provider_permission::from_hmux(resolution.permission_mode()) != *expected
        })
    {
        return Err(ExactHmuxRehostError::Conflict);
    }
    resolution
        .operation_ids()
        .last()
        .cloned()
        .ok_or(ExactHmuxRehostError::Conflict)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExactHmuxRehostError {
    Unavailable,
    Conflict,
}

async fn reconcile_orchestration_dispatch_session(
    state: &ServiceState,
    body: OrchestrationDispatchSessionReconcileBody,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION
        || body.expected.generation < 1
        || body.reconciled_at_ms < 0
    {
        return Err("orchestration_request_invalid".into());
    }
    body.target.validate().map_err(orchestration_store_error)?;
    let hmux_runtime_kind_id = RuntimeKindIdV1::new(HMUX_RUNTIME_KIND_ID)
        .map_err(|_| BackendDispatchError::from("orchestration_generation_conflict"))?;
    let reporting_agent_id = state
        .store
        .orchestration_reporting_agent_for_exact_dispatch(&body.expected)
        .await
        .map_err(orchestration_store_error)?;
    let _transition_guard = match reporting_agent_id.as_ref() {
        Some(agent_id) => Some(state.agent_operations.acquire(agent_id).await),
        None => None,
    };
    verify_exact_orchestration_session(state, &body.target).await?;
    let source = state
        .store
        .orchestration_session_for_dispatch_target(
            &body.expected.task_id,
            &body.expected.dispatch_id,
            body.expected.generation,
        )
        .await
        .map_err(orchestration_store_error)?;
    if source == body.target {
        let managed_create_key_state = state
            .store
            .exact_orchestration_dispatch_managed_create_key_state(
                &body.expected,
                &source,
                &hmux_runtime_kind_id,
            )
            .await
            .map_err(orchestration_store_error)?;
        if managed_create_key_state == OrchestrationManagedCreateKeyStateV1::Missing {
            let effective_launch_idempotency_key = exact_managed_create_key(state, &body.target)?;
            state
                .store
                .repair_orchestration_workflow_effective_launch(
                    &WorkflowEffectiveLaunchRepairRequestV1 {
                        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
                        task_id: body.expected.task_id.clone(),
                        dispatch_id: body.expected.dispatch_id.clone(),
                        generation: body.expected.generation,
                        session: body.target.clone(),
                        effective_launch_idempotency_key,
                        repaired_at_ms: body.reconciled_at_ms,
                    },
                    &hmux_runtime_kind_id,
                )
                .await
                .map_err(orchestration_store_error)?;
        }
        return Ok(json!({
            "schemaVersion": 1,
            "outcome": "current",
            "source": source,
            "target": body.target,
            "taskId": body.expected.task_id,
            "dispatchId": body.expected.dispatch_id,
            "generation": body.expected.generation,
        }));
    }
    if let Some(agent_id) = reporting_agent_id.as_ref() {
        if let Some(receipt) = state
            .store
            .reconcile_orchestration_dispatch_runtime_transition(
                agent_id,
                &body.expected,
                &source,
                &body.target,
                body.reconciled_at_ms,
            )
            .await
            .map_err(orchestration_store_error)?
        {
            return serde_json::to_value(receipt)
                .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"));
        }
    }
    let target_launch_idempotency_key = if state
        .store
        .orchestration_dispatch_uses_managed_create_key(&source)
        .await
        .map_err(orchestration_store_error)?
    {
        Some(exact_managed_create_key(state, &body.target)?)
    } else {
        None
    };
    let operation_id = exact_hmux_rehost_operation_id(state, &source, &body.target, None)
        .await
        .map_err(|_| BackendDispatchError::from("orchestration_generation_conflict"))?;
    let request = OrchestrationDispatchSessionRebindRequestV1 {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        operation_id,
        source,
        target: body.target,
        rebound_at_ms: body.reconciled_at_ms,
    };
    serde_json::to_value(
        state
            .store
            .reconcile_orchestration_dispatch_session(
                reporting_agent_id.as_ref(),
                &hmux_runtime_kind_id,
                &request,
                &body.expected,
                target_launch_idempotency_key.as_deref(),
            )
            .await
            .map_err(orchestration_store_error)?,
    )
    .map_err(|_| BackendDispatchError::from("orchestration_receipt_invalid"))
}

async fn exact_orchestration_context(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
) -> Result<DispatchContextReceipt, BackendDispatchError> {
    verify_exact_orchestration_session(state, session).await?;
    let target = state
        .store
        .orchestration_target_for_exact_session(session)
        .await
        .map_err(exact_context_error)?;
    let task_id = TaskIdV1::new(target.task_id.as_str())
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    let dispatch_id = DispatchIdV1::new(target.dispatch_id.as_str())
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    let generation = i64::try_from(target.generation.get())
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    state
        .store
        .orchestration_dispatch_context_for_exact_session(
            &task_id,
            &dispatch_id,
            generation,
            session,
        )
        .await
        .map_err(exact_context_error)
}

fn worker_audience_grant(
    context: &DispatchContextReceipt,
) -> Result<AudienceGrant, BackendDispatchError> {
    let evidence = format!(
        "{}:{}:{}",
        context.target.dispatch_id, context.endpoint_fence.endpoint_ref, context.participant
    );
    Ok(AudienceGrant {
        membership_ref: MembershipRef::new(format!(
            "membership-worker-{:x}",
            Sha256::digest(evidence.as_bytes())
        ))
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?,
        participant: context.participant.clone(),
        roles: vec![
            RoleRef::new("role.worker")
                .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?,
        ],
        capabilities: vec![context.delivery_capability.clone()],
        delivery_capability: context.delivery_capability.clone(),
    })
}

async fn open_exact_session_message(
    state: &ServiceState,
    body: ExactSessionMessageOpenBody,
) -> Result<agent_orchestration::contract::OpenInteractionReceipt, BackendDispatchError> {
    if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
        return Err(BackendDispatchError::terminal(
            "orchestration_request_invalid",
        ));
    }
    let expected_endpoint_ref = WorkerEndpointRef::new(&body.expected_endpoint_ref)
        .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
    let context = exact_orchestration_context(state, &body.session)
        .await
        .map_err(BackendDispatchError::stale_as_terminal)?;
    if expected_endpoint_ref != context.endpoint_fence.endpoint_ref {
        return Err(BackendDispatchError::terminal(
            "orchestration_generation_conflict",
        ));
    }
    let session = body.session.clone();
    let interaction_id = InteractionId::new(body.interaction_id)
        .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
    let worker_grant = worker_audience_grant(&context)
        .map_err(|error| error.with_disposition(BackendFailureDispositionV1::Terminal))?;
    let mut receipt = state
        .store
        .interaction_service()
        .open(OpenInteractionRequest {
            schema_version: body.schema_version,
            idempotency_key: body.idempotency_key,
            write_capability: context.interaction_capability.clone(),
            expected_dispatch_revision: context.dispatch_revision,
            opened_at_ms: body.opened_at_ms,
            interaction: InteractionDraft::Message {
                common: InteractionDraftCommon {
                    id: interaction_id,
                    target: context.target.clone(),
                    author: context.coordinator_grant.participant.clone(),
                    audience: Audience {
                        grants: vec![worker_grant],
                    },
                    title: body.title,
                    description_markdown: body.description_markdown,
                },
                purpose: MessagePurpose::Update,
            },
        })
        .await
        .map_err(exact_message_error)?;
    interaction_wake::wake_exact_session_delivery(
        state,
        &session,
        &context,
        &mut receipt.deliveries,
        body.opened_at_ms,
    )
    .await?;
    Ok(receipt)
}

async fn answer_exact_session_decision(
    state: &ServiceState,
    body: ExactSessionDecisionAnswerBody,
) -> Result<AnswerDecisionReceipt, BackendDispatchError> {
    if body.schema_version != agent_orchestration::domain::INTERACTION_SCHEMA_VERSION {
        return Err(BackendDispatchError::terminal(
            "orchestration_request_invalid",
        ));
    }
    let expected_reply_capability = CapabilityRef::new(&body.expected_reply_capability)
        .map_err(|_| BackendDispatchError::terminal("orchestration_request_invalid"))?;
    let context = exact_orchestration_context(state, &body.session).await?;
    if expected_reply_capability != context.coordinator_reply_capability {
        return Err(
            BackendDispatchError::from("orchestration_generation_conflict")
                .with_disposition(BackendFailureDispositionV1::StaleGeneration),
        );
    }
    let session = body.session.clone();
    let mut receipt = state
        .store
        .interaction_service()
        .answer(AnswerDecisionRequest {
            schema_version: body.schema_version,
            idempotency_key: body.idempotency_key,
            interaction_id: body.interaction_id,
            target: context.target.clone(),
            expected_revision: body.expected_revision,
            expected_dispatch_revision: body.expected_dispatch_revision,
            answered_by: context.coordinator_grant.participant.clone(),
            reply_capability: context.coordinator_reply_capability.clone(),
            answer: body.answer,
            answered_at_ms: body.answered_at_ms,
        })
        .await
        .map_err(exact_decision_error)?;
    interaction_wake::wake_exact_session_delivery(
        state,
        &session,
        &context,
        &mut receipt.deliveries,
        body.answered_at_ms,
    )
    .await?;
    Ok(receipt)
}

fn neutral_worker_session(
    session: &WorkflowSessionGenerationV1,
) -> Result<WorkerSessionGeneration, BackendDispatchError> {
    let invalid = |_| BackendDispatchError::from("orchestration_request_invalid");
    Ok(WorkerSessionGeneration {
        session_id: SessionRef::new(&session.session_id).map_err(invalid)?,
        workspace_id: WorkspaceId::new(&session.workspace_id).map_err(invalid)?,
        provider_id: ProviderRef::new(session.provider_id.as_str()).map_err(invalid)?,
        runner_principal: RunnerPrincipalRef::new(&session.runner_principal).map_err(invalid)?,
        runner_instance: RunnerInstanceRef::new(&session.runner_instance).map_err(invalid)?,
        channel_epoch: ChannelEpochRef::new(&session.channel_epoch).map_err(invalid)?,
        host_instance_id: HostInstanceRef::new(&session.host_instance_id).map_err(invalid)?,
        terminal_epoch: TerminalEpochRef::new(&session.terminal_epoch).map_err(invalid)?,
    })
}

async fn resolve_dispatch_context(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
) -> Result<DispatchContextReceipt, BackendDispatchError> {
    let target = dispatch_context_target(state, session).await?;
    let task_id = TaskIdV1::new(target.task_id.as_str())
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    let dispatch_id = DispatchIdV1::new(target.dispatch_id.as_str())
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    let generation = i64::try_from(target.generation.get())
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    state
        .store
        .orchestration_dispatch_context_for_exact_session(
            &task_id,
            &dispatch_id,
            generation,
            session,
        )
        .await
        .map_err(dispatch_context_error)
}

fn orchestration_context_proposal(
    target: &InteractionTarget,
    session_identity: SessionIdentityRef,
    integration_receipt: &IntegrationCapabilityReceipt,
) -> Result<DispatchContextReceipt, BackendDispatchError> {
    let interaction_capability = capability("capability-interaction")?;
    let completion_capability = capability("capability-completion")?;
    let delivery_capability = capability("capability-worker-inbox")?;
    let acknowledgement_capability = capability("capability-worker-ack")?;
    let wake_capability = Some(capability("capability-worker-wake")?);
    let coordinator_delivery_capability = capability("capability-coordinator-inbox")?;
    let coordinator_reply_capability = capability("capability-coordinator-reply")?;
    let participant = ParticipantRef::new(random_opaque_reference("participant-worker")?)
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    let coordinator_participant =
        ParticipantRef::new(random_opaque_reference("participant-coordinator")?)
            .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    let endpoint_fence = WorkerEndpointFence {
        endpoint_ref: WorkerEndpointRef::new(random_opaque_reference("endpoint")?)
            .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?,
        session_identity,
        generation: target.generation,
        delivery_capability: delivery_capability.clone(),
        acknowledgement_capability: acknowledgement_capability.clone(),
    };
    let receipt = DispatchContextReceipt {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        target: target.clone(),
        dispatch_revision: agent_orchestration::domain::Revision::INITIAL,
        dispatch_state: agent_orchestration::domain::DispatchState::Active,
        successor_required: false,
        participant,
        interaction_capability,
        completion_capability,
        delivery_capability,
        acknowledgement_capability,
        wake_capability,
        endpoint_fence,
        coordinator_grant: AudienceGrant {
            membership_ref: MembershipRef::new(random_opaque_reference("membership")?)
                .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?,
            participant: coordinator_participant,
            roles: vec![
                RoleRef::new("role.coordinator")
                    .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?,
            ],
            capabilities: vec![
                coordinator_delivery_capability.clone(),
                coordinator_reply_capability.clone(),
            ],
            delivery_capability: coordinator_delivery_capability,
        },
        coordinator_reply_capability,
        integration_receipt: integration_receipt.clone(),
    };
    receipt
        .validate()
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))?;
    Ok(receipt)
}

fn capability(prefix: &str) -> Result<CapabilityRef, BackendDispatchError> {
    CapabilityRef::new(random_opaque_reference(prefix)?)
        .map_err(|_| BackendDispatchError::from("orchestration_context_invalid"))
}

fn orchestration_service_error(error: ServiceError) -> BackendDispatchError {
    let (code, details) = match error {
        ServiceError::Invalid { field, code } => (
            "orchestration_request_invalid",
            Some(json!({ "field": field, "reasonCode": code })),
        ),
        ServiceError::NotFound { resource } => (
            "orchestration_record_not_found",
            Some(json!({ "resource": resource })),
        ),
        ServiceError::IdempotencyConflict => ("orchestration_idempotency_conflict", None),
        ServiceError::GenerationConflict => ("orchestration_generation_conflict", None),
        ServiceError::RevisionConflict => ("orchestration_revision_conflict", None),
        ServiceError::CapabilityDenied => ("orchestration_capability_denied", None),
        ServiceError::StateConflict { code } => (
            "orchestration_state_conflict",
            Some(json!({ "reasonCode": code })),
        ),
        ServiceError::StorageUnavailable { .. } => ("orchestration_store_unavailable", None),
        ServiceError::StorageCorrupt { .. } => ("orchestration_store_corrupt", None),
    };
    BackendDispatchError {
        code: code.into(),
        message: "orchestration service rejected the operation".into(),
        details,
        disposition: BackendFailureDispositionV1::RetrySame,
    }
}

fn orchestration_store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    let (code, details) = match error {
        DomainStoreErrorV1::InvalidRecord { field, .. } => (
            "orchestration_request_invalid",
            Some(json!({ "field": field })),
        ),
        DomainStoreErrorV1::NotFound { .. } => ("orchestration_record_not_found", None),
        DomainStoreErrorV1::IdentityConflict { .. } => ("orchestration_generation_conflict", None),
        DomainStoreErrorV1::IdempotencyConflict { .. } => {
            ("orchestration_idempotency_conflict", None)
        }
        _ => ("orchestration_store_unavailable", None),
    };
    BackendDispatchError {
        code: code.into(),
        message: "orchestration store rejected the operation".into(),
        details,
        disposition: BackendFailureDispositionV1::RetrySame,
    }
}

fn dispatch_context_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    let disposition = match &error {
        DomainStoreErrorV1::NotFound { .. } => BackendFailureDispositionV1::Unassigned,
        DomainStoreErrorV1::IdentityConflict { .. } => BackendFailureDispositionV1::StaleGeneration,
        DomainStoreErrorV1::InvalidRecord { .. } => BackendFailureDispositionV1::Terminal,
        _ => BackendFailureDispositionV1::RetrySame,
    };
    orchestration_store_error(error).with_disposition(disposition)
}

fn exact_context_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    let disposition = match &error {
        DomainStoreErrorV1::NotFound { .. } | DomainStoreErrorV1::IdentityConflict { .. } => {
            BackendFailureDispositionV1::StaleGeneration
        }
        DomainStoreErrorV1::InvalidRecord { .. } => BackendFailureDispositionV1::Terminal,
        _ => BackendFailureDispositionV1::RetrySame,
    };
    orchestration_store_error(error).with_disposition(disposition)
}

async fn dispatch_context_target(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
) -> Result<InteractionTarget, BackendDispatchError> {
    let error = match state
        .store
        .orchestration_target_for_exact_session(session)
        .await
    {
        Ok(target) => return Ok(target),
        Err(error) => error,
    };
    if !matches!(&error, DomainStoreErrorV1::IdentityConflict { .. }) {
        return Err(dispatch_context_error(error));
    }
    let inspection = state
        .store
        .inspect_orchestration_dispatch_session(session)
        .await
        .map_err(dispatch_context_error)?;
    let disposition = if inspection.target.is_none() {
        verify_exact_orchestration_session(state, session).await?;
        BackendFailureDispositionV1::Unassigned
    } else {
        BackendFailureDispositionV1::StaleGeneration
    };
    Err(orchestration_store_error(error).with_disposition(disposition))
}

fn exact_message_error(error: ServiceError) -> BackendDispatchError {
    let disposition = match &error {
        ServiceError::StorageUnavailable { .. } | ServiceError::StorageCorrupt { .. } => {
            BackendFailureDispositionV1::RetrySame
        }
        _ => BackendFailureDispositionV1::Terminal,
    };
    orchestration_service_error(error).with_disposition(disposition)
}

fn exact_decision_error(error: ServiceError) -> BackendDispatchError {
    let disposition = match &error {
        ServiceError::Invalid { .. } => BackendFailureDispositionV1::Terminal,
        ServiceError::StorageUnavailable { .. } | ServiceError::StorageCorrupt { .. } => {
            BackendFailureDispositionV1::RetrySame
        }
        _ => BackendFailureDispositionV1::StaleGeneration,
    };
    orchestration_service_error(error).with_disposition(disposition)
}

fn binding_ensure_error(code: String) -> BackendDispatchError {
    let terminal = matches!(
        code.as_str(),
        "agent_checkpoint_binding_invalid"
            | "agent_checkpoint_binding_runtime_owned"
            | "agent_checkpoint_binding_launch_authority_stale"
            | "agent_checkpoint_binding_credential_authority_unsupported"
            | "agent_checkpoint_binding_profile_stale"
            | "agent_checkpoint_binding_workspace_stale"
            | "agent_checkpoint_binding_identity_mismatch"
    );
    let error = BackendDispatchError::from(code);
    if terminal {
        error.with_disposition(BackendFailureDispositionV1::Terminal)
    } else {
        error
    }
}

async fn ensure_binding(state: &ServiceState, body: BindingEnsureBody) -> Result<Value, String> {
    agent_checkpoint_binding::ensure(state, body).await
}

async fn write_checkpoint(
    state: &ServiceState,
    request: AgentCheckpointWriteRequestV1,
) -> Result<Value, String> {
    let _guard = state
        .agent_operations
        .acquire(&request.identity.agent_id)
        .await;
    let authority = binding_authority(&state.store, &request.identity.agent_id)
        .await?
        .ok_or_else(|| "agent_checkpoint_binding_stale".to_string())?;
    if authority.binding.session_id != request.identity.session_id
        || authority.binding.binding_generation != request.identity.binding_generation
    {
        return Err("agent_checkpoint_binding_stale".into());
    }
    probe_runtime_binding(&state.runtime_adapters, authority).await?;
    let receipt = state
        .store
        .write_agent_checkpoint(&request)
        .await
        .map_err(|error| format!("agent_checkpoint_write_failed:{error}"))?;
    Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
}

async fn observe_checkpoints(state: &ServiceState, body: ObserveBody) -> Result<Value, String> {
    if body.schema_version != AGENT_CHECKPOINT_SCHEMA_VERSION_V1 || body.agent_ids.len() > 256 {
        return Err("agent_checkpoint_observe_invalid".into());
    }
    let mut unique = std::collections::BTreeSet::new();
    if body
        .agent_ids
        .iter()
        .any(|agent_id| !unique.insert(agent_id.clone()))
    {
        return Err("agent_checkpoint_observe_invalid".into());
    }
    let observations = state
        .store
        .agent_checkpoint_observations(&body.agent_ids)
        .await
        .map_err(|_| "agent_checkpoint_observe_failed".to_string())?;
    // Observation is a durable-state read and carries no runtime probe. The
    // authorization fence (exact binding CAS + live hmux probe) belongs to
    // ensure/write — the charter says the identity "is not a claim about
    // runtime liveness". Probing here also let one retired fence fail the
    // whole batch, starving every agent's sidebar projection after a rehost
    // with no newer write (2026-08-13 frozen-checkpoint defect).
    let mut records = Vec::new();
    for observation in observations {
        let Some(record) = observation.checkpoint else {
            continue;
        };
        let authority = observation.authority;
        let fence = authority_stop_fence(&authority);
        records.push(json!({
            "record": record,
            "binding": {
                "sessionId": authority.binding.session_id,
                "workspaceId": authority.runtime_workspace_id,
                "bindingGeneration": authority.binding.binding_generation,
                "stopFence": fence,
            }
        }));
    }
    records.sort_by(|left, right| {
        left["record"]["agentId"]
            .as_str()
            .cmp(&right["record"]["agentId"].as_str())
    });
    Ok(json!({ "schemaVersion": 1, "records": records }))
}

async fn dispatch_authorized(
    state: &ServiceState,
    authority: BackendRequestAuthority,
    request: &BackendRequest,
) -> Result<Value, BackendDispatchError> {
    if request
        .expected
        .required_capabilities
        .iter()
        .any(|capability| capability == "plugin.slack")
        && !pro_features::available()
    {
        return Err(BackendDispatchError::terminal("slack_pro_development_only"));
    }
    #[cfg(unix)]
    if request.operation == slack_connector::OPERATION {
        return state.slack.dispatch(&request.body).await;
    }
    #[cfg(unix)]
    if request.operation == browser_service::OPERATION {
        return state.browser.dispatch(&state.store, &request.body).await;
    }
    if let Some(result) = state
        .agent_conversations
        .dispatch(&request.operation, &request.body)
        .await
    {
        return result.map_err(agent_conversation_api_error);
    }
    match request.operation.as_str() {
        #[cfg(unix)]
        "workspace_environment.invoke" => workspace_environment::invoke(state, &request.body).await,
        "agent_goal.get" | "agent_goal.put" => {
            agent_goal::invoke(state, &request.operation, &request.body).await
        }
        "backend.scope" => {
            if request.body != json!({ "schemaVersion": 1 }) {
                return Err(BackendDispatchError::terminal(
                    "backend_scope_request_invalid",
                ));
            }
            Ok(json!({ "schemaVersion": 1, "scopeId": state.scope_id }))
        }
        "backend.shutdown" => {
            let body: BackendShutdownBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "backend_shutdown_invalid".to_string())?;
            if body.schema_version != 2 {
                return Err("backend_shutdown_invalid".into());
            }
            match (body.mode.as_str(), body.target) {
                ("stop", None) if state.is_mutation_authority() => {}
                ("replace", Some(target_hint)) => {
                    let intent = read_shutdown_replacement_intent(state)?;
                    if !valid_replacement_direction(
                        Some(control_plane_build_id()),
                        &intent.target.build_id,
                    ) {
                        return Err("backend_shutdown_downgrade_rejected".into());
                    }
                    if intent.target != target_hint {
                        return Err("backend_shutdown_intent_mismatch".into());
                    }
                }
                _ => return Err("backend_shutdown_invalid".into()),
            }
            Ok(json!({ "schemaVersion": 1, "status": "stopping" }))
        }
        "backend.ping" => {
            if request.body != json!({ "schemaVersion": 1 }) {
                return Err("backend_ping_invalid".into());
            }
            Ok(json!({ "schemaVersion": 1, "status": "ready" }))
        }
        "agent_spawn.preview" => preview_agent_spawn(state, &authority, &request.body)
            .await
            .map_err(Into::into),
        "agent_spawn.apply" => {
            let body: agent_spawn_apply::AgentSpawnApplyBody =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "agent_spawn_apply_request_invalid".to_string())?;
            apply_agent_spawn(state, &authority, body).await
        }
        "agent_spawn.status" => {
            let body: agent_spawn_api::AgentSpawnStatusBody =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "agent_spawn_status_request_invalid".to_string())?;
            show_agent_spawn(state, body).await.map_err(Into::into)
        }
        "provider_launch_defaults.get"
        | "provider_launch_defaults.put"
        | "provider_credential_profile.register"
        | "provider_catalog.read" => provider_commands::dispatch(state, request).await,
        #[cfg(unix)]
        agent_conversation_api::RECOVER_OPERATION => {
            let body: agent_conversation_recover::AgentConversationRecoverBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    agent_conversation_api_error(
                        agent_conversation_api::AgentConversationApiErrorV1::RequestInvalid,
                    )
                })?;
            let binding = agent_conversation_recover::recover(state, body)
                .await
                .map_err(agent_conversation_api_error)?;
            Ok(json!({ "schemaVersion": 1, "binding": binding }))
        }
        #[cfg(unix)]
        "dispatch.stop.preview" => {
            let body: agent_dispatch_stop_apply::DispatchStopPreviewBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::terminal("agent_dispatch_stop_request_invalid")
                })?;
            agent_dispatch_stop_apply::preview(state, &request.request_id, body).await
        }
        #[cfg(unix)]
        "dispatch.stop.apply" => {
            let body: agent_dispatch_stop_apply::DispatchStopApplyBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::terminal("agent_dispatch_stop_request_invalid")
                })?;
            agent_dispatch_stop_apply::apply(state, body).await
        }
        #[cfg(unix)]
        "dispatch.stop.status" => {
            let body: agent_dispatch_stop_apply::DispatchStopStatusBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::terminal("agent_dispatch_stop_request_invalid")
                })?;
            agent_dispatch_stop_apply::status(state, body).await
        }
        #[cfg(unix)]
        "agent_runtime.transition"
        | "agent_runtime.repair"
        | "agent_runtime.repair_intent.inspect.v1"
        | "agent_runtime.inspect"
        | "agent_runtime.projection.inspect"
        | "agent_runtime.native.read"
        | "agent_runtime.native.input"
        | "agent_runtime.native_rehost.reconcile"
        | "agent_runtime.native_resume.publish"
        | "agent_runtime.stop"
        | "agent_runtime.remove"
        | "agent_runtime.hibernate"
        | "agent_runtime.idle.inspect"
        | "agent_runtime.idle.configure"
        | "agent_runtime.wake" => agent_runtime_api::dispatch(state, request).await,
        #[cfg(unix)]
        "claude_conversation.open" => {
            let runtime = state.claude_runtime.as_ref().ok_or_else(|| {
                BackendDispatchError::from("claude_conversation_runtime_unavailable")
            })?;
            let body: claude_structured_runtime::ClaudeConversationOpenBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::from("claude_conversation_request_invalid")
                })?;
            if body.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1 {
                return Err("claude_conversation_request_invalid".into());
            }
            let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
            agent_runtime_close_apply::reject_if_closed(
                state,
                &body.agent_id,
                "claude_conversation_not_found",
            )
            .await?;
            let selection = state
                .store
                .agent_runtime_selection(&body.agent_id)
                .await
                .map_err(|_| {
                    claude_structured_runtime_error(
                        claude_structured_runtime::ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable,
                    )
                })?;
            let open_request =
                claude_structured_runtime::ClaudeStructuredOpenRequestV1::from_committed_or_legacy(
                    body.agent_id,
                    body.execution_profile,
                    body.provider_conversation_ref,
                    selection.as_ref(),
                )
                .map_err(claude_structured_runtime_error)?;
            let runtime = Arc::clone(runtime);
            let receipt = tokio::spawn(async move { runtime.open(open_request).await })
                .await
                .map_err(|_| {
                    claude_structured_runtime_error(
                    claude_structured_runtime::ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable,
                )
                })?
                .map_err(claude_structured_runtime_error)?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        #[cfg(unix)]
        "claude_conversation.launch" => {
            let runtime = state.claude_runtime.as_ref().ok_or_else(|| {
                BackendDispatchError::from("claude_conversation_runtime_unavailable")
            })?;
            let body: claude_structured_runtime::ClaudeConversationLaunchBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::from("claude_conversation_request_invalid")
                })?;
            if body.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1 {
                return Err("claude_conversation_request_invalid".into());
            }
            let binding = state
                .store
                .agent_interaction(&body.interaction_session_id)
                .await
                .map_err(|_| BackendDispatchError::from("claude_conversation_store_failed"))?
                .ok_or_else(|| BackendDispatchError::terminal("claude_conversation_not_found"))?;
            let _agent_guard = state.agent_operations.acquire(&binding.agent_id).await;
            agent_runtime_close_apply::reject_if_closed(
                state,
                &binding.agent_id,
                "claude_conversation_not_found",
            )
            .await?;
            let runtime = Arc::clone(runtime);
            let receipt = tokio::spawn(async move {
                runtime
                    .launch(claude_structured_runtime::ClaudeStructuredLaunchRequestV1 {
                        interaction_session_id: body.interaction_session_id,
                    })
                    .await
            })
            .await
            .map_err(|_| {
                claude_structured_runtime_error(
                    claude_structured_runtime::ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable,
                )
            })?
            .map_err(claude_structured_runtime_error)?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        #[cfg(unix)]
        "claude_conversation.stop" => {
            let body: claude_structured_runtime::ClaudeConversationStopBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::from("claude_conversation_request_invalid")
                })?;
            if body.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1 {
                return Err("claude_conversation_request_invalid".into());
            }
            let binding = state
                .store
                .agent_interaction(&body.interaction_session_id)
                .await
                .map_err(|_| BackendDispatchError::from("claude_conversation_store_failed"))?
                .ok_or_else(|| BackendDispatchError::terminal("claude_conversation_not_found"))?;
            agent_runtime_close_apply::apply_observed(
                state,
                &request.request_id,
                agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
                    schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                    agent_id: binding.agent_id,
                },
                Some(agent_runtime_close_apply::AgentRuntimeStopObservationV1 {
                    interaction_session_id: body.interaction_session_id,
                    runtime_generation: body.runtime_generation,
                }),
            )
            .await
        }
        "agent_checkpoint.binding.ensure" => {
            let body: BindingEnsureBody = serde_json::from_value(request.body.clone())
                .map_err(|_| binding_ensure_error("agent_checkpoint_binding_invalid".into()))?;
            ensure_binding(state, body)
                .await
                .map_err(binding_ensure_error)
        }
        "agent_checkpoint.observe" => {
            let body: ObserveBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "agent_checkpoint_observe_invalid".to_string())?;
            observe_checkpoints(state, body).await.map_err(Into::into)
        }
        "agent_checkpoint.read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ReadBody {
                schema_version: u16,
                identity: AgentCheckpointIdentityV1,
            }
            let body: ReadBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "agent_checkpoint_request_invalid".to_string())?;
            if body.schema_version != AGENT_CHECKPOINT_SCHEMA_VERSION_V1 {
                return Err("agent_checkpoint_request_invalid".into());
            }
            let record = state
                .store
                .agent_checkpoint(&body.identity)
                .await
                .map_err(|error| format!("agent_checkpoint_read_failed:{error}"))?;
            Ok(json!({ "schemaVersion": 1, "record": record }))
        }
        "agent_checkpoint.write" => {
            let body: AgentCheckpointWriteRequestV1 = serde_json::from_value(request.body.clone())
                .map_err(|_| "agent_checkpoint_request_invalid".to_string())?;
            write_checkpoint(state, body).await.map_err(Into::into)
        }
        "client_view.authority.read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ReadBody {
                schema_version: u16,
                namespace: ClientViewNamespaceV1,
            }
            let body: ReadBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "client_view_request_invalid".to_string())?;
            if body.schema_version != CLIENT_VIEW_STATE_SCHEMA_VERSION_V1 {
                return Err("client_view_request_invalid".into());
            }
            let authority = state
                .store
                .client_view_authority(&body.namespace)
                .await
                .map_err(client_view_error)?;
            Ok(json!({ "schemaVersion": 1, "authority": authority }))
        }
        "client_view.generation.advance" => {
            let body: ClientViewGenerationAdvanceRequestV1 =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "client_view_request_invalid".to_string())?;
            let receipt = state
                .store
                .advance_client_view_generation(&body)
                .await
                .map_err(client_view_error)?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        "client_view.read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ReadBody {
                schema_version: u16,
                identity: ClientViewIdentityV1,
            }
            let body: ReadBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "client_view_request_invalid".to_string())?;
            if body.schema_version != CLIENT_VIEW_STATE_SCHEMA_VERSION_V1 {
                return Err("client_view_request_invalid".into());
            }
            let record = state
                .store
                .client_view(&body.identity)
                .await
                .map_err(client_view_error)?;
            Ok(json!({ "schemaVersion": 1, "record": record }))
        }
        "client_view.write" => {
            let body: ClientViewWriteRequestV1 = serde_json::from_value(request.body.clone())
                .map_err(|_| "client_view_request_invalid".to_string())?;
            let receipt = state
                .store
                .write_client_view(&body)
                .await
                .map_err(client_view_error)?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        "projects.list" => {
            let body: ProjectsListBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "backend_projects_request_invalid".to_string())?;
            list_projects(state, body).await.map_err(Into::into)
        }
        "projects.register" => {
            let body: ProjectsRegisterBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "backend_project_registration_invalid".to_string())?;
            register_backend_project(state, body)
                .await
                .map_err(Into::into)
        }
        "projects.show" => {
            let body: ProjectsShowBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "backend_projects_request_invalid".to_string())?;
            show_project(state, body).await.map_err(Into::into)
        }
        operation if operation.starts_with("schedule.") => {
            schedule_runtime::invoke(state, operation, &request.body).await
        }
        "sessions.list" => {
            let body: SessionsListBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "dure_session_query_invalid".to_string())?;
            list_sessions(state, body).await.map_err(Into::into)
        }
        "sessions.read" => {
            let body: SessionsReadBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "dure_session_read_invalid".to_string())?;
            read_session(state, body).await.map_err(Into::into)
        }
        "sessions.show" => {
            let body: SessionsShowBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "dure_session_query_invalid".to_string())?;
            show_session(state, body).await.map_err(Into::into)
        }
        "orchestration.invoke" => {
            let body: OrchestrationInvokeBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "orchestration_request_invalid".to_string())?;
            invoke_orchestration(state, body).await
        }
        "workflow.delegate_once" => {
            let body: DelegateOnceRequestV1 = serde_json::from_value(request.body.clone())
                .map_err(|_| "workflow_request_invalid".to_string())?;
            delegate_once(state, body).await
        }
        "workflow.delegate_once.complete" => {
            let body: DelegateOnceCompleteBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "workflow_request_invalid".to_string())?;
            complete_delegate_once(state, body).await
        }
        "workflow.delegate_once.show" => {
            let body: DelegateOnceShowBody = serde_json::from_value(request.body.clone())
                .map_err(|_| "workflow_request_invalid".to_string())?;
            show_delegate_once(state, body).await
        }
        _ => Err("backend_operation_unsupported".into()),
    }
}

fn agent_conversation_api_error(
    error: agent_conversation_api::AgentConversationApiErrorV1,
) -> BackendDispatchError {
    use agent_conversation_api::AgentConversationApiErrorV1;

    let disposition = match error {
        AgentConversationApiErrorV1::RequestInvalid
        | AgentConversationApiErrorV1::NotFound
        | AgentConversationApiErrorV1::ProviderFailed => BackendFailureDispositionV1::Terminal,
        AgentConversationApiErrorV1::Conflict => BackendFailureDispositionV1::StaleGeneration,
        AgentConversationApiErrorV1::RuntimeUnavailable
        | AgentConversationApiErrorV1::StoreFailed => BackendFailureDispositionV1::RetrySame,
    };
    BackendDispatchError {
        code: error.code().into(),
        message: error.code().into(),
        details: None,
        disposition,
    }
}

#[cfg(unix)]
fn structured_provider_runtime_error(
    error: structured_provider_runtime::StructuredProviderRuntimeErrorV1,
) -> BackendDispatchError {
    use structured_provider_runtime::StructuredProviderRuntimeErrorKindV1 as Kind;

    let disposition = match error.kind {
        Kind::RequestInvalid | Kind::ExplicitRecoveryRequired => {
            BackendFailureDispositionV1::Terminal
        }
        Kind::RuntimeConflict | Kind::CredentialStale | Kind::SourceBusy => {
            BackendFailureDispositionV1::StaleGeneration
        }
        Kind::RuntimeUnavailable
        | Kind::CredentialUnavailable
        | Kind::LaunchFailed
        | Kind::StopFailed => BackendFailureDispositionV1::RetrySame,
    };
    let details = error.detail.map(|detail| json!({ "detail": detail }));
    BackendDispatchError {
        message: error.code.clone(),
        code: error.code,
        details,
        disposition,
    }
}

fn provider_credential_profile_error(
    error: provider_credential_profile::ProviderCredentialProfileErrorV1,
) -> BackendDispatchError {
    use provider_credential_profile::ProviderCredentialProfileErrorV1;

    let disposition = match error {
        ProviderCredentialProfileErrorV1::RequestInvalid
        | ProviderCredentialProfileErrorV1::Conflict => BackendFailureDispositionV1::Terminal,
        ProviderCredentialProfileErrorV1::StaleGeneration => {
            BackendFailureDispositionV1::StaleGeneration
        }
        ProviderCredentialProfileErrorV1::Unavailable
        | ProviderCredentialProfileErrorV1::StoreFailed => BackendFailureDispositionV1::RetrySame,
    };
    BackendDispatchError {
        code: error.code().into(),
        message: error.code().into(),
        details: None,
        disposition,
    }
}

#[cfg(unix)]
fn claude_structured_runtime_error(
    error: claude_structured_runtime::ClaudeStructuredRuntimeErrorV1,
) -> BackendDispatchError {
    use claude_structured_runtime::ClaudeStructuredRuntimeErrorV1;

    let disposition = match error {
        ClaudeStructuredRuntimeErrorV1::CredentialStale
        | ClaudeStructuredRuntimeErrorV1::RuntimeConflict => {
            BackendFailureDispositionV1::StaleGeneration
        }
        ClaudeStructuredRuntimeErrorV1::RelayLaunchFailed
        | ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryPending
        | ClaudeStructuredRuntimeErrorV1::RelayReadinessFailed
        | ClaudeStructuredRuntimeErrorV1::HostAttachFailed
        | ClaudeStructuredRuntimeErrorV1::HostAttachUncertain
        | ClaudeStructuredRuntimeErrorV1::JournalFailed
        | ClaudeStructuredRuntimeErrorV1::StopFailed
        | ClaudeStructuredRuntimeErrorV1::SourceBusy => BackendFailureDispositionV1::RetrySame,
        ClaudeStructuredRuntimeErrorV1::RequestInvalid
        | ClaudeStructuredRuntimeErrorV1::HostAttachRecoveryRequired
        | ClaudeStructuredRuntimeErrorV1::RelayReadinessRecoveryRequired
        | ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryRequired
        | ClaudeStructuredRuntimeErrorV1::RuntimeLaunchRequired
        | ClaudeStructuredRuntimeErrorV1::RuntimeUnavailable
        | ClaudeStructuredRuntimeErrorV1::CredentialUnavailable => {
            BackendFailureDispositionV1::Terminal
        }
    };
    BackendDispatchError {
        code: error.code().into(),
        message: error.code().into(),
        details: None,
        disposition,
    }
}

#[cfg(test)]
async fn dispatch(
    state: &ServiceState,
    request: &BackendRequest,
) -> Result<Value, BackendDispatchError> {
    let authority =
        validate_request(request, state).map_err(BackendDispatchError::from)?;
    dispatch_authorized(state, authority, request).await
}

fn client_view_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    let (code, details) = match &error {
        DomainStoreErrorV1::ClientViewGenerationConflict {
            client_id,
            expected_generation,
            actual_generation,
        } => (
            "client_view_generation_conflict",
            Some(json!({
                "clientId": client_id,
                "expectedGeneration": expected_generation,
                "actualGeneration": actual_generation,
            })),
        ),
        DomainStoreErrorV1::ClientViewInstanceConflict {
            client_id,
            client_generation,
        } => (
            "client_view_instance_conflict",
            Some(json!({
                "clientId": client_id,
                "clientGeneration": client_generation,
            })),
        ),
        DomainStoreErrorV1::ClientViewRevisionConflict {
            client_id,
            view_id,
            expected_revision,
            actual_revision,
        } => (
            "client_view_revision_conflict",
            Some(json!({
                "clientId": client_id,
                "viewId": view_id,
                "expectedRevision": expected_revision,
                "actualRevision": actual_revision,
            })),
        ),
        DomainStoreErrorV1::IdempotencyConflict { .. } => {
            ("client_view_idempotency_conflict", None)
        }
        DomainStoreErrorV1::InvalidRecord { field, .. } => (
            "client_view_request_invalid",
            Some(json!({ "field": field })),
        ),
        _ => ("client_view_store_failed", None),
    };
    BackendDispatchError {
        code: code.into(),
        message: error.to_string(),
        details,
        disposition: BackendFailureDispositionV1::RetrySame,
    }
}

fn backend_observation(descriptor: &ServiceDescriptor) -> Value {
    json!({
        "id": descriptor.backend_id,
        "generation": descriptor.generation,
        "protocol": { "major": 1, "minor": 0 },
        "capabilities": control_plane_capabilities(),
        "observedAtMs": now_ms().unwrap_or(0),
    })
}

fn backend_error_body(error: BackendDispatchError) -> Value {
    let mut details = match error.details {
        Some(Value::Object(details)) => details,
        Some(value) => {
            let mut details = serde_json::Map::new();
            details.insert("context".into(), value);
            details
        }
        None => serde_json::Map::new(),
    };
    details.insert("disposition".into(), json!(error.disposition));
    json!({
        "code": error.code,
        "message": error.message,
        "details": Value::Object(details),
    })
}

fn backend_request_response(
    descriptor: &ServiceDescriptor,
    request_id: &str,
    outcome: request_execution::RequestExecutionOutcome<Result<Value, BackendDispatchError>>,
) -> Value {
    match outcome {
        request_execution::RequestExecutionOutcome::ResponseDeadlineExceeded => json!({
            "schemaVersion": 1,
            "apiVersion": BACKEND_PROTOCOL_API,
            "kind": BACKEND_ERROR_KIND,
            "requestId": request_id,
            "backend": backend_observation(descriptor),
            "error": {
                "code": "backend_request_deadline_exceeded",
                "message": "backend request deadline exceeded",
                "details": { "disposition": "retry_same" }
            },
        }),
        request_execution::RequestExecutionOutcome::Completed(Ok(result)) => json!({
            "schemaVersion": 1,
            "apiVersion": BACKEND_PROTOCOL_API,
            "kind": BACKEND_RESPONSE_KIND,
            "requestId": request_id,
            "backend": backend_observation(descriptor),
            "result": result,
        }),
        request_execution::RequestExecutionOutcome::Completed(Err(error)) => json!({
            "schemaVersion": 1,
            "apiVersion": BACKEND_PROTOCOL_API,
            "kind": BACKEND_ERROR_KIND,
            "requestId": request_id,
            "backend": backend_observation(descriptor),
            "error": backend_error_body(error),
        }),
        request_execution::RequestExecutionOutcome::WorkerFailed => json!({
            "schemaVersion": 1,
            "apiVersion": BACKEND_PROTOCOL_API,
            "kind": BACKEND_ERROR_KIND,
            "requestId": request_id,
            "backend": backend_observation(descriptor),
            "error": {
                "code": "backend_request_worker_failed",
                "message": "backend request worker failed",
                "details": { "disposition": "retry_same" }
            },
        }),
    }
}

async fn handle_connection(state: Arc<ServiceState>, stream: UnixStream) -> io::Result<()> {
    if peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Ok(());
    }
    let mut reader = BufReader::new(stream);
    let mut persistent = false;
    loop {
        let mut source = Vec::new();
        let read_timeout = if persistent {
            PERSISTENT_IDLE_TIMEOUT
        } else {
            REQUEST_IO_TIMEOUT
        };
        let read = {
            let mut bounded = (&mut reader).take(MAX_REQUEST_BYTES + 1);
            timeout(read_timeout, bounded.read_until(b'\n', &mut source)).await
        };
        match read {
            Err(_) | Ok(Ok(0)) => return Ok(()),
            Ok(Err(error)) => return Err(error),
            Ok(Ok(_)) => {}
        }
        if source.len() as u64 > MAX_REQUEST_BYTES || !source.ends_with(b"\n") {
            return Ok(());
        }
        let request: BackendRequest = match serde_json::from_slice(&source) {
            Ok(request) => request,
            Err(_) => return Ok(()),
        };
        if request.operation == agent_conversation_api::SUBSCRIBE_OPERATION {
            return agent_conversation_api::handle_subscription(state, reader, request).await;
        }
        let request_id = request.request_id.clone();
        let request_operation = request.operation.clone();
        let request_persistent = requests_persistent_connection(&request);
        if persistent && !request_persistent {
            return Ok(());
        }
        let result = validate_request(&request, &state);
        let response = match result {
            Ok(_)
                if !matches!(
                    request_operation.as_str(),
                    "backend.ping" | "backend.shutdown"
                ) && !dure_app::is_durable_agent_observation(&request_operation)
                    && !state.is_mutation_authority() =>
            {
                json!({
                    "schemaVersion": 1,
                    "apiVersion": BACKEND_PROTOCOL_API,
                    "kind": BACKEND_ERROR_KIND,
                    "requestId": request_id,
                    "backend": backend_observation(&state.descriptor),
                    "error": {
                        "code": "recovering",
                        "message": "backend authority is switching generations",
                        "details": { "disposition": "retry_same" }
                    },
                })
            }
            Ok(authority) => match Arc::clone(&state.request_slots).try_acquire_owned() {
                Err(_) => json!({
                    "schemaVersion": 1,
                    "apiVersion": BACKEND_PROTOCOL_API,
                    "kind": BACKEND_ERROR_KIND,
                    "requestId": request_id,
                    "backend": backend_observation(&state.descriptor),
                    "error": {
                        "code": "backend_busy",
                        "message": "backend request capacity is exhausted",
                        "details": { "disposition": "retry_same" }
                    },
                }),
                Ok(permit) => {
                    let policy = request_execution::policy_for(
                        &request_operation,
                        REQUEST_DEADLINE,
                        WORKFLOW_REQUEST_DEADLINE,
                    );
                    let dispatch_state = Arc::clone(&state);
                    let dispatched = request_execution::execute(policy, permit, async move {
                        dispatch_authorized(&dispatch_state, authority, &request).await
                    })
                    .await;
                    backend_request_response(&state.descriptor, &request_id, dispatched)
                }
            },
            Err(code) => json!({
                "schemaVersion": 1,
                "apiVersion": BACKEND_PROTOCOL_API,
                "kind": BACKEND_ERROR_KIND,
                "requestId": request_id,
                "backend": backend_observation(&state.descriptor),
                "error": { "code": code, "message": "backend request rejected" },
            }),
        };
        let should_shutdown =
            request_operation == "backend.shutdown" && response["kind"] == BACKEND_RESPONSE_KIND;
        let mut response = serde_json::to_vec(&response)?;
        if request_persistent {
            response.push(b'\n');
        }
        let stream = reader.get_mut();
        timeout(REQUEST_IO_TIMEOUT, async {
            stream.write_all(&response).await?;
            if request_persistent {
                stream.flush().await
            } else {
                stream.shutdown().await
            }
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "backend response timed out"))??;
        if should_shutdown {
            state.shutdown.notify_one();
            return Ok(());
        }
        if !request_persistent {
            return Ok(());
        }
        persistent = true;
    }
}

pub async fn preflight(
    options: &ServeOptions,
) -> Result<ControlPlanePreflightV1, ControlPlaneError> {
    if !options.home.is_absolute() {
        return Err(ControlPlaneError::Invalid("DURE_HOME must be absolute"));
    }
    let hmux_identity = resolve_hmux_toolchain_identity(
        &options.hmux_bin,
        &options.hmux_runtime_bin,
        &options.hmux_discovery_root,
    )?;
    let root = options.home.join("backend");
    match fs::symlink_metadata(&root) {
        Ok(_) => {
            assert_owner_directory(&root)?;
            SqliteDomainStore::preflight(root.join("application-state.sqlite3"))
                .await
                .map_err(|error| ControlPlaneError::Message(error.to_string()))?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(ControlPlanePreflightV1 {
        schema_version: 1,
        kind: "dure.control_plane.preflight",
        build_id: control_plane_build_id(),
        descriptor_schema_version: SERVICE_DESCRIPTOR_SCHEMA_VERSION,
        hmux_identity,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientProtocolVersion {
    major: u16,
    minor: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientBackendObservation {
    id: String,
    generation: String,
    protocol: ClientProtocolVersion,
    capabilities: Vec<String>,
    observed_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientObserveResult {
    schema_version: u16,
    records: Vec<ClientObservedCheckpoint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientObservedCheckpoint {
    record: AgentCheckpointRecordV1,
    binding: ClientObservedBinding,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientObservedBinding {
    session_id: String,
    workspace_id: String,
    binding_generation: i64,
    stop_fence: HmuxStopFence,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientObserveResponse {
    schema_version: u16,
    api_version: String,
    kind: String,
    request_id: String,
    backend: ClientBackendObservation,
    result: ClientObserveResult,
}

/// Read authoritative logical-Agent checkpoints through the same versioned
/// Unix-socket transport used by the CLI. This is a client adapter only: it
/// never opens the service-owned SQLite database.
pub async fn observe_local_checkpoints(
    home: &Path,
    agent_ids: Vec<String>,
) -> Result<Vec<AgentCheckpointRecordV1>, ControlPlaneError> {
    observe_local_checkpoints_expected(home, agent_ids, None).await
}

pub async fn observe_local_checkpoints_expected(
    home: &Path,
    agent_ids: Vec<String>,
    expected_generation: Option<&str>,
) -> Result<Vec<AgentCheckpointRecordV1>, ControlPlaneError> {
    if !home.is_absolute() || agent_ids.len() > 256 {
        return Err(ControlPlaneError::Invalid(
            "local checkpoint observation is invalid",
        ));
    }
    let root = home.join("backend");
    assert_owner_directory(&root)?;
    let descriptor = read_descriptor(&root.join("control-plane.json"))?
        .ok_or(ControlPlaneError::Invalid("control plane is unavailable"))?;
    if descriptor.build_id.as_deref() != Some(control_plane_build_id()) {
        return Err(ControlPlaneError::Invalid(
            "control plane build protocol is incompatible",
        ));
    }
    if expected_generation.is_some_and(|expected| expected != descriptor.generation) {
        return Err(ControlPlaneError::Invalid(
            "control plane generation does not match the selected profile",
        ));
    }
    let mut requested = Vec::with_capacity(agent_ids.len());
    let mut requested_ids = std::collections::BTreeSet::new();
    for agent_id in agent_ids {
        let agent_id = AgentIdV1::new(agent_id)
            .map_err(|_| ControlPlaneError::Invalid("agent id is invalid"))?;
        if !requested_ids.insert(agent_id.to_string()) {
            return Err(ControlPlaneError::Invalid("agent id is duplicated"));
        }
        requested.push(agent_id);
    }
    let request_id = random_generation()?.replacen("local-v1-", "observe-", 1);
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": BACKEND_PROTOCOL_API,
        "kind": BACKEND_REQUEST_KIND,
        "requestId": request_id,
        "operation": "agent_checkpoint.observe",
        "expected": {
            "backendId": descriptor.backend_id,
            "generation": descriptor.generation,
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "requiredCapabilities": ["agent_checkpoint.observe"]
        },
        "body": { "schemaVersion": 1, "agentIds": requested }
    });
    let mut source = serde_json::to_vec(&request)
        .map_err(|error| ControlPlaneError::Message(error.to_string()))?;
    source.push(b'\n');
    if source.len() as u64 > MAX_REQUEST_BYTES {
        return Err(ControlPlaneError::Invalid(
            "local checkpoint observation is too large",
        ));
    }
    let mut stream = timeout(
        Duration::from_secs(2),
        UnixStream::connect(&descriptor.socket_path),
    )
    .await
    .map_err(|_| ControlPlaneError::Invalid("control plane connection timed out"))??;
    timeout(Duration::from_secs(2), async {
        stream.write_all(&source).await?;
        stream.shutdown().await
    })
    .await
    .map_err(|_| ControlPlaneError::Invalid("control plane write timed out"))??;
    let mut response_source = Vec::new();
    let mut bounded = (&mut stream).take(MAX_REQUEST_BYTES + 1);
    timeout(
        Duration::from_secs(2),
        bounded.read_to_end(&mut response_source),
    )
    .await
    .map_err(|_| ControlPlaneError::Invalid("control plane read timed out"))??;
    if response_source.len() as u64 > MAX_REQUEST_BYTES {
        return Err(ControlPlaneError::Invalid(
            "control plane response is too large",
        ));
    }
    let response: ClientObserveResponse = serde_json::from_slice(&response_source)
        .map_err(|_| ControlPlaneError::Invalid("control plane response is invalid"))?;
    let expected_capabilities = control_plane_capabilities()
        .iter()
        .map(|capability| capability.to_string())
        .collect::<std::collections::BTreeSet<_>>();
    let observed_capabilities = response
        .backend
        .capabilities
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let observed_at_ms = now_ms()?;
    if response.schema_version != 1
        || response.api_version != BACKEND_PROTOCOL_API
        || response.kind != BACKEND_RESPONSE_KIND
        || response.request_id != request_id
        || response.backend.id != descriptor.backend_id
        || response.backend.generation != descriptor.generation
        || response.backend.protocol.major != 1
        || response.backend.protocol.minor != 0
        || observed_capabilities != expected_capabilities
        || response.backend.capabilities.len() != observed_capabilities.len()
        || response.backend.observed_at_ms.abs_diff(observed_at_ms) > 60_000
        || response.result.schema_version != AGENT_CHECKPOINT_SCHEMA_VERSION_V1
    {
        return Err(ControlPlaneError::Invalid(
            "control plane response does not match the selected backend",
        ));
    }
    let mut observed_ids = std::collections::BTreeSet::new();
    let mut records = Vec::with_capacity(response.result.records.len());
    for observed in response.result.records {
        observed
            .record
            .validate()
            .map_err(|_| ControlPlaneError::Invalid("checkpoint record is invalid"))?;
        if !observed.record.consistent_with_serving_binding(
            observed.binding.binding_generation,
            &observed.binding.session_id,
        ) || !valid_token(&observed.binding.workspace_id)
            || observed.binding.stop_fence.runner_principal.is_empty()
            || !requested_ids.contains(observed.record.agent_id.as_str())
            || !observed_ids.insert(observed.record.agent_id.to_string())
        {
            return Err(ControlPlaneError::Invalid(
                "checkpoint record does not match the observation request",
            ));
        }
        records.push(observed.record);
    }
    Ok(records)
}

#[cfg(test)]
mod workflow_tests;
