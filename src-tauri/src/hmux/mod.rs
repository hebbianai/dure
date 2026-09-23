mod adoption;
mod bounded_process;
mod census;
mod claude_adoption;
pub(crate) mod command_input;
#[cfg(test)]
mod command_input_smoke;
mod conversion;
mod conversation;
mod discovery_worker;
mod exact_termination;
mod managed_create;
pub(crate) mod managed_create_timing;
#[cfg(test)]
mod managed_create_compatibility_smoke;
mod managed_launch;
mod managed_recovery;
pub(crate) mod managed_rehost_resolution;
pub(crate) use managed_recovery::reconcile_then_initiate as reconcile_managed_rehost_then_initiate;
pub(crate) mod managed_rehost_recipe;
mod managed_shell;
mod observer_webview_lifecycle;
mod plain_shell_recovery;
mod standalone_upgrade;
mod product_catalog;
mod recovery;
mod remote_pane;
mod retirement;
mod runtime;
mod runtime_install_health;
mod standalone_creation;
pub(crate) mod structured_terminal;

pub(crate) use standalone_creation::AppStandaloneCreateRequest;

pub use managed_create::ManagedCreateSummary;
pub(crate) use managed_create::ManagedCreateLaunch;
pub use conversion::{SessionConversionReceipt, SessionConversionRequest};
pub use conversation::{
    ExistingManagedWriterInspection, ExistingManagedWriterRequest, ManagedConversationIdentity,
};
pub(crate) use crate::hmux_exact_termination::ExactSessionTerminationReceipt;
pub use managed_shell::{ManagedShellPromotionRequest, ManagedShellPromotionSummary};
pub use retirement::{
    PaneAttachmentStatus, PaneDepartureReceipt, SessionRetirementPolicySummary,
};
pub(crate) use observer_webview_lifecycle::{
    configure_builder as configure_observer_webview_lifecycle, ObserverWebviewBinding,
};
pub(crate) use runtime::resolve_runtime as resolve_runtime_executable;
pub(crate) use product_catalog::product_discovery_root_path;
pub(crate) use retirement::{preserved_receipt, project_receipt};

pub(crate) fn resolve_independent_hmux_cli() -> Result<Option<std::path::PathBuf>, String> {
    runtime::resolve_independent_cli()
}

use base64::Engine;
use hebbian_process_sampler::{ProcessRecord, ProcessSnapshot, SharedProcessSampler};
use hmux_client::{
    evaluate_recovery_policy,
    probe_local_session, probe_local_session_exact, probe_local_session_exact_until,
    AgentIdentityDescriptor, AgentIdentitySource, AgentProvider, CatalogCensusWorker,
    AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle, AgentRuntimeStateDescriptor,
    AgentRuntimeStateSource, AgentStateReport, AgentStateReportObservationFence,
    AgentStateReportOutcome, ClientError,
    CreatedStandaloneSession, ExitedSessionRetirementMode, ExitedSessionRetirementReceipt,
    ExitedSessionRetirementTarget,
    ExactDiscoveryWorker, ExactSessionProbeResult, LocalSession, LocalSessionCatalog,
    LocalSessionObserver, ManagedAgentStateReporter,
    ManagedAttachRequest, ManagedCreateChainStopReceipt, ManagedCreateChainStopReceiptV2,
    ManagedCreateReceipt, ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedRehostReceipt,
    ManagedRehostSource, ManagedSessionStopper, ManagedStopReceipt,
    ManagedStopRequest,
    ObserverAttachOptions, ExecutionLocation, ExecutionLocationDescriptor, ExecutionLocationSource,
    PermissionMode,
    ProviderConversationIdentity, RecoveryDecision, RecoveryPolicyInput,
    ProviderConversationIdentityDescriptor, ProviderConversationIdentitySource,
    ProviderStateEnvironment,
    AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
    RecoveredPresentationDescriptor, ScreenSnapshotDescriptor, ScreenSnapshotProfileDescriptor,
    SessionClass, SessionDescriptor, SessionFence, SessionLifecycle, SessionProbeStatus,
    SessionSelector, StandaloneCreateRequest, StandaloneResurrectionRecipe,
    MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    TerminalEnvironment,
    WorkingDirectoryDescriptor, WorkingDirectorySource,
    inspect_local_sessions_exact_isolated, list_local_sessions_isolated,
    resolve_local_session_isolated, resolve_local_session_name_isolated,
};

fn require_conversation_fenced_managed_stop_lifecycle(
    request: ManagedCreateRequest,
) -> Result<ManagedCreateRequest, String> {
    if request.required_managed_stop_request_version()
        == Some(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
    {
        return Ok(request);
    }
    request
        .with_required_managed_stop_request_version(
            MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
        )
        .map_err(|error| error.to_string())
}
#[cfg(unix)]
use hmux_client::{LocalProcessGenerationStatus, probe_local_process_generation};
use hmux_client::{
    DiscoveryGcMode, DiscoveryGcSelection, LocalStateGcPolicy, LocalStateGcReport,
    collect_local_state, maintain_registration_capacity,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use observer_webview_lifecycle::ObserverWebviewLifecycle;
use product_catalog::product_catalog;

const MAX_CENSUS_WORKERS: usize = 4;
const CENSUS_TOTAL_BUDGET: Duration = Duration::from_millis(1_500);
const CENSUS_PROBE_QUANTUM: Duration = Duration::from_millis(500);
const MAX_EXACT_DISCOVERY_WORKERS: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverSnapshot {
    pub terminal_epoch: String,
    pub sequence_through: String,
    pub rows: u16,
    pub columns: u16,
    pub data: String,
    pub alternate_screen: bool,
    pub cursor_visible: bool,
    pub truncated: bool,
    pub working_directory: Option<ObserverWorkingDirectory>,
    pub execution_location: Option<ObserverExecutionLocation>,
    pub agent_identity: Option<ObserverAgentIdentity>,
    pub agent_runtime_state: Option<ObserverAgentRuntimeState>,
    pub provider_conversation_identity: Option<ObserverProviderConversationIdentity>,
    pub recovered_presentation: Option<ObserverRecoveredPresentation>,
    /// "viewport_only"이면 이 스냅샷은 프로필 요청으로 scrollback을 생략한 것 —
    /// 클라이언트가 full 스냅샷을 당겨 hydrate할 수 있다.
    pub actual_profile: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to_request_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverRecoveredPresentation {
    pub source_session_id: String,
    pub source_host_instance_id: String,
    pub source_terminal_epoch: String,
    pub source_sequence_through: String,
    pub captured_unix_ms: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub session_name: Option<String>,
    pub workspace_id: String,
    pub session_class: &'static str,
    pub lifecycle: &'static str,
    pub manifest_lifecycle: &'static str,
    pub health: &'static str,
    pub host_build_version: String,
    pub client_selection: runtime::ClientSelectionKind,
    pub input_allowed: bool,
    pub detach_only: bool,
    pub diagnostic: Option<SessionDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<SessionFailureSummary>,
    pub runtime_host: Option<String>,
    /// manifest의 host 프로세스가 확정적으로 죽었을 때만 `Some(false)`.
    ///
    /// 죽음 방향만 결정적이다: pid에 kill(0)이 ESRCH면 그 pid의 프로세스는
    /// 존재하지 않는다. 살아 있는 pid는 재사용(다른 프로세스)일 수 있어 아무
    /// 주장도 하지 않는다(None) — 파괴적 UI가 "살아 있음"을 근거로 삼지
    /// 못하게 하는 비대칭이다. stale_transport(응답 없음)에서만 계산한다.
    pub host_process_alive: Option<bool>,
    /// A complete native socket census of the exact live Host found no owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_socket_owner_absent: Option<bool>,
    pub terminal_epoch: String,
    /// Durable destructive-action authority captured from one exact manifest
    /// generation. Product retries persist this with their runtime binding;
    /// they must never reconstruct it from a later catalog row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_fence: Option<ManagedStopFence>,
    pub output_seq: String,
    pub capabilities: Vec<String>,
    pub retirement_policy: Option<SessionRetirementPolicySummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFailureSummary {
    pub correlation_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub terminal_epoch: String,
    pub code: String,
    pub phase: String,
    pub summary: String,
    pub exit_kind: String,
    pub exit_code: Option<i32>,
    pub occurred_unix_ms: String,
    pub retry_posture: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactSessionTarget {
    pub session_id: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExactSessionInspectionResult {
    Found {
        session: Box<SessionSummary>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_runtime_state: Option<ObserverAgentRuntimeState>,
    },
    NotFound {
        session_id: String,
        workspace_id: String,
    },
    LookupFailed {
        session_id: String,
        workspace_id: String,
        error_code: String,
    },
    Unprobed {
        session_id: String,
        workspace_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedStopFence {
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
}

impl ManagedStopFence {
	fn matches(&self, session: &SessionDescriptor) -> bool {
		self.runner_principal == session.runner_principal
			&& self.runner_instance == session.runner_instance
			&& self.channel_epoch == session.channel_epoch
			&& self.host_instance_id == session.host_instance_id
			&& self.terminal_epoch == session.terminal_epoch
	}

    fn validate(&self) -> Result<(), String> {
        validate_identifier("managed stop runner principal", &self.runner_principal)?;
        validate_identifier("managed stop runner instance", &self.runner_instance)?;
        validate_identifier("managed stop channel epoch", &self.channel_epoch)?;
        validate_identifier("managed stop host instance id", &self.host_instance_id)?;
        validate_identifier("managed stop terminal epoch", &self.terminal_epoch)
    }
}

fn managed_stop_request_for_descriptor(
    stop_id: impl Into<String>,
    descriptor: &SessionDescriptor,
) -> Result<ManagedStopRequest, String> {
    let channel_epoch = descriptor
        .channel_epoch
        .parse::<u64>()
        .map_err(|_| "managed stop channel epoch is invalid".to_string())?;
    ManagedStopRequest::new(
        stop_id,
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
    .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiagnostic {
    pub code: &'static str,
    pub message: &'static str,
    pub retry: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneCensusDiagnostics {
    pub catalog_us: u64,
    pub health_projection_us: u64,
    /// Shared session-census execution only; excludes caller wait, projection
    /// of the control-plane wrapper, serialization, and IPC delivery.
    pub total_us: u64,
    /// This caller waited for an already-running census. It does not assign
    /// ownership or causality for the shared execution time.
    pub joined_existing: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneCensus {
    pub policy: runtime::UpdatePolicyState,
    pub sessions: Vec<SessionSummary>,
    pub protected_build_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<ControlPlaneCensusDiagnostics>,
}

#[derive(Clone)]
struct SessionCensusExecution {
    sessions: Vec<SessionSummary>,
    phases: census::CensusPhaseDurations,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentBuildChangeReceipt {
    pub action: &'static str,
    pub current_build_id: String,
    pub previous_build_id: Option<String>,
}

pub type RetireExitedItem = ExitedSessionRetirementTarget;
pub type RetireExitedReceipt = ExitedSessionRetirementReceipt;
pub type CleanupStaleItem = ExitedSessionRetirementTarget;
pub type CleanupStaleReceipt = ExitedSessionRetirementReceipt;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPlanRequest {
    session_id: String,
    workspace_id: String,
    #[serde(default)]
    expected_source_fence: Option<ManagedStopFence>,
    conversation_id: Option<String>,
    adapter_supports_explicit_resume: bool,
    confirmed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryExecutionKind {
    PlainShell,
    ManagedProvider,
    ManagedProviderFresh,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryExecutionRequest {
    recovery_id: String,
    kind: RecoveryExecutionKind,
    session_id: String,
    workspace_id: String,
    #[serde(default)]
    expected_source_fence: Option<ManagedStopFence>,
    #[serde(default)]
    require_socket_owner_absent: bool,
    #[serde(default)]
    expected_target_build_id: Option<String>,
    conversation_id: Option<String>,
    adapter_supports_explicit_resume: bool,
    confirmed: bool,
    managed_launch: Option<ManagedRecoveryLaunchRequest>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRecoveryReconcileRequest {
    recovery_id: String,
    session_id: String,
    workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRecoveryLaunchRequest {
    provider_id: String,
    permission_mode: PermissionMode,
    credential_id: Option<String>,
    credential_directory: Option<String>,
    credential_generation: Option<u64>,
    cwd: String,
    rows: u16,
    columns: u16,
    terminal_environment: TerminalEnvironment,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPlanReceipt {
    pub session_id: String,
    pub source_build_id: String,
    pub target_build_id: Option<String>,
    pub action: &'static str,
    pub allowed: bool,
    pub reason: Option<&'static str>,
    pub requires_confirmation: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryExecutionReceipt {
    pub source_session_id: String,
    pub target_build_id: Option<String>,
    pub action: &'static str,
    pub outcome: &'static str,
    pub replayed: bool,
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_stop_receipt: Option<ManagedStopReceipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_target: Option<ManagedRehostTargetReceipt>,
    pub replacement_session: Option<SessionSummary>,
}

/// Canonical provider-neutral successor identity selected by the Hmux journal.
/// Catalog/attach health is presentation state and is deliberately absent.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedRehostTargetReceipt {
    pub idempotency_key: String,
    pub session_id: String,
    pub workspace_id: String,
    pub provider_id: String,
    pub permission_mode: PermissionMode,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
}

impl ManagedRehostTargetReceipt {
    pub(crate) fn from_rehost(receipt: &ManagedRehostReceipt) -> Result<Self, String> {
        receipt.validate().map_err(|error| error.to_string())?;
        Self::from_create(receipt.replacement_receipt())
    }

    pub(crate) fn from_create(receipt: &ManagedCreateReceipt) -> Result<Self, String> {
        receipt.validate().map_err(|error| error.to_string())?;
        let fence = receipt.generation_fence().ok_or_else(|| {
            "managed_rehost_receipt_invalid: replacement generation fence is missing".to_string()
        })?;
        Ok(Self {
            idempotency_key: receipt.idempotency_key().to_string(),
            session_id: receipt.session_id().to_string(),
            workspace_id: receipt.workspace_id().to_string(),
            provider_id: receipt.provider_id().to_string(),
            permission_mode: receipt.permission_mode(),
            runner_principal: fence.runner_principal().to_string(),
            runner_instance: fence.runner_instance().to_string(),
            channel_epoch: fence.channel_epoch().to_string(),
            host_instance_id: fence.host_instance_id().to_string(),
            terminal_epoch: fence.terminal_epoch().to_string(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneUpgradeRequest {
    upgrade_id: String,
    session_id: String,
    workspace_id: String,
    session_name: String,
    confirmed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneUpgradeReceipt {
    pub source_session_id: String,
    pub source_workspace_id: String,
    pub source_build_id: Option<String>,
    pub target_build_id: String,
    pub action: &'static str,
    pub outcome: &'static str,
    pub replayed: bool,
    pub reason: Option<String>,
    pub requires_confirmation: bool,
    pub replacement_session: Option<SessionSummary>,
}

/// Provider-neutral request for delivering one hook observation to Hmux.
/// Tauri receives it as one request object like the other Hmux commands.
#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateReportRequest {
    pub session_id: String,
    pub workspace_id: Option<String>,
    pub expected_session_fence: Option<ReportedSessionFence>,
    pub activity: ReportedAgentActivity,
    pub attention: ReportedAgentAttention,
    pub turn_completed: bool,
    pub turn_completion_id: Option<String>,
    pub causality: Option<hmux_client::AgentStateReportCausality>,
    pub working_ttl_ms: Option<u64>,
    pub conversation_identity: Option<ReportedProviderConversationIdentity>,
    pub expected_observation: Option<ReportedAgentStateObservationFence>,
}

impl fmt::Debug for AgentStateReportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentStateReportRequest")
            .field("session_id", &self.session_id)
            .field("workspace_id", &self.workspace_id)
            .field("has_expected_session_fence", &self.expected_session_fence.is_some())
            .field("activity", &self.activity)
            .field("attention", &self.attention)
            .field("turn_completed", &self.turn_completed)
            .field("has_turn_completion_id", &self.turn_completion_id.is_some())
            .field("working_ttl_ms", &self.working_ttl_ms)
            .field("has_conversation_identity", &self.conversation_identity.is_some())
            .field("has_expected_observation", &self.expected_observation.is_some())
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedAgentStateObservationFence {
    pub terminal_epoch: String,
    pub runtime_revision: String,
    pub output_sequence: String,
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedProviderConversationIdentity {
    pub provider_id: String,
    pub conversation_id: String,
    /// Exact predecessor verified by the provider adapter; never an arbitrary replacement.
    pub previous_conversation_id: Option<String>,
    pub expected_fence: Option<ReportedSessionFence>,
}

impl fmt::Debug for ReportedProviderConversationIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReportedProviderConversationIdentity")
            .field("provider_id", &self.provider_id)
            .field("conversation_id_len", &self.conversation_id.len())
            .field("expected_fence", &self.expected_fence)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedSessionFence {
    pub session_id: String,
    pub workspace_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportedAgentActivity {
    Working,
    Waiting,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportedAgentAttention {
    None,
    InputRequired,
    ApprovalRequired,
    Error,
}

/// Host admission outcome projected without reinterpretation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateReportReceiptSummary {
    pub outcome: &'static str,
}

/// Typed state-report failure retained for diagnostics at the invoke boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateReportFailure {
    pub code: String,
    pub message: String,
}

fn report_client_failure(error: ClientError) -> AgentStateReportFailure {
    AgentStateReportFailure {
        code: error.code().to_string(),
        message: error.to_string(),
    }
}

fn report_request_failure(message: impl Into<String>) -> AgentStateReportFailure {
    AgentStateReportFailure {
        code: "hmux_invalid_request".to_string(),
        message: message.into(),
    }
}

fn report_outcome_label(outcome: AgentStateReportOutcome) -> &'static str {
    match outcome {
        AgentStateReportOutcome::Applied => "applied",
        AgentStateReportOutcome::DroppedExited => "dropped_exited",
        AgentStateReportOutcome::NoOp => "no_op",
    }
}

fn completed_codex_turn_needs_conversation_observation(
    session_class: SessionClass,
    provider_id: &str,
    turn_completed: bool,
    outcome: AgentStateReportOutcome,
) -> bool {
    session_class == SessionClass::Managed
        && provider_id == "codex"
        && turn_completed
        && outcome != AgentStateReportOutcome::DroppedExited
}

fn observe_completed_codex_conversation<R: tauri::Runtime>(
    app: &AppHandle<R>,
    descriptor: &SessionDescriptor,
) {
    let app = app.clone();
    let session_id = descriptor.session_id.clone();
    let workspace_id = descriptor.workspace_id.clone();
    let provider_id = descriptor.provider_id.clone();
    let provider_pid = descriptor.provider_process.process_id;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(cwd) = hebbian_process_sampler::process_cwd(provider_pid) else {
            eprintln!(
                "completed Codex conversation observation skipped: provider cwd is unavailable"
            );
            return;
        };
        let hmux = {
            let state = app.state::<crate::AppState>();
            Arc::clone(&state.hmux)
        };
        if let Err(error) = hmux.inspect_managed_conversation_identity(
            &app,
            session_id,
            workspace_id,
            provider_id,
            cwd.to_string_lossy().into_owned(),
        ) {
            eprintln!("completed Codex conversation observation failed: {error}");
        }
    });
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverWorkingDirectory {
    pub terminal_epoch: String,
    pub observed_through_output_seq: String,
    pub path: String,
    pub source: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObserverExecutionLocationValue {
    Local,
    Ssh { target: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverExecutionLocation {
    pub terminal_epoch: String,
    pub observed_through_output_seq: String,
    pub location: ObserverExecutionLocationValue,
    pub source: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverAgentIdentity {
    pub terminal_epoch: String,
    pub observed_through_output_seq: String,
    pub agent: Option<&'static str>,
    pub source: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverAgentRuntimeState {
    pub terminal_epoch: String,
    pub revision: String,
    pub observed_through_output_seq: String,
    pub lifecycle: &'static str,
    pub activity: &'static str,
    pub attention: &'static str,
    pub attention_id: Option<String>,
    pub source: &'static str,
    /// 완료 카운터(u64) — JS 정밀도 함정을 피해 revision과 같은 10진 문자열로 전달.
    pub turn_completed_count: String,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObserverProviderConversationIdentity {
    pub session_id: String,
    pub workspace_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
    pub revision: String,
    pub observed_through_output_seq: String,
    pub provider_id: String,
    pub conversation_id: String,
    pub source: &'static str,
}

impl fmt::Debug for ObserverProviderConversationIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ObserverProviderConversationIdentity")
            .field("session_id", &self.session_id)
            .field("workspace_id", &self.workspace_id)
            .field("runner_principal", &self.runner_principal)
            .field("runner_instance", &self.runner_instance)
            .field("channel_epoch", &self.channel_epoch)
            .field("host_instance_id", &self.host_instance_id)
            .field("terminal_epoch", &self.terminal_epoch)
            .field("revision", &self.revision)
            .field("observed_through_output_seq", &self.observed_through_output_seq)
            .field("provider_id", &self.provider_id)
            .field("conversation_id_len", &self.conversation_id.len())
            .field("source", &self.source)
            .finish()
    }
}

#[derive(Default)]
pub struct HmuxManager {
    operations: Mutex<()>,
    remote_pane_operations: remote_pane::RemotePaneOperations,
    session_census: census::OverlappingCallCoalescer<SessionCensusExecution>,
    structured_terminals: Arc<Mutex<
        HashMap<
            structured_terminal::StructuredTerminalSlot,
            structured_terminal::StructuredTerminalEntry,
        >,
    >>,
    observer_webviews: Mutex<ObserverWebviewLifecycle>,
    pending_remote_creations:
        Mutex<HashMap<String, remote_pane::RemotePendingCreationAuthority>>,
    remote_pane_authorities: Mutex<HashMap<String, remote_pane::RemotePaneAuthority>>,
    pending_created: Mutex<HashMap<String, CreatedStandaloneSession>>,
}

impl HmuxManager {
    #[cfg(debug_assertions)]
    pub(crate) fn prepare_runtime_fixture<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<String, String> {
        runtime::prepare_current_build_for_qa(app).map(|current| current.build_id)
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>, String> {
        self.list_sessions_with_diagnostics()
            .map(|receipt| receipt.value.sessions)
    }

    fn list_sessions_with_diagnostics(
        &self,
    ) -> Result<census::CoalescedCall<SessionCensusExecution>, String> {
        self.session_census.run(|| self.list_sessions_uncached())
    }

    fn list_sessions_uncached(&self) -> Result<SessionCensusExecution, String> {
        let started = Instant::now();
        let (catalog, sessions) = product_catalog_census(CENSUS_TOTAL_BUDGET)?;
        let catalog_completed = Instant::now();
        let remaining_budget = CENSUS_TOTAL_BUDGET.saturating_sub(started.elapsed());
        let discovery_root = catalog.discovery_root().to_path_buf();
        let health_projection_started = Instant::now();
        let sessions = census::project_sessions_with_structured_health(
            self,
            sessions,
            discovery_root,
            remaining_budget,
            MAX_CENSUS_WORKERS,
            CENSUS_PROBE_QUANTUM,
        );
        let completed = Instant::now();
        Ok(SessionCensusExecution {
            sessions,
            phases: census::census_phase_durations(
                started,
                catalog_completed,
                health_projection_started,
                completed,
            ),
        })
    }

    /// Inspect only the exact workspace/session identities supplied by the
    /// caller. This never enumerates the global catalog, so an unrelated large
    /// or partially unreadable discovery root cannot erase the health of a
    /// pane whose complete identity is already known.
    pub fn inspect_sessions_exact(
        &self,
        targets: Vec<ExactSessionTarget>,
    ) -> Result<Vec<ExactSessionInspectionResult>, String> {
        let selectors = targets
            .into_iter()
            .map(|target| {
                validate_identifier("session id", &target.session_id)?;
                validate_identifier("workspace id", &target.workspace_id)?;
                Ok(SessionSelector::new(
                    target.session_id,
                    Some(target.workspace_id),
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let batch_count = selectors.len().div_ceil(MAX_EXACT_DISCOVERY_WORKERS);
        let total_budget = CENSUS_PROBE_QUANTUM * u32::try_from(batch_count).unwrap_or(u32::MAX)
            + Duration::from_secs(1);
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let worker = exact_discovery_worker()?;
        inspect_local_sessions_exact_isolated(
            &catalog,
            &worker,
            selectors,
            MAX_EXACT_DISCOVERY_WORKERS,
            total_budget,
        )
        .map(|results| {
            results
                .into_iter()
                .map(project_exact_session_inspection)
                .collect()
        })
        .map_err(|error| error.to_string())
    }

    /// Run the hmux local-state GC with its default retention policy.
    /// Scheduling lives in the frontend maintenance lane; eligibility,
    /// protection, and locking stay owned by hmux-client. `mode` is parsed
    /// at this boundary — "preview" inspects, "apply" removes.
    pub fn local_state_gc(&self, mode: &str) -> Result<LocalStateGcReport, String> {
        let mode = match mode {
            "preview" => DiscoveryGcMode::Preview,
            "apply" => DiscoveryGcMode::Apply,
            other => {
                return Err(format!(
                    "hmux_state_gc_invalid_mode: expected preview or apply, got {other:?}"
                ));
            }
        };
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        if mode == DiscoveryGcMode::Apply {
            maintain_registration_capacity(catalog.discovery_root())
                .map_err(|error| error.to_string())?;
        }
        collect_local_state(catalog.discovery_root(), mode, &scheduled_state_gc_policy())
            .map_err(|error| error.to_string())
    }

    pub fn resolve_named_session(&self, name: &str) -> Result<SessionSummary, String> {
        validate_identifier("session name", name)?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let session = resolve_catalog_name_with_runtime(&catalog, name, CENSUS_TOTAL_BUDGET)?;
        Ok(probe_and_project_session(
            &catalog,
            session.descriptor().clone(),
        ))
    }

    pub fn control_plane_census<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<ControlPlaneCensus, String> {
        let current = runtime::ensure_current_build(app)?;
        let receipt = self.list_sessions_with_diagnostics()?;
        let joined_existing = receipt.joined_existing;
        let SessionCensusExecution { sessions, phases } = receipt.value;
        let protected_build_ids = protected_build_ids(
            &current.build_id,
            sessions.iter().map(|session| {
                (
                    session.manifest_lifecycle,
                    session.health,
                    session.host_build_version.as_str(),
                )
            }),
        );
        Ok(ControlPlaneCensus {
            policy: runtime::update_policy_state(),
            sessions,
            protected_build_ids,
            diagnostics: Some(ControlPlaneCensusDiagnostics {
                catalog_us: phases.catalog_us,
                health_projection_us: phases.health_projection_us,
                total_us: phases.total_us,
                joined_existing,
            }),
        })
    }

    pub fn activate_installed_build(
        &self,
        build_id: String,
    ) -> Result<CurrentBuildChangeReceipt, String> {
        validate_identifier("build id", &build_id)?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let current = runtime::activate_installed_build(&build_id)?;
        Ok(CurrentBuildChangeReceipt {
            action: "activate_installed_build",
            current_build_id: current.build_id,
            previous_build_id: runtime::update_policy_state().previous_build_id,
        })
    }

    pub fn rollback_current_build(&self) -> Result<CurrentBuildChangeReceipt, String> {
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let current = runtime::rollback_current()?;
        Ok(CurrentBuildChangeReceipt {
            action: "rollback_current_build",
            current_build_id: current.build_id,
            previous_build_id: runtime::update_policy_state().previous_build_id,
        })
    }

    /// exited 세션들의 discovery 포인터를 은퇴시킨다(hn2t). 파괴적 경계는
    /// `retire_exited_current` — 종료 증거를 `retired/`에 보관한 뒤 포인터만
    /// 제거하므로 census에서 사라지되 데이터는 남고, 디스크 회수는 기존
    /// LocalStateGc가 자기 fence(24h 등)대로 이어받는다.
    ///
    /// confirmed=false는 순수 preview(무변경). 원자성, recovery source lock,
    /// fresh manifest 재조회, 세대 fence, bounded receipt는 CLI와 같은
    /// hmux-client API가 소유한다. 이 adapter는 제품 discovery root와 기존
    /// mutation 직렬화만 연결한다.
    pub fn retire_exited_sessions(
        &self,
        items: Vec<RetireExitedItem>,
        confirmed: bool,
    ) -> Result<Vec<RetireExitedReceipt>, String> {
        // 제품 내부 변이는 계속 직렬화하되, CLI/SSH와의 프로세스 간 경합은
        // 공통 client API의 recovery source lock이 막는다.
        let _operation = confirmed.then(|| {
            self.operations.lock().expect("Hmux operations poisoned")
        });
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        catalog
            .retire_exited_sessions(
                items,
                if confirmed {
                    ExitedSessionRetirementMode::Apply
                } else {
                    ExitedSessionRetirementMode::Preview
                },
            )
            .map(|report| report.results)
            .map_err(|error| error.to_string())
    }

    /// Remove only a non-exited discovery generation whose exact lifetime
    /// lock is unowned. Unlike recovery this never signals a Host or creates a
    /// replacement; unlike exited retirement it does not consume tombstones.
    pub fn cleanup_stale_sessions(
        &self,
        items: Vec<CleanupStaleItem>,
        confirmed: bool,
    ) -> Result<Vec<CleanupStaleReceipt>, String> {
        let _operation = confirmed.then(|| {
            self.operations.lock().expect("Hmux operations poisoned")
        });
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        catalog
            .cleanup_stale_sessions(
                items,
                if confirmed {
                    ExitedSessionRetirementMode::Apply
                } else {
                    ExitedSessionRetirementMode::Preview
                },
            )
            .map(|report| report.results)
            .map_err(|error| error.to_string())
    }

    pub fn plan_recovery(
        &self,
        request: RecoveryPlanRequest,
    ) -> Result<RecoveryPlanReceipt, String> {
        validate_identifier("session id", &request.session_id)?;
        validate_identifier("workspace id", &request.workspace_id)?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let session = match catalog.find(&SessionSelector::new(
            request.session_id.clone(),
            Some(request.workspace_id.clone()),
        )) {
            Ok(session) => session,
            Err(error) if error.is_session_absent() => {
                return managed_recovery::plan_missing_source(
                    &request,
                    runtime::current_build_id(),
                );
            }
            Err(error) => return Err(error.to_string()),
        };
        if let Some(expected) = &request.expected_source_fence {
            expected.validate()?;
            if session.session_class != SessionClass::Managed || !expected.matches(&session) {
                return Err(
                    "managed_recovery_source_fence_changed: source generation changed after preview"
                        .to_string(),
                );
            }
        }
        let target_build_id = runtime::current_build_id();
        let policy_input = if session.session_class == SessionClass::Standalone
            && session.provider_id == "local-shell"
        {
            let recipe = session
                .session_name
                .as_deref()
                .and_then(|name| verified_resurrection_recipe(catalog.discovery_root(), name));
            RecoveryPolicyInput::PlainShell {
                verified_recipe: recipe.is_some(),
                replays_explicit_command: recipe
                    .is_some_and(|recipe| recipe.requires_operator_confirmation()),
                confirmed: request.confirmed,
            }
        } else {
            RecoveryPolicyInput::ManagedProvider {
                resume_identity_present: request
                    .conversation_id
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty()),
                adapter_supports_exact_resume: request.adapter_supports_explicit_resume,
                confirmed: request.confirmed,
            }
        };
        match evaluate_recovery_policy(policy_input) {
            RecoveryDecision::RestorePlainShell {
                requires_confirmation,
            } => Ok(RecoveryPlanReceipt {
                session_id: session.session_id,
                source_build_id: session.host_build_version,
                target_build_id,
                action: "restore_plain_shell_with_current_build",
                allowed: true,
                reason: None,
                requires_confirmation,
            }),
            RecoveryDecision::ReplaceManagedProvider => Ok(RecoveryPlanReceipt {
                session_id: session.session_id,
                source_build_id: session.host_build_version,
                target_build_id,
                action: "replace_ai_provider_with_explicit_conversation",
                allowed: true,
                reason: None,
                requires_confirmation: true,
            }),
            RecoveryDecision::Refused {
                reason,
                requires_confirmation,
            } => Ok(recovery_refusal(
                &session,
                target_build_id,
                reason,
                requires_confirmation,
            )),
        }
    }

    pub fn execute_recovery<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        request: RecoveryExecutionRequest,
    ) -> Result<RecoveryExecutionReceipt, String> {
        validate_identifier("recovery id", &request.recovery_id)?;
        validate_identifier("session id", &request.session_id)?;
        validate_identifier("workspace id", &request.workspace_id)?;
        if request.require_socket_owner_absent
            && request.kind != RecoveryExecutionKind::ManagedProvider
        {
            return Err("socket_owner_recovery_requires_exact_managed_resume".into());
        }
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        if request.kind != RecoveryExecutionKind::PlainShell {
            return managed_recovery::execute(app, &catalog, request);
        }
        plain_shell_recovery::execute(self, app, &catalog, request)
    }

    pub fn reconcile_managed_recovery<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        request: ManagedRecoveryReconcileRequest,
    ) -> Result<Option<RecoveryExecutionReceipt>, String> {
        validate_identifier("recovery id", &request.recovery_id)?;
        validate_identifier("session id", &request.session_id)?;
        validate_identifier("workspace id", &request.workspace_id)?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        managed_recovery::reconcile(app, &catalog, request)
    }

    pub fn upgrade_standalone<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        request: StandaloneUpgradeRequest,
    ) -> Result<StandaloneUpgradeReceipt, String> {
        validate_identifier("upgrade id", &request.upgrade_id)?;
        validate_identifier("session id", &request.session_id)?;
        validate_identifier("workspace id", &request.workspace_id)?;
        validate_identifier("session name", &request.session_name)?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        standalone_upgrade::execute(self, app, &catalog, request)
    }

    pub fn exact_session_lifecycle(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<Option<&'static str>, String> {
        validate_identifier("session id", session_id)?;
        validate_identifier("workspace id", workspace_id)?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        match catalog.find(&SessionSelector::new(
            session_id,
            Some(workspace_id.to_string()),
        )) {
            Ok(session) => Ok(Some(match session.lifecycle {
                SessionLifecycle::Ready => "ready",
                SessionLifecycle::Exited => "exited",
            })),
            Err(hmux_client::ClientError::SessionNotFound { .. }) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn inspect_session_snapshot(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<ObserverSnapshot, String> {
        validate_identifier("session id", session_id)?;
        validate_identifier("workspace id", workspace_id)?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        let selector = SessionSelector::new(
            session_id.to_string(),
            Some(workspace_id.to_string()),
        );
        let session = catalog.find(&selector).map_err(|error| error.to_string())?;
        match runtime::select_client(&session.host_build_version, &session.supported_protocol) {
            runtime::ClientSelectionKind::DirectRust => {
                let observer = LocalSessionObserver::connect(
                    &catalog,
                    &selector,
                    ObserverAttachOptions::default(),
                )
                .map_err(|error| error.to_string())?;
                let snapshot = project_snapshot(observer.attachment().initial_snapshot.clone());
                observer.detach().map_err(|error| error.to_string())?;
                Ok(snapshot)
            }
            runtime::ClientSelectionKind::ExternalCliRequired => {
                runtime::snapshot_with_version_cli(
                    &session.host_build_version,
                    catalog.discovery_root(),
                    session_id,
                    workspace_id,
                )
                .and_then(project_external_snapshot)
            }
            runtime::ClientSelectionKind::Unavailable => Err(
                "hmux_version_matched_client_unavailable: no compatible snapshot client"
                    .to_string(),
            ),
        }
    }

    pub fn terminate_standalone_session(
        &self,
        session_id: &str,
        workspace_id: &str,
        graceful_timeout: Duration,
    ) -> Result<(), String> {
        validate_identifier("session id", session_id)?;
        validate_identifier("workspace id", workspace_id)?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;
        crate::session_checkout::close_standalone(catalog, session_id, workspace_id, None, graceful_timeout)
            .map(|_| ())
    }

    pub fn terminate_live_session_exact<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        workspace_id: &str,
        terminal_epoch: &str,
        session_class: SessionClass,
    ) -> Result<ExactSessionTerminationReceipt, String> {
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        exact_termination::terminate(
            app,
            session_id,
            workspace_id,
            terminal_epoch,
            session_class,
            Duration::from_secs(3),
        )
    }

    pub fn stop_managed_session<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        stop_id: &str,
        session_id: &str,
        workspace_id: &str,
        expected_fence: ManagedStopFence,
    ) -> Result<ManagedStopReceipt, String> {
        validate_identifier("managed stop id", stop_id)?;
        validate_identifier("session id", session_id)?;
        validate_identifier("workspace id", workspace_id)?;
        expected_fence.validate()?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let channel_epoch = expected_fence
            .channel_epoch
            .parse::<u64>()
            .map_err(|_| "managed stop channel epoch is invalid".to_string())?;
        let current = runtime::ensure_current_build(app)?;
        let working_directory = current
            .runtime
            .parent()
            .ok_or_else(|| "managed Hmux runtime has no parent directory".to_string())?;
        ManagedSessionStopper::new(&current.runtime, working_directory)
            .stop(
                ManagedStopRequest::new(stop_id, session_id, workspace_id)
                    .and_then(|request| {
                        request.with_expected_fence(
                            &expected_fence.runner_principal,
                            &expected_fence.runner_instance,
                            channel_epoch,
                            &expected_fence.host_instance_id,
                            &expected_fence.terminal_epoch,
                        )
                    })
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| format!("{}: {error}", error.code()))
    }

    pub fn stop_managed_create_chain<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        idempotency_key: &str,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<ManagedCreateChainStopReceipt, String> {
        let root = ManagedCreateReconcileRequest::new(
            idempotency_key,
            session_id,
            workspace_id,
        )
        .map_err(|error| error.to_string())?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let current = runtime::ensure_current_build(app)?;
        crate::session_checkout::close_legacy(current.runtime, None, root)
    }

    pub fn stop_managed_create_chain_v2<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        idempotency_key: &str,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<ManagedCreateChainStopReceiptV2, String> {
        let root = ManagedCreateReconcileRequest::new(
            idempotency_key,
            session_id,
            workspace_id,
        )
        .map_err(|error| error.to_string())?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let current = runtime::ensure_current_build(app)?;
        crate::session_checkout::close(current.runtime, None, root)
    }

    /// Deliver a provider-neutral hook observation through an ephemeral Host
    /// observer attach. Standalone transport uses its same-user manifest
    /// authority; managed transport mints a generation-scoped proof through
    /// the private broker. The proof remains inside hmux-client.
    ///
    /// This path does not mutate manager state or take the operations lock, so
    /// frequent lifecycle reports cannot delay interactive attach or stop.
    pub fn report_agent_state<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AgentStateReportRequest,
    ) -> Result<AgentStateReportReceiptSummary, AgentStateReportFailure> {
        let AgentStateReportRequest {
            session_id,
            workspace_id,
            expected_session_fence,
            activity,
            attention,
            turn_completed,
            turn_completion_id,
            causality,
            working_ttl_ms,
            conversation_identity,
            expected_observation,
        } = request;
        validate_identifier("session id", &session_id)
            .map_err(report_request_failure)?;
        if turn_completion_id.is_some() && !turn_completed {
            return Err(report_request_failure(
                "turn completion identity requires a completed turn",
            ));
        }
        if let Some(completion_id) = turn_completion_id.as_deref() {
            validate_identifier("turn completion id", completion_id)
                .map_err(report_request_failure)?;
        }
        if workspace_id.as_deref().is_some_and(str::is_empty) {
            return Err(report_request_failure("workspace id must not be empty"));
        }
        let expected_session_fence = expected_session_fence
            .map(ReportedSessionFence::into_session_fence)
            .transpose()
            .map_err(report_request_failure)?;
        if expected_session_fence.as_ref().is_some_and(|fence| {
            fence.session_id != session_id
                || workspace_id
                    .as_deref()
                    .is_some_and(|workspace| workspace != fence.workspace_id)
        }) {
            return Err(report_request_failure(
                "agent state report fence does not match the requested session",
            ));
        }
        let conversation_identity = conversation_identity
            .map(|identity| {
                let expected_fence = identity
                    .expected_fence
                    .map(ReportedSessionFence::into_session_fence)
                    .transpose()
                    .map_err(report_request_failure)?;
                if expected_fence.as_ref().is_some_and(|fence| {
                    fence.session_id != session_id
                        || workspace_id
                            .as_deref()
                            .is_some_and(|workspace| workspace != fence.workspace_id)
                }) {
                    return Err(report_request_failure(
                        "conversation identity fence does not match the requested session",
                    ));
                }
                Ok(ProviderConversationIdentity {
                    provider_id: identity.provider_id,
                    conversation_id: identity.conversation_id,
                    previous_conversation_id: identity.previous_conversation_id,
                    expected_fence,
                })
            })
            .transpose()?;
        let reported_conversation_id = conversation_identity
            .as_ref()
            .map(|identity| identity.conversation_id.clone());
        let expected_observation = expected_observation
            .map(|expected| {
                validate_identifier("terminal epoch", &expected.terminal_epoch)
                    .map_err(report_request_failure)?;
                let runtime_revision = parse_report_sequence(
                    "expected observation runtime revision",
                    &expected.runtime_revision,
                    false,
                )?;
                let output_sequence = parse_report_sequence(
                    "expected observation output sequence",
                    &expected.output_sequence,
                    true,
                )?;
                Ok(AgentStateReportObservationFence {
                    terminal_epoch: expected.terminal_epoch,
                    runtime_revision,
                    output_sequence,
                })
            })
            .transpose()?;
        let catalog = product_catalog().map_err(report_client_failure)?;
        let session = catalog
            .open(&SessionSelector::new(
                &session_id,
                workspace_id.clone(),
            ))
            .map_err(report_client_failure)?;
        let descriptor = session.descriptor();
        if expected_session_fence
            .as_ref()
            .is_some_and(|fence| !descriptor.matches_fence(fence))
        {
            return Err(report_request_failure(
                "agent state report fence does not match the current Host generation",
            ));
        }
        // Existing live Hosts predate provider event ids. Preserve their
        // established Claude hook behavior while new Hosts make delivery
        // retry/reload idempotent at the runtime authority.
        let turn_completion_id = turn_completion_id.filter(|_| {
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability == AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY)
        });
        let report = AgentStateReport {
            identity_only: false,
            activity: match activity {
                ReportedAgentActivity::Working => AgentRuntimeActivity::Working,
                ReportedAgentActivity::Waiting => AgentRuntimeActivity::Waiting,
            },
            attention: match attention {
                ReportedAgentAttention::None => AgentRuntimeAttention::None,
                ReportedAgentAttention::InputRequired => AgentRuntimeAttention::InputRequired,
                ReportedAgentAttention::ApprovalRequired => AgentRuntimeAttention::ApprovalRequired,
                ReportedAgentAttention::Error => AgentRuntimeAttention::Error,
            },
            turn_completed,
            turn_completion_id,
            causality,
            working_ttl_ms,
            conversation_identity,
            expected_observation,
        };
        if report
            .conversation_identity
            .as_ref()
            .and_then(|identity| identity.expected_fence.as_ref())
            .is_some_and(|fence| !descriptor.matches_fence(fence))
        {
            return Err(report_request_failure(
                "conversation identity fence does not match the current Host generation",
            ));
        }
        let outcome = match descriptor.session_class {
            SessionClass::Standalone => session
                .report_agent_state(report, None)
                .map_err(report_client_failure)?,
            SessionClass::Managed => {
                let current = runtime::ensure_current_build(app).map_err(|error| {
                    AgentStateReportFailure {
                        code: "hmux_runtime_unavailable".to_string(),
                        message: error,
                    }
                })?;
                let working_directory = current.runtime.parent().ok_or_else(|| {
                    AgentStateReportFailure {
                        code: "hmux_runtime_unavailable".to_string(),
                        message: "managed Hmux runtime has no parent directory".to_string(),
                    }
                })?;
                let attach_request = ManagedAttachRequest::new(
                    &descriptor.session_id,
                    &descriptor.workspace_id,
                )
                .map_err(|error| report_request_failure(error.to_string()))?;
                let reporter = ManagedAgentStateReporter::new(&current.runtime, working_directory);
                match expected_session_fence {
                    Some(expected_fence) => reporter.report_agent_state_for_fence(
                        attach_request,
                        report,
                        expected_fence,
                    ),
                    None => reporter.report_agent_state(attach_request, report),
                }
                .map_err(report_client_failure)?
            }
        };
        if descriptor.session_class == SessionClass::Managed {
            if let Some(conversation_id) = reported_conversation_id.as_deref() {
                if let Err(error) = crate::session_credentials::observe_managed_conversation(
                    descriptor,
                    conversation_id,
                ) {
                    eprintln!("credential session binding report failed: {error}");
                }
            } else if completed_codex_turn_needs_conversation_observation(
                descriptor.session_class,
                &descriptor.provider_id,
                turn_completed,
                outcome,
            ) {
                observe_completed_codex_conversation(app, descriptor);
            }
        }
        Ok(AgentStateReportReceiptSummary {
            outcome: report_outcome_label(outcome),
        })
    }

    fn report_managed_provider_conversation_identity<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        descriptor: &SessionDescriptor,
        conversation_id: &str,
    ) -> Result<(), String> {
        if !descriptor.capabilities.iter().any(|capability| {
            capability == PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY
        }) {
            // Existing live Hosts are never restarted just to gain an additive
            // projection capability. The exact inspected identity remains
            // usable in the current WebView compatibility path.
            return Ok(());
        }
        let channel_epoch = descriptor
            .channel_epoch
            .parse::<u64>()
            .ok()
            .filter(|epoch| *epoch > 0)
            .ok_or_else(|| {
                "conversation_identity_source_mismatch: Host channel epoch is invalid".to_string()
            })?;
        let expected_fence = SessionFence {
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch,
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        let current = runtime::ensure_current_build(app)?;
        let working_directory = current
            .runtime
            .parent()
            .ok_or_else(|| "managed Hmux runtime has no parent directory".to_string())?;
        let attach_request =
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                .map_err(|error| error.to_string())?;
        let outcome = ManagedAgentStateReporter::new(&current.runtime, working_directory)
            .report_agent_state_for_fence(
                attach_request,
                AgentStateReport {
                    identity_only: true,
                    // Ignored by Hosts that negotiated identity-only reports.
                    activity: AgentRuntimeActivity::Waiting,
                    attention: AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: Some(ProviderConversationIdentity {
                        provider_id: descriptor.provider_id.clone(),
                        conversation_id: conversation_id.to_string(),
                        previous_conversation_id: None,
                        expected_fence: Some(expected_fence.clone()),
                    }),
                    expected_observation: None,
                },
                expected_fence,
            )
            .map_err(|error| {
                format!(
                    "conversation_identity_host_projection_failed: {}",
                    error
                )
            })?;
        match outcome {
            AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp => Ok(()),
            AgentStateReportOutcome::DroppedExited => Err(
                "conversation_identity_source_unavailable: managed provider exited before Host projection"
                    .to_string(),
            ),
        }
    }
}

fn protected_build_ids<'a>(
    current_build_id: &str,
    sessions: impl IntoIterator<Item = (&'a str, &'a str, &'a str)>,
) -> Vec<String> {
    let mut protected = sessions
        .into_iter()
        .filter(|(manifest_lifecycle, _health, _build_id)| *manifest_lifecycle == "ready")
        .map(|(_manifest_lifecycle, _health, build_id)| build_id.to_string())
        .collect::<Vec<_>>();
    protected.push(current_build_id.to_string());
    protected.sort();
    protected.dedup();
    protected
}

impl Drop for HmuxManager {
    fn drop(&mut self) {
        let tasks = self
            .structured_terminals
            .lock()
            .expect("Hmux structured terminal registry poisoned")
            .drain()
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in tasks {
            task.stop();
        }
    }
}

fn project_snapshot(snapshot: ScreenSnapshotDescriptor) -> ObserverSnapshot {
    ObserverSnapshot {
        terminal_epoch: snapshot.terminal_epoch,
        sequence_through: snapshot.sequence_through,
        rows: snapshot.rows,
        columns: snapshot.columns,
        data: encode_bytes(&snapshot.repaint_bytes),
        alternate_screen: snapshot.alternate_screen,
        cursor_visible: snapshot.cursor_visible,
        truncated: snapshot.truncated,
        working_directory: snapshot.working_directory.map(project_working_directory),
        execution_location: snapshot.execution_location.map(project_execution_location),
        agent_identity: snapshot.agent_identity.map(project_agent_identity),
        agent_runtime_state: snapshot
            .agent_runtime_state
            .map(project_agent_runtime_state),
        provider_conversation_identity: snapshot
            .provider_conversation_identity
            .map(|identity| project_provider_conversation_identity(*identity)),
        recovered_presentation: snapshot
            .recovered_presentation
            .map(|recovered| project_recovered_presentation(*recovered)),
        actual_profile: snapshot.actual_profile.map(|profile| match profile {
            ScreenSnapshotProfileDescriptor::Full => "full",
            ScreenSnapshotProfileDescriptor::ViewportOnly => "viewport_only",
        }),
        in_reply_to_request_id: snapshot.in_reply_to_request_id,
    }
}

fn project_external_snapshot(
    snapshot: runtime::ExternalSnapshot,
) -> Result<ObserverSnapshot, String> {
    validate_identifier("terminal epoch", &snapshot.terminal_epoch)?;
    validate_identifier("output sequence", &snapshot.sequence_through)?;
    if snapshot.rows == 0 || snapshot.columns == 0 {
        return Err("hmux_external_cli_invalid: snapshot geometry is invalid".to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(snapshot.data.as_bytes())
        .map_err(|_| "hmux_external_cli_invalid: snapshot data is not base64".to_string())?;
    Ok(ObserverSnapshot {
        terminal_epoch: snapshot.terminal_epoch,
        sequence_through: snapshot.sequence_through,
        rows: snapshot.rows,
        columns: snapshot.columns,
        data: snapshot.data,
        alternate_screen: snapshot.alternate_screen,
        cursor_visible: snapshot.cursor_visible,
        truncated: snapshot.truncated,
        working_directory: None,
        execution_location: None,
        agent_identity: None,
        agent_runtime_state: None,
        provider_conversation_identity: None,
        recovered_presentation: None,
        actual_profile: None,
        in_reply_to_request_id: None,
    })
}

fn project_recovered_presentation(
    recovered: RecoveredPresentationDescriptor,
) -> ObserverRecoveredPresentation {
    ObserverRecoveredPresentation {
        source_session_id: recovered.source_session_id,
        source_host_instance_id: recovered.source_host_instance_id,
        source_terminal_epoch: recovered.source_terminal_epoch,
        source_sequence_through: recovered.source_sequence_through,
        captured_unix_ms: recovered.captured_unix_ms,
        truncated: recovered.truncated,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProbeHealth {
    CurrentHealthy,
    CompatibleOldHealthy,
    CompatibleOldReadOnly,
    StaleTransport,
    IncompatibleProtocol,
    ExternalCliFailed,
    Exited,
    GenerationChanged,
    Unprobed,
}

fn probe_and_project_session(
    catalog: &LocalSessionCatalog,
    session: SessionDescriptor,
) -> SessionSummary {
    probe_and_project_session_until(catalog, session, None)
}

fn probe_and_project_session_until(
    catalog: &LocalSessionCatalog,
    session: SessionDescriptor,
    deadline: Option<Instant>,
) -> SessionSummary {
    let health = if session.lifecycle == SessionLifecycle::Exited {
        ProbeHealth::Exited
    } else {
        match runtime::select_client(&session.host_build_version, &session.supported_protocol) {
            runtime::ClientSelectionKind::DirectRust => {
                let status = deadline.map_or_else(
                    || probe_local_session_exact(catalog, &session),
                    |deadline| probe_local_session_exact_until(catalog, &session, deadline),
                );
                match status {
                    SessionProbeStatus::Healthy => healthy_probe_classification(
                        runtime::current_build_id().as_deref(),
                        &session.host_build_version,
                    ),
                    SessionProbeStatus::StaleTransport => ProbeHealth::StaleTransport,
                    SessionProbeStatus::IncompatibleProtocol => ProbeHealth::IncompatibleProtocol,
                    SessionProbeStatus::Exited => ProbeHealth::Exited,
                    SessionProbeStatus::GenerationChanged => ProbeHealth::GenerationChanged,
                }
            }
            runtime::ClientSelectionKind::ExternalCliRequired => {
                let result = deadline.map_or_else(
                    || {
                        runtime::probe_with_version_cli(
                            &session.host_build_version,
                            catalog.discovery_root(),
                            &session,
                        )
                    },
                    |deadline| {
                        runtime::probe_with_version_cli_until(
                            &session.host_build_version,
                            catalog.discovery_root(),
                            &session,
                            deadline,
                        )
                    },
                );
                match result {
                    Ok(runtime::ExternalProbeStatus::Healthy) => {
                        let selector = SessionSelector::new(
                            session.session_id.clone(),
                            Some(session.workspace_id.clone()),
                        );
                        match catalog.find(&selector) {
                            Ok(current) if session.same_generation(&current) => {
                                ProbeHealth::CompatibleOldReadOnly
                            }
                            _ => ProbeHealth::GenerationChanged,
                        }
                    }
                    Ok(runtime::ExternalProbeStatus::StaleTransport) => {
                        ProbeHealth::StaleTransport
                    }
                    Ok(runtime::ExternalProbeStatus::IncompatibleProtocol) => {
                        ProbeHealth::IncompatibleProtocol
                    }
                    Ok(runtime::ExternalProbeStatus::Exited) => ProbeHealth::Exited,
                    Ok(runtime::ExternalProbeStatus::GenerationChanged) => {
                        ProbeHealth::GenerationChanged
                    }
                    Err(_) => ProbeHealth::ExternalCliFailed,
                }
            }
            runtime::ClientSelectionKind::Unavailable => ProbeHealth::IncompatibleProtocol,
        }
    };
    project_session_with_health(session, health)
}

pub(super) fn project_known_healthy_session(session: SessionDescriptor) -> SessionSummary {
    let health = healthy_probe_classification(
        runtime::current_build_id().as_deref(),
        &session.host_build_version,
    );
    project_session_with_health(session, health)
}

fn healthy_probe_classification(
    current_build_id: Option<&str>,
    host_build_version: &str,
) -> ProbeHealth {
    if current_build_id == Some(host_build_version) {
        ProbeHealth::CurrentHealthy
    } else {
        ProbeHealth::CompatibleOldHealthy
    }
}

fn project_exact_session_inspection(
    result: ExactSessionProbeResult,
) -> ExactSessionInspectionResult {
    match result {
        ExactSessionProbeResult::Inspection(inspection) => {
            let health = match inspection.probe_status() {
                Some(SessionProbeStatus::Healthy) => healthy_probe_classification(
                    runtime::current_build_id().as_deref(),
                    &inspection.descriptor.host_build_version,
                ),
                Some(SessionProbeStatus::StaleTransport) => ProbeHealth::StaleTransport,
                Some(SessionProbeStatus::IncompatibleProtocol) => {
                    ProbeHealth::IncompatibleProtocol
                }
                Some(SessionProbeStatus::Exited) => ProbeHealth::Exited,
                Some(SessionProbeStatus::GenerationChanged) => ProbeHealth::GenerationChanged,
                None => ProbeHealth::Unprobed,
            };
            let agent_runtime_state = inspection
                .agent_runtime_state
                .map(project_agent_runtime_state);
            ExactSessionInspectionResult::Found {
                session: Box::new(project_session_with_health(
                    inspection.descriptor,
                    health,
                )),
                agent_runtime_state,
            }
        }
        ExactSessionProbeResult::NotFound(selector) => {
            let (session_id, workspace_id) = exact_selector_identity(selector);
            ExactSessionInspectionResult::NotFound {
                session_id,
                workspace_id,
            }
        }
        ExactSessionProbeResult::LookupFailed {
            selector,
            error_code,
        } => {
            let (session_id, workspace_id) = exact_selector_identity(selector);
            ExactSessionInspectionResult::LookupFailed {
                session_id,
                workspace_id,
                error_code,
            }
        }
        ExactSessionProbeResult::Unprobed(selector) => {
            let (session_id, workspace_id) = exact_selector_identity(selector);
            ExactSessionInspectionResult::Unprobed {
                session_id,
                workspace_id,
            }
        }
    }
}

fn exact_selector_identity(selector: SessionSelector) -> (String, String) {
    (
        selector.session_id,
        selector
            .workspace_id
            .expect("validated exact discovery selector requires workspace id"),
    )
}

pub(super) fn project_session(session: SessionDescriptor) -> SessionSummary {
    let health = match session.lifecycle {
        SessionLifecycle::Ready => healthy_probe_classification(
            runtime::current_build_id().as_deref(),
            &session.host_build_version,
        ),
        SessionLifecycle::Exited => ProbeHealth::Exited,
    };
    project_session_with_health(session, health)
}

fn project_session_with_health(
    session: SessionDescriptor,
    health: ProbeHealth,
) -> SessionSummary {
    let manifest_lifecycle = match session.lifecycle {
        SessionLifecycle::Ready => "ready",
        SessionLifecycle::Exited => "exited",
    };
    let (lifecycle, health_name, input_allowed, detach_only, diagnostic) =
        health_projection(health);
    let client_selection =
        runtime::select_client(&session.host_build_version, &session.supported_protocol);
    // stale_transport는 "응답 없음"일 뿐 죽음의 증거가 아니라서 프론트가
    // 아무 동작도 내놓지 못한다(fail-closed). manifest pid가 확정적으로
    // 죽었으면 그 증거를 실어 준다 — 2026-07-31 실측: 목록 절반(25개)이
    // host가 죽은 stale 세션인데 전부 "안전한 작업 없음"에 머물렀다.
    let host_process_alive = if health == ProbeHealth::StaleTransport {
        crate::process_liveness::definitely_dead(session.host_process.process_id).then_some(false)
    } else {
        None
    };
    let stop_fence = (session.session_class == SessionClass::Managed).then(|| ManagedStopFence {
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch: session.channel_epoch.clone(),
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
    });
    let host_socket_owner_absent = (health == ProbeHealth::StaleTransport
        && session.session_class == SessionClass::Managed
        && hmux_client::local_host_socket_owner_absent(&session))
        .then_some(true);
    SessionSummary {
        session_id: session.session_id,
        session_name: session.session_name,
        workspace_id: session.workspace_id,
        session_class: match session.session_class {
            SessionClass::Managed => "managed",
            SessionClass::Standalone => "standalone",
        },
        lifecycle,
        manifest_lifecycle,
        health: health_name,
        host_build_version: session.host_build_version,
        client_selection,
        input_allowed,
        detach_only,
        diagnostic,
        failure: session.failure.map(|failure| SessionFailureSummary {
            correlation_id: failure.correlation_id,
            session_id: failure.session_id,
            workspace_id: failure.workspace_id,
            terminal_epoch: failure.terminal_epoch,
            code: failure.code,
            phase: failure.phase,
            summary: failure.summary,
            exit_kind: failure.exit_kind,
            exit_code: failure.exit_code,
            occurred_unix_ms: failure.occurred_unix_ms,
            retry_posture: failure.retry_posture,
        }),
        runtime_host: session.runtime_host,
        host_process_alive,
        host_socket_owner_absent,
        terminal_epoch: session.terminal_epoch,
        stop_fence,
        output_seq: session.output_seq,
        capabilities: session.capabilities,
        retirement_policy: session.retirement_policy.map(retirement::project_policy),
    }
}

fn health_projection(
    health: ProbeHealth,
) -> (
    &'static str,
    &'static str,
    bool,
    bool,
    Option<SessionDiagnostic>,
) {
    match health {
        ProbeHealth::CurrentHealthy => ("ready", "current_healthy", true, false, None),
        ProbeHealth::CompatibleOldHealthy => {
            ("ready", "compatible_old_healthy", true, false, None)
        }
        ProbeHealth::CompatibleOldReadOnly => (
            "ready",
            "compatible_old_healthy",
            false,
            true,
            Some(SessionDiagnostic {
                code: "hmux_version_matched_client_read_only",
                message: "A version-matched CLI verified the Host, but live input is not bridged.",
                retry: "detach_only",
            }),
        ),
        ProbeHealth::StaleTransport => (
            "unavailable",
            "stale_transport",
            false,
            true,
            Some(SessionDiagnostic {
                code: "hmux_stale_transport",
                message: "The manifest is ready but the bounded Hmux handshake failed.",
                retry: "detach_only",
            }),
        ),
        ProbeHealth::IncompatibleProtocol => (
            "unavailable",
            "incompatible_protocol",
            false,
            true,
            Some(SessionDiagnostic {
                code: "hmux_incompatible_protocol",
                message: "The live Hmux Host rejected the direct client protocol.",
                retry: "version_matched_client_required",
            }),
        ),
        ProbeHealth::ExternalCliFailed => (
            "unavailable",
            "incompatible_protocol",
            false,
            true,
            Some(SessionDiagnostic {
                code: "hmux_external_cli_bridge_failed",
                message: "The explicit version-matched health bridge failed.",
                retry: "version_matched_client_required",
            }),
        ),
        ProbeHealth::Exited => ("exited", "exited", false, true, None),
        ProbeHealth::GenerationChanged => (
            "unavailable",
            "generation_changed",
            false,
            true,
            Some(SessionDiagnostic {
                code: "hmux_session_generation_changed",
                message: "The session generation changed while its health was being verified.",
                retry: "refresh_session_census",
            }),
        ),
        ProbeHealth::Unprobed => (
            "unavailable",
            "unprobed",
            false,
            true,
            Some(SessionDiagnostic {
                code: "hmux_health_unprobed",
                message: "The session was not probed before the bounded census deadline.",
                retry: "refresh_session_census",
            }),
        ),
    }
}

fn recovery_refusal(
    session: &SessionDescriptor,
    target_build_id: Option<String>,
    reason: &'static str,
    requires_confirmation: bool,
) -> RecoveryPlanReceipt {
    RecoveryPlanReceipt {
        session_id: session.session_id.clone(),
        source_build_id: session.host_build_version.clone(),
        target_build_id,
        action: "none",
        allowed: false,
        reason: Some(reason),
        requires_confirmation,
    }
}

fn recovery_execution_refusal(
    session: &SessionDescriptor,
    target_build_id: Option<String>,
    reason: &'static str,
) -> RecoveryExecutionReceipt {
    recovery_request_refusal(&session.session_id, target_build_id, reason)
}

fn recovery_request_refusal(
    source_session_id: &str,
    target_build_id: Option<String>,
    reason: &'static str,
) -> RecoveryExecutionReceipt {
    RecoveryExecutionReceipt {
        source_session_id: source_session_id.to_string(),
        target_build_id,
        action: "none",
        outcome: "refused",
        replayed: false,
        reason: Some(reason),
        operation_id: None,
        conversation_id: None,
        launch_reference: None,
        source_stop_receipt: None,
        replacement_target: None,
        replacement_session: None,
    }
}


/// Provider-specific resume syntax stays in the product adapter. The Hmux
/// client layer only sees a verified opaque recipe and remains provider
/// neutral.
fn ambiguous_provider_resume_recipe(command: &[String]) -> Option<&'static str> {
    let tokens = command
        .iter()
        .flat_map(|argument| argument.split_whitespace())
        .map(|token| token.trim_matches(['\'', '"']).to_string())
        .collect::<Vec<_>>();
    let providers = [
        ("codex", "resume", &["--last"][..]),
        ("claude", "--resume", &["--continue"][..]),
        ("kimi", "-S", &[][..]),
    ];
    for (provider, resume_marker, implicit_markers) in providers {
        let Some(provider_index) = tokens.iter().position(|token| {
            token
                .rsplit('/')
                .next()
                .is_some_and(|name| name == provider)
        }) else {
            continue;
        };
        let provider_arguments = &tokens[provider_index + 1..];
        if provider_arguments
            .iter()
            .any(|token| implicit_markers.contains(&token.as_str()))
        {
            return Some("upgrade_resume_identity_ambiguous");
        }
        let exact_resume = provider_arguments
            .windows(2)
            .any(|pair| pair[0] == resume_marker && !pair[1].starts_with('-'));
        if !exact_resume {
            return Some("upgrade_resume_identity_ambiguous");
        }
    }
    None
}

fn exact_adoption_resume_command(
    provider_id: &str,
    conversation_id: &str,
    permission_mode: PermissionMode,
) -> Result<String, String> {
    validate_cli_identity("conversation id", conversation_id)?;
    crate::managed_provider_launch::exact_command(provider_id, permission_mode, conversation_id)
        .ok_or_else(|| {
            "legacy_adoption_adapter_unsupported: exact resume adapter is unavailable".to_string()
        })
}

fn resolve_managed_provider_state_environment(
    provider_id: &str,
    credential_id: Option<&str>,
    credential_directory: Option<&str>,
) -> Result<ProviderStateEnvironment, String> {
    let home = std::env::var("HOME").map_err(|error| error.to_string())?;
    crate::accounts::prepare_managed_provider_profile(
        provider_id,
        &home,
        credential_id,
        credential_directory,
    )
}

fn validate_cli_identity(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
        })
    {
        return Err(format!("{name} must be a safe command-line identity"));
    }
    Ok(())
}


fn verified_resurrection_recipe(
    discovery_root: &std::path::Path,
    session_name: &str,
) -> Option<StandaloneResurrectionRecipe> {
    const MAX_RECIPE_BYTES: u64 = 256 * 1024;

    let directory = discovery_root.join(".resurrection");
    let metadata = fs::symlink_metadata(&directory).ok()?;
    if !private_resurrection_metadata(&metadata, true) {
        return None;
    }
    let mut digest = Sha256::new();
    digest.update(session_name.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    let path = directory.join(format!("recipe_{}.json", &digest[..32]));
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !private_resurrection_metadata(&metadata, false) || metadata.len() > MAX_RECIPE_BYTES {
        return None;
    }
    let recipe: StandaloneResurrectionRecipe =
        serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (recipe.validate().is_ok() && recipe.session_name() == session_name).then_some(recipe)
}

#[cfg(unix)]
fn private_resurrection_metadata(metadata: &fs::Metadata, directory: bool) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    !metadata.file_type().is_symlink()
        && if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }
        // SAFETY: geteuid takes no arguments and only reads process identity.
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn private_resurrection_metadata(_metadata: &fs::Metadata, _directory: bool) -> bool {
    false
}

#[cfg(unix)]
fn process_generation_is_live(process: &hmux_client::ProcessDescriptor) -> bool {
    match probe_local_process_generation(process) {
        Ok(LocalProcessGenerationStatus::Live) => true,
        Ok(LocalProcessGenerationStatus::Absent) => false,
        // Replacement operations may create a second provider, so an
        // unprovable descriptor remains live instead of being treated as dead.
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn process_generation_is_live(_process: &hmux_client::ProcessDescriptor) -> bool {
    // Fail closed until the platform has a trustworthy process inventory.
    true
}

fn project_agent_identity(agent_identity: AgentIdentityDescriptor) -> ObserverAgentIdentity {
    ObserverAgentIdentity {
        terminal_epoch: agent_identity.terminal_epoch,
        observed_through_output_seq: agent_identity.observed_through_output_seq,
        agent: agent_identity.agent.map(AgentProvider::as_str),
        source: match agent_identity.source {
            AgentIdentitySource::ProcessInspection => "process_inspection",
        },
    }
}

fn project_agent_runtime_state(state: AgentRuntimeStateDescriptor) -> ObserverAgentRuntimeState {
    ObserverAgentRuntimeState {
        terminal_epoch: state.terminal_epoch,
        revision: state.revision,
        observed_through_output_seq: state.observed_through_output_seq,
        lifecycle: match state.lifecycle {
            AgentRuntimeLifecycle::Starting => "starting",
            AgentRuntimeLifecycle::Running => "running",
            AgentRuntimeLifecycle::Exited => "exited",
        },
        activity: match state.activity {
            AgentRuntimeActivity::Working => "working",
            AgentRuntimeActivity::Waiting => "waiting",
        },
        attention: match state.attention {
            AgentRuntimeAttention::None => "none",
            AgentRuntimeAttention::InputRequired => "input_required",
            AgentRuntimeAttention::ApprovalRequired => "approval_required",
            AgentRuntimeAttention::Error => "error",
        },
        attention_id: state.attention_id,
        source: match state.source {
            AgentRuntimeStateSource::ProviderEvent => "provider_event",
            AgentRuntimeStateSource::OrchestrationEvent => "orchestration_event",
            AgentRuntimeStateSource::ControllerInput => "controller_input",
            AgentRuntimeStateSource::ProcessLifecycle => "process_lifecycle",
        },
        turn_completed_count: state.turn_completed_count,
    }
}

pub(super) fn project_provider_conversation_identity(
    identity: ProviderConversationIdentityDescriptor,
) -> ObserverProviderConversationIdentity {
    ObserverProviderConversationIdentity {
        session_id: identity.session_id,
        workspace_id: identity.workspace_id,
        runner_principal: identity.runner_principal,
        runner_instance: identity.runner_instance,
        channel_epoch: identity.channel_epoch,
        host_instance_id: identity.host_instance_id,
        terminal_epoch: identity.terminal_epoch,
        revision: identity.revision,
        observed_through_output_seq: identity.observed_through_output_seq,
        provider_id: identity.provider_id,
        conversation_id: identity.conversation_id,
        source: match identity.source {
            ProviderConversationIdentitySource::LaunchRequest => "launch_request",
            ProviderConversationIdentitySource::ProviderEvent => "provider_event",
        },
    }
}

fn project_working_directory(
    working_directory: WorkingDirectoryDescriptor,
) -> ObserverWorkingDirectory {
    ObserverWorkingDirectory {
        terminal_epoch: working_directory.terminal_epoch,
        observed_through_output_seq: working_directory.observed_through_output_seq,
        path: working_directory.path,
        source: match working_directory.source {
            WorkingDirectorySource::LaunchFallback => "launch_fallback",
            WorkingDirectorySource::Osc7 => "osc7",
            WorkingDirectorySource::ProcessInspection => "process_inspection",
        },
    }
}

fn project_execution_location(
    execution_location: ExecutionLocationDescriptor,
) -> ObserverExecutionLocation {
    ObserverExecutionLocation {
        terminal_epoch: execution_location.terminal_epoch,
        observed_through_output_seq: execution_location.observed_through_output_seq,
        location: match execution_location.location {
            ExecutionLocation::Local => ObserverExecutionLocationValue::Local,
            ExecutionLocation::Ssh { target } => {
                ObserverExecutionLocationValue::Ssh { target }
            }
        },
        source: match execution_location.source {
            ExecutionLocationSource::ProcessInspection => "process_inspection",
        },
    }
}

fn encode_bytes(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl ReportedSessionFence {
    fn into_session_fence(self) -> Result<SessionFence, String> {
        for (name, value) in [
            ("workspace id", self.workspace_id.as_str()),
            ("session id", self.session_id.as_str()),
            ("runner principal", self.runner_principal.as_str()),
            ("runner instance", self.runner_instance.as_str()),
            ("host instance id", self.host_instance_id.as_str()),
            ("terminal epoch", self.terminal_epoch.as_str()),
        ] {
            validate_identifier(name, value)?;
        }
        let channel_epoch = self
            .channel_epoch
            .parse::<u64>()
            .ok()
            .filter(|epoch| *epoch > 0)
            .ok_or_else(|| "channel epoch must be a non-zero decimal u64".to_string())?;
        Ok(SessionFence {
            workspace_id: self.workspace_id,
            session_id: self.session_id,
            runner_principal: self.runner_principal,
            runner_instance: self.runner_instance,
            channel_epoch,
            host_instance_id: self.host_instance_id,
            terminal_epoch: self.terminal_epoch,
        })
    }
}

fn parse_report_sequence(
    name: &str,
    value: &str,
    allow_zero: bool,
) -> Result<u64, AgentStateReportFailure> {
    let parsed = value
        .parse::<u64>()
        .ok()
        .filter(|parsed| allow_zero || *parsed > 0)
        .filter(|parsed| parsed.to_string() == value)
        .ok_or_else(|| {
            report_request_failure(format!(
                "{name} must be a canonical {}decimal u64",
                if allow_zero { "" } else { "non-zero " },
            ))
        })?;
    Ok(parsed)
}

pub(super) fn validate_identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(format!("{name} must be a bounded non-control string"));
    }
    Ok(())
}

/// Read the complete product catalog inside a reclaimable runtime helper.
///
/// A missing or timed-out helper is an explicit census failure. Returning an
/// empty or shorter vector would let every Tauri consumer mistake unvisited
/// sessions for absence and retire presentation state that still has a Host.
pub(super) fn product_catalog_census(
    total_budget: Duration,
) -> Result<(LocalSessionCatalog, Vec<SessionDescriptor>), String> {
    let catalog = product_catalog().map_err(|error| error.to_string())?;
    let sessions = catalog_census_with_runtime(&catalog, total_budget)?;
    Ok((catalog, sessions))
}

fn catalog_census_with_runtime(
    catalog: &LocalSessionCatalog,
    total_budget: Duration,
) -> Result<Vec<SessionDescriptor>, String> {
    let worker = catalog_census_worker()?;
    let sessions = list_local_sessions_isolated(catalog, &worker, total_budget)
        .map_err(|error| error.to_string())?;
    Ok(sessions)
}

fn catalog_census_worker() -> Result<CatalogCensusWorker, String> {
    let executable = discovery_worker_executable()?;
    Ok(CatalogCensusWorker::new(executable))
}

/// Policy for the scheduled hygiene pass. Default Retention selection only
/// removes under budget pressure (512 entries / 512MiB), so a root with 109
/// sessions planned zero work while 10 day-old retired entries persisted
/// (2026-08-25 live). Hygiene wants every age-qualified retired entry gone;
/// ages, caps, and protections keep their defaults.
fn scheduled_state_gc_policy() -> LocalStateGcPolicy {
    let mut policy = LocalStateGcPolicy::default();
    policy.discovery.selection = DiscoveryGcSelection::AllEligible;
    policy
}

fn exact_discovery_worker() -> Result<ExactDiscoveryWorker, String> {
    discovery_worker_executable().map(ExactDiscoveryWorker::new)
}

fn discovery_worker_executable() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| {
        format!("hmux_discovery_worker_unavailable: desktop executable is unavailable: {error}")
    })?;
    discovery_worker::resolve(&executable)
}

fn resolve_catalog_target_with_runtime(
    catalog: &LocalSessionCatalog,
    target: &str,
    total_budget: Duration,
) -> Result<LocalSession, String> {
    let worker = catalog_census_worker()?;
    resolve_local_session_isolated(catalog, &worker, target, total_budget)
        .map_err(|error| error.to_string())
}

fn resolve_catalog_name_with_runtime(
    catalog: &LocalSessionCatalog,
    name: &str,
    total_budget: Duration,
) -> Result<LocalSession, String> {
    let worker = catalog_census_worker()?;
    resolve_local_session_name_isolated(catalog, &worker, name, total_budget)
        .map_err(|error| error.to_string())
}

pub(crate) fn legacy_attached_session_summary(legacy_session_id: &str) -> Option<SessionSummary> {
    let session = legacy_attached_hmux_session(legacy_session_id)?;
    Some(project_session(session.descriptor().clone()))
}

fn legacy_attached_hmux_session(legacy_session_id: &str) -> Option<LocalSession> {
    let target = legacy_attached_hmux_target(legacy_session_id)?;
    let catalog = product_catalog().ok()?;
    resolve_catalog_target_with_runtime(&catalog, &target, CENSUS_TOTAL_BUDGET).ok()
}

fn legacy_attached_hmux_target(legacy_session_id: &str) -> Option<String> {
    // cwd/agent polling shares the same host-wide process census as agent
    // detection. The legacy index adds a longer TTL, and refreshes outside its
    // mutex so a slow OS sample cannot serialize every polling pane.
    static ATTACH_TARGET_CACHE: Mutex<LegacyAttachTargetCache> =
        Mutex::new(LegacyAttachTargetCache {
            snapshot: None,
            refresh_in_flight: false,
            last_refresh_failed_at: None,
        });
    cached_legacy_attached_hmux_target(
        legacy_session_id,
        &ATTACH_TARGET_CACHE,
        || SharedProcessSampler::host_default().ok()?.process_snapshot().ok(),
    )
}

const LEGACY_ATTACH_TARGET_TTL: Duration = Duration::from_millis(1500);
const LEGACY_ATTACH_RETRY_TTL: Duration = Duration::from_millis(1500);
const LEGACY_ATTACH_MAX_STALE: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct LegacyAttachTargetSnapshot {
    sampled_at: Instant,
    targets: HashMap<String, String>,
}

#[derive(Debug, Default)]
struct LegacyAttachTargetCache {
    snapshot: Option<LegacyAttachTargetSnapshot>,
    refresh_in_flight: bool,
    last_refresh_failed_at: Option<Instant>,
}

fn cached_legacy_attached_hmux_target(
    legacy_session_id: &str,
    cache: &Mutex<LegacyAttachTargetCache>,
    scan_processes: impl FnOnce() -> Option<ProcessSnapshot>,
) -> Option<String> {
    if legacy_session_id.is_empty() {
        return None;
    }

    let stale_target = {
        let mut cache = cache.lock().ok()?;
        if let Some(snapshot) = cache
            .snapshot
            .as_ref()
            .filter(|snapshot| snapshot.sampled_at.elapsed() < LEGACY_ATTACH_TARGET_TTL)
        {
            return snapshot.targets.get(legacy_session_id).cloned();
        }
        let stale_target = cache
            .snapshot
            .as_ref()
            .filter(|snapshot| snapshot.sampled_at.elapsed() < LEGACY_ATTACH_MAX_STALE)
            .and_then(|snapshot| snapshot.targets.get(legacy_session_id))
            .cloned();
        if cache.refresh_in_flight
            || cache
                .last_refresh_failed_at
                .is_some_and(|failed_at| failed_at.elapsed() < LEGACY_ATTACH_RETRY_TTL)
        {
            return stale_target;
        }
        cache.refresh_in_flight = true;
        stale_target
    };

    let refreshed = scan_processes().map(|processes| {
        let targets = attached_hmux_targets_from_processes(&processes.processes);
        let target = targets.get(legacy_session_id).cloned();
        (
            target,
            LegacyAttachTargetSnapshot {
                sampled_at: Instant::now(),
                targets,
            },
        )
    });

    let mut cache = cache.lock().ok()?;
    cache.refresh_in_flight = false;
    if let Some((target, snapshot)) = refreshed {
        cache.snapshot = Some(snapshot);
        cache.last_refresh_failed_at = None;
        return target;
    }
    cache.last_refresh_failed_at = Some(Instant::now());
    stale_target
}

#[cfg(test)]
fn attached_hmux_target_from_processes(
    legacy_session_id: &str,
    process_output: &str,
) -> Option<String> {
    if legacy_session_id.is_empty() {
        return None;
    }
    attached_hmux_targets_from_processes(&process_records_for_test(process_output))
        .get(legacy_session_id)
        .cloned()
}

fn attached_hmux_targets_from_processes(records: &[ProcessRecord]) -> HashMap<String, String> {
    let mut roots = HashMap::<String, Vec<u32>>::new();
    let mut children = HashMap::<u32, Vec<u32>>::new();
    let mut commands = HashMap::<u32, &str>::new();
    for record in records {
        for session_id in served_session_ids(&record.command) {
            roots
                .entry(session_id.to_string())
                .or_default()
                .push(record.pid);
        }
        children
            .entry(record.parent_pid)
            .or_default()
            .push(record.pid);
        commands.insert(record.pid, &record.command);
    }

    roots
        .into_iter()
        .filter_map(|(session_id, session_roots)| {
            let mut queue = VecDeque::from(session_roots);
            let mut visited = HashSet::new();
            while let Some(pid) = queue.pop_front() {
                if !visited.insert(pid) {
                    continue;
                }
                if let Some(target) = commands
                    .get(&pid)
                    .and_then(|command| hmux_attach_target(command))
                {
                    return Some((session_id, target));
                }
                if let Some(descendants) = children.get(&pid) {
                    queue.extend(descendants);
                }
            }
            None
        })
        .collect()
}

fn served_session_ids(command: &str) -> impl Iterator<Item = &str> {
    command
        .split_whitespace()
        .zip(command.split_whitespace().skip(1))
        .filter_map(|(token, session_id)| (token == "__serve").then_some(session_id))
}

#[cfg(test)]
fn parse_process_record_for_test(line: &str) -> Option<ProcessRecord> {
    let line = line.trim_start();
    let (pid, rest) = line.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (parent_pid, rest) = rest.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (session_id, command) = rest.split_once(char::is_whitespace)?;
    Some(ProcessRecord {
        pid: pid.parse().ok()?,
        parent_pid: parent_pid.parse().ok()?,
        session_id: session_id.parse().ok()?,
        command: command.trim_start().to_string(),
    })
}

#[cfg(test)]
fn process_records_for_test(snapshot: &str) -> Vec<ProcessRecord> {
    snapshot
        .lines()
        .filter_map(parse_process_record_for_test)
        .collect()
}

fn hmux_attach_target(command: &str) -> Option<String> {
    let tokens = command.split_whitespace().collect::<Vec<_>>();
    let hmux_index = tokens.iter().position(|token| {
        token
            .trim_matches(|character| character == '\'' || character == '"')
            .rsplit('/')
            .next()
            == Some("hmux")
    })?;
    let attach_index = tokens
        .iter()
        .enumerate()
        .skip(hmux_index + 1)
        .find(|(_, token)| matches!(**token, "attach" | "a" | "at" | "attach-session"))
        .map(|(index, _)| index)?;

    let mut index = attach_index + 1;
    while index < tokens.len() {
        let token = tokens[index];
        match token {
            "-t" | "--target" => {
                return tokens
                    .get(index + 1)
                    .map(|target| target.trim_matches(['\'', '"']).to_string())
                    .filter(|target| !target.is_empty());
            }
            "-r" | "--read-only" | "--observer" | "--" => {
                index += 1;
            }
            _ if token.starts_with("--target=") => {
                return token
                    .strip_prefix("--target=")
                    .map(|target| target.trim_matches(['\'', '"']).to_string())
                    .filter(|target| !target.is_empty());
            }
            _ if token.starts_with('-') => {
                index += 1;
            }
            _ => {
                let target = token.trim_matches(['\'', '"']);
                return (!target.is_empty()).then(|| target.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_plane_census_serializes_optional_phase_diagnostics() {
        let with_diagnostics = ControlPlaneCensus {
            policy: runtime::update_policy_state(),
            sessions: Vec::new(),
            protected_build_ids: Vec::new(),
            diagnostics: Some(ControlPlaneCensusDiagnostics {
                catalog_us: 7,
                health_projection_us: 18,
                total_us: 29,
                joined_existing: true,
            }),
        };
        let encoded = serde_json::to_value(with_diagnostics).unwrap();
        assert_eq!(
            encoded.get("diagnostics"),
            Some(&serde_json::json!({
                "catalogUs": 7,
                "healthProjectionUs": 18,
                "totalUs": 29,
                "joinedExisting": true,
            }))
        );

        let without_diagnostics = ControlPlaneCensus {
            policy: runtime::update_policy_state(),
            sessions: Vec::new(),
            protected_build_ids: Vec::new(),
            diagnostics: None,
        };
        let encoded = serde_json::to_value(without_diagnostics).unwrap();
        assert!(encoded.get("diagnostics").is_none());
    }

    #[test]
    fn new_managed_agent_create_upgrades_a_legacy_stop_requirement_to_v5() {
        let legacy = ManagedCreateRequest::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            PermissionMode::Default,
            std::env::current_dir().unwrap(),
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
        )
        .unwrap();

        let current = require_conversation_fenced_managed_stop_lifecycle(legacy).unwrap();

        assert_eq!(
            current.required_managed_stop_request_version(),
            Some(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        );
    }

    #[test]
    fn scheduled_state_gc_selects_every_age_qualified_retired_entry() {
        // Retention selection planned zero work on a 109-session root while
        // 10 day-old retired entries persisted (2026-08-25 live) — hygiene
        // needs AllEligible; everything else keeps hmux defaults.
        let policy = scheduled_state_gc_policy();
        assert!(matches!(
            policy.discovery.selection,
            DiscoveryGcSelection::AllEligible
        ));
        assert_eq!(policy.discovery.minimum_age_ms, 24 * 60 * 60 * 1_000);
    }

    #[test]
    fn state_gc_mode_is_parsed_at_the_command_boundary() {
        let manager = HmuxManager::default();
        let error = manager.local_state_gc("purge").unwrap_err();
        assert!(
            error.starts_with("hmux_state_gc_invalid_mode:"),
            "unknown modes must fail closed with a typed code: {error}"
        );
    }

    #[test]
    fn accepted_managed_codex_completion_discovers_a_missing_conversation() {
        for outcome in [AgentStateReportOutcome::Applied, AgentStateReportOutcome::NoOp] {
            assert!(completed_codex_turn_needs_conversation_observation(
                SessionClass::Managed,
                "codex",
                true,
                outcome,
            ));
        }
        for (session_class, provider_id, completed, outcome) in [
            (
                SessionClass::Standalone,
                "codex",
                true,
                AgentStateReportOutcome::Applied,
            ),
            (
                SessionClass::Managed,
                "claude",
                true,
                AgentStateReportOutcome::Applied,
            ),
            (
                SessionClass::Managed,
                "codex",
                false,
                AgentStateReportOutcome::Applied,
            ),
            (
                SessionClass::Managed,
                "codex",
                true,
                AgentStateReportOutcome::DroppedExited,
            ),
        ] {
            assert!(!completed_codex_turn_needs_conversation_observation(
                session_class,
                provider_id,
                completed,
                outcome,
            ));
        }
    }

    #[test]
    fn exact_discovery_absence_preserves_workspace_identity_on_the_wire() {
        let projected = project_exact_session_inspection(
            ExactSessionProbeResult::NotFound(SessionSelector::new(
                "shared-id",
                Some("workspace-b".into()),
            )),
        );
        assert_eq!(
            serde_json::to_value(projected).unwrap(),
            serde_json::json!({
                "outcome": "not_found",
                "sessionId": "shared-id",
                "workspaceId": "workspace-b",
            })
        );
    }

    #[test]
    fn agent_runtime_state_projection_carries_turn_completed_count() {
        let projected = project_agent_runtime_state(AgentRuntimeStateDescriptor {
            terminal_epoch: "epoch-1".into(),
            revision: "7".into(),
            observed_through_output_seq: "42".into(),
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Waiting,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: "3".into(),
        });
        assert_eq!(projected.turn_completed_count, "3");
        assert_eq!(projected.activity, "waiting");
    }

    #[test]
    fn provider_conversation_projection_preserves_complete_fence_and_opaque_identity() {
        let projected =
            project_provider_conversation_identity(ProviderConversationIdentityDescriptor {
                session_id: "session-1".into(),
                workspace_id: "workspace-1".into(),
                runner_principal: "local-user".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: "4".into(),
                host_instance_id: "host-1".into(),
                terminal_epoch: "terminal-1".into(),
                revision: "2".into(),
                observed_through_output_seq: "42".into(),
                provider_id: "codex".into(),
                conversation_id: "conversation:opaque-1".into(),
                source: ProviderConversationIdentitySource::ProviderEvent,
            });

        assert_eq!(projected.session_id, "session-1");
        assert_eq!(projected.workspace_id, "workspace-1");
        assert_eq!(projected.channel_epoch, "4");
        assert_eq!(projected.host_instance_id, "host-1");
        assert_eq!(projected.terminal_epoch, "terminal-1");
        assert_eq!(projected.revision, "2");
        assert_eq!(projected.observed_through_output_seq, "42");
        assert_eq!(projected.conversation_id, "conversation:opaque-1");
        assert_eq!(projected.source, "provider_event");
    }

    #[test]
    fn report_outcomes_project_to_wire_labels() {
        assert_eq!(
            report_outcome_label(AgentStateReportOutcome::Applied),
            "applied"
        );
        assert_eq!(
            report_outcome_label(AgentStateReportOutcome::DroppedExited),
            "dropped_exited"
        );
        assert_eq!(report_outcome_label(AgentStateReportOutcome::NoOp), "no_op");
    }

    #[test]
    fn report_requests_reject_unbounded_identifiers() {
        let failure = report_request_failure("workspace id must not be empty");
        assert_eq!(failure.code, "hmux_invalid_request");
    }

    #[test]
    fn report_debug_redacts_provider_conversation_identity() {
        let request = AgentStateReportRequest {
            session_id: "session-1".into(),
            workspace_id: Some("workspace-1".into()),
            expected_session_fence: None,
            activity: ReportedAgentActivity::Waiting,
            attention: ReportedAgentAttention::None,
            turn_completed: false,
            turn_completion_id: None,
            causality: None,
            working_ttl_ms: None,
            conversation_identity: Some(ReportedProviderConversationIdentity {
                provider_id: "codex".into(),
                conversation_id: "conversation-secret".into(),
                previous_conversation_id: None,
                expected_fence: None,
            }),
            expected_observation: None,
        };

        let debug = format!("{request:?}");
        assert!(!debug.contains("conversation-secret"));
        assert!(debug.contains("has_conversation_identity"));
    }

    #[test]
    fn report_observation_sequences_require_canonical_decimals() {
        assert_eq!(
            parse_report_sequence("runtime revision", "12", false).unwrap(),
            12
        );
        assert_eq!(
            parse_report_sequence("output sequence", "0", true).unwrap(),
            0
        );
        assert!(parse_report_sequence("runtime revision", "0", false).is_err());
        assert!(parse_report_sequence("runtime revision", "012", false).is_err());
        assert!(parse_report_sequence("output sequence", "+1", true).is_err());
    }

    #[test]
    fn reported_fence_requires_a_complete_nonzero_generation() {
        let valid = ReportedSessionFence {
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            runner_principal: "local-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        };
        assert!(valid.clone().into_session_fence().is_ok());
        assert!(
            ReportedSessionFence {
                channel_epoch: "0".into(),
                ..valid
            }
            .into_session_fence()
            .is_err()
        );
    }

    #[test]
    fn observer_identifiers_are_bounded() {
        assert!(validate_identifier("id", "pane-1").is_ok());
        assert!(validate_identifier("id", "").is_err());
        assert!(validate_identifier("id", "pane\n1").is_err());
        assert!(validate_identifier("id", &"x".repeat(257)).is_err());
    }

    #[test]
    fn projected_bytes_use_compact_base64() {
        assert_eq!(encode_bytes(&[0, 1, 2, 255]), "AAEC/w==");
    }

    #[test]
    fn stale_transport_projection_is_unavailable_and_detach_only() {
        let projection = health_projection(ProbeHealth::StaleTransport);
        assert_eq!(projection.0, "unavailable");
        assert_eq!(projection.1, "stale_transport");
        assert!(!projection.2);
        assert!(projection.3);
        assert_eq!(
            projection.4.as_ref().map(|diagnostic| diagnostic.code),
            Some("hmux_stale_transport")
        );
    }

    #[test]
    fn unprobed_projection_never_claims_health_or_writable_input() {
        let projection = health_projection(ProbeHealth::Unprobed);
        assert_eq!(projection.0, "unavailable");
        assert_eq!(projection.1, "unprobed");
        assert!(!projection.2);
        assert!(projection.3);
        assert_eq!(
            projection.4.as_ref().map(|diagnostic| diagnostic.code),
            Some("hmux_health_unprobed")
        );
    }

    #[test]
    fn every_ready_manifest_protects_its_build_even_when_probe_health_is_uncertain() {
        let protected = protected_build_ids(
            "build-current",
            [
                ("ready", "unprobed", "build-unprobed"),
                ("ready", "stale_transport", "build-stale"),
                (
                    "ready",
                    "incompatible_protocol",
                    "build-incompatible",
                ),
                ("ready", "external_probe_failed", "build-external"),
                ("exited", "exited", "build-retired"),
            ],
        );

        assert_eq!(
            protected,
            vec![
                "build-current",
                "build-external",
                "build-incompatible",
                "build-stale",
                "build-unprobed",
            ]
        );
    }

    #[test]
    fn version_matched_cli_health_is_read_only_and_detach_only() {
        let projection = health_projection(ProbeHealth::CompatibleOldReadOnly);
        assert_eq!(projection.0, "ready");
        assert_eq!(projection.1, "compatible_old_healthy");
        assert!(!projection.2);
        assert!(projection.3);
        assert_eq!(
            projection.4.as_ref().map(|diagnostic| diagnostic.code),
            Some("hmux_version_matched_client_read_only")
        );
    }

    #[test]
    fn external_snapshot_rejects_non_base64_terminal_bytes() {
        let error = project_external_snapshot(runtime::ExternalSnapshot {
            schema_version: 1,
            session_id: "session-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            terminal_epoch: "epoch-1".to_string(),
            sequence_through: "8".to_string(),
            rows: 24,
            columns: 80,
            data: "%%%".to_string(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
        })
        .unwrap_err();

        assert!(error.starts_with("hmux_external_cli_invalid"));
    }

    #[cfg(unix)]
    #[test]
    fn resurrection_inputs_must_be_private_real_files() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("recipes");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let recipe = directory.join("recipe.json");
        fs::write(&recipe, b"{}").unwrap();
        fs::set_permissions(&recipe, fs::Permissions::from_mode(0o600)).unwrap();

        assert!(private_resurrection_metadata(
            &fs::symlink_metadata(&directory).unwrap(),
            true
        ));
        assert!(private_resurrection_metadata(
            &fs::symlink_metadata(&recipe).unwrap(),
            false
        ));

        fs::set_permissions(&recipe, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!private_resurrection_metadata(
            &fs::symlink_metadata(&recipe).unwrap(),
            false
        ));
    }

    #[cfg(unix)]
    #[test]
    fn exact_safe_shell_recipe_ignores_corrupt_unrelated_recipe_files() {
        use hmux_client::StandaloneResurrectionReplayPolicy;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(".resurrection");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let recipe = StandaloneResurrectionRecipe::new(
            "safe-shell",
            temp.path(),
            vec!["/bin/sh".to_string()],
            24,
            80,
            1,
        )
        .unwrap()
        .with_resurrection_replay_policy(
            StandaloneResurrectionReplayPolicy::SafeInteractiveShell,
        )
        .unwrap();
        let mut digest = Sha256::new();
        digest.update(recipe.session_name().as_bytes());
        let digest = format!("{:x}", digest.finalize());
        let recipe_path = directory.join(format!("recipe_{}.json", &digest[..32]));
        fs::write(&recipe_path, serde_json::to_vec(&recipe).unwrap()).unwrap();
        fs::set_permissions(&recipe_path, fs::Permissions::from_mode(0o600)).unwrap();
        let corrupt = directory.join("corrupt-unrelated.json");
        fs::write(&corrupt, b"{not-json").unwrap();
        fs::set_permissions(&corrupt, fs::Permissions::from_mode(0o600)).unwrap();

        let verified = verified_resurrection_recipe(temp.path(), "safe-shell").unwrap();

        assert_eq!(verified.command(), ["/bin/sh"]);
        assert!(!verified.requires_operator_confirmation());
    }

    #[cfg(unix)]
    #[test]
    fn reused_source_pid_is_not_mistaken_for_the_original_generation() {
        let process_id = std::process::id();
        let reused = hmux_client::ProcessDescriptor {
            process_id,
            start_marker: format!("{process_id}-1"),
        };
        assert!(!process_generation_is_live(&reused));

        let unverifiable = hmux_client::ProcessDescriptor {
            process_id,
            start_marker: "unverifiable".into(),
        };
        assert!(process_generation_is_live(&unverifiable));
    }

    #[test]
    fn managed_recovery_requires_a_safe_cli_identity() {
        assert!(validate_cli_identity("conversation id", "safe:conversation-1").is_ok());
        assert!(validate_cli_identity("conversation id", "unsafe;touch /tmp/x").is_err());
    }

    #[test]
    fn legacy_adoption_builds_only_exact_claude_resume_commands() {
        let conversation_id = "ea790d0c-6e9b-4b65-aab1-cc93b09ca073";
        assert_eq!(
            exact_adoption_resume_command(
                "claude",
                conversation_id,
                PermissionMode::Default,
            )
            .unwrap(),
            format!("claude --resume {conversation_id}")
        );
        assert_eq!(
            exact_adoption_resume_command(
                "claude",
                conversation_id,
                PermissionMode::BypassApprovals,
            )
            .unwrap(),
            format!("claude --dangerously-skip-permissions --resume {conversation_id}")
        );
    }

    #[test]
    fn fresh_managed_recovery_is_a_distinct_seedless_journal_request() {
        let request = RecoveryExecutionRequest {
            recovery_id: "fresh_0123456789abcdef".into(),
            kind: RecoveryExecutionKind::ManagedProviderFresh,
            session_id: "source-session".into(),
            workspace_id: "workspace-1".into(),
            expected_source_fence: None,
            require_socket_owner_absent: false,
            expected_target_build_id: None,
            conversation_id: None,
            adapter_supports_explicit_resume: false,
            confirmed: true,
            managed_launch: Some(ManagedRecoveryLaunchRequest {
                provider_id: "codex".into(),
                permission_mode: PermissionMode::Default,
                credential_id: None,
                credential_directory: None,
                credential_generation: None,
                cwd: "/tmp".into(),
                rows: 30,
                columns: 120,
                terminal_environment: TerminalEnvironment::default(),
            }),
        };

        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["kind"], "managed_provider_fresh");
        assert!(encoded["conversationId"].is_null());
        assert!(encoded["managedLaunch"].get("command").is_none());
    }

    #[test]
    fn standalone_upgrade_refuses_implicit_provider_resume_before_rehost() {
        assert_eq!(
            ambiguous_provider_resume_recipe(&[
                "/bin/zsh".into(),
                "-lc".into(),
                "codex resume --last".into(),
            ]),
            Some("upgrade_resume_identity_ambiguous")
        );
        assert_eq!(
            ambiguous_provider_resume_recipe(&[
                "/bin/zsh".into(),
                "-lc".into(),
                "env -u NO_COLOR codex resume conversation-1".into(),
            ]),
            None
        );
        assert_eq!(
            ambiguous_provider_resume_recipe(&["/bin/zsh".into()]),
            None
        );
        assert_eq!(
            ambiguous_provider_resume_recipe(&["claude --continue".into()]),
            Some("upgrade_resume_identity_ambiguous")
        );
    }

    #[test]
    fn detects_hmux_attach_below_the_requested_legacy_session() {
        let processes = "\
63503     1 63503 /app/hebbian-session __serve term-1 --cwd /outer -- zsh -l
63504 63503 63504 zsh -l
55196 63504 63504 /usr/local/bin/hebbian session hmux attach hmux-codex
70000     1 70000 /app/hebbian-session __serve term-2 --cwd /other -- zsh -l
70001 70000 70001 /usr/local/bin/hmux attach unrelated
";

        assert_eq!(
            attached_hmux_target_from_processes("term-1", processes).as_deref(),
            Some("hmux-codex")
        );
        assert_eq!(
            attached_hmux_target_from_processes("term-2", processes).as_deref(),
            Some("unrelated")
        );
    }

    #[test]
    fn indexes_every_legacy_attach_target_from_one_process_table() {
        let processes = "\
63503     1 63503 /app/hebbian-session __serve term-1 --cwd /outer -- zsh -l
63504 63503 63504 zsh -l
55196 63504 63504 /usr/local/bin/hebbian session hmux attach hmux-codex
70000     1 70000 /app/hebbian-session __serve term-2 --cwd /other -- zsh -l
70001 70000 70001 /usr/local/bin/hmux attach unrelated
80000     1 80000 /app/hebbian-session __serve term-3 --cwd /plain -- zsh -l
90000     1 90000 /app/hebbian-session __serve alias __serve term-4 --cwd /nested -- zsh -l
90001 90000 90001 /usr/local/bin/hmux attach shared
";

        let records = process_records_for_test(processes);
        let targets = attached_hmux_targets_from_processes(&records);

        assert_eq!(
            targets.get("term-1").map(String::as_str),
            Some("hmux-codex")
        );
        assert_eq!(
            targets.get("term-2").map(String::as_str),
            Some("unrelated")
        );
        assert!(!targets.contains_key("term-3"));
        assert_eq!(targets.get("alias").map(String::as_str), Some("shared"));
        assert_eq!(targets.get("term-4").map(String::as_str), Some("shared"));
    }

    #[test]
    fn cold_poll_burst_builds_one_shared_attach_target_index() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        let processes = Arc::<str>::from(
            "\
63503     1 63503 /app/hebbian-session __serve term-1 --cwd /outer -- zsh -l
63504 63503 63504 /usr/local/bin/hmux attach first
70000     1 70000 /app/hebbian-session __serve term-2 --cwd /other -- zsh -l
70001 70000 70001 /usr/local/bin/hmux attach second
",
        );
        let cache = Arc::new(Mutex::new(LegacyAttachTargetCache::default()));
        let scans = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let threads = (0..8)
            .map(|index| {
                let processes = Arc::clone(&processes);
                let cache = Arc::clone(&cache);
                let scans = Arc::clone(&scans);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let session_id = if index % 2 == 0 {
                        "term-1"
                    } else {
                        "term-2"
                    };
                    barrier.wait();
                    cached_legacy_attached_hmux_target(session_id, &cache, || {
                        scans.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(50));
                        Some(ProcessSnapshot {
                            revision: 1,
                            processes: process_records_for_test(&processes),
                        })
                    })
                })
            })
            .collect::<Vec<_>>();

        let targets = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(scans.load(Ordering::SeqCst), 1);
        assert!(targets.iter().flatten().all(|target| matches!(
            target.as_str(),
            "first" | "second"
        )));
        assert!(targets.iter().flatten().next().is_some());
        assert_eq!(
            cached_legacy_attached_hmux_target("term-1", &cache, || {
                panic!("fresh index must serve the follow-up poll")
            }),
            Some("first".into())
        );
        assert_eq!(
            cached_legacy_attached_hmux_target("term-2", &cache, || {
                panic!("fresh index must serve the follow-up poll")
            }),
            Some("second".into())
        );
    }

    #[test]
    fn stale_target_is_returned_while_refresh_runs_without_the_cache_lock() {
        let cache = Arc::new(Mutex::new(LegacyAttachTargetCache {
            snapshot: Some(LegacyAttachTargetSnapshot {
                sampled_at: Instant::now() - LEGACY_ATTACH_TARGET_TTL - Duration::from_millis(1),
                targets: HashMap::from([("term-1".into(), "old".into())]),
            }),
            refresh_in_flight: false,
            last_refresh_failed_at: None,
        }));
        let (refresh_started_tx, refresh_started_rx) = std::sync::mpsc::channel();
        let (release_refresh_tx, release_refresh_rx) = std::sync::mpsc::channel();
        let refresh_cache = Arc::clone(&cache);
        let refresh = thread::spawn(move || {
            cached_legacy_attached_hmux_target("term-1", &refresh_cache, || {
                refresh_started_tx.send(()).unwrap();
                release_refresh_rx.recv().unwrap();
                Some(ProcessSnapshot {
                    revision: 2,
                    processes: process_records_for_test(
                        "\
10 1 10 /app/hebbian-session __serve term-1 -- zsh
11 10 11 /usr/local/bin/hmux attach new
",
                    ),
                })
            })
        });
        refresh_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (lookup_started_tx, lookup_started_rx) = std::sync::mpsc::channel();
        let (lookup_tx, lookup_rx) = std::sync::mpsc::channel();
        let lookup_cache = Arc::clone(&cache);
        let lookup = thread::spawn(move || {
            lookup_started_tx.send(()).unwrap();
            let target = cached_legacy_attached_hmux_target("term-1", &lookup_cache, || {
                panic!("in-flight refresh must coalesce")
            });
            lookup_tx.send(target).unwrap();
        });
        lookup_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_eq!(
            lookup_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Some("old".into())
        );
        lookup.join().unwrap();

        release_refresh_tx.send(()).unwrap();
        assert_eq!(refresh.join().unwrap(), Some("new".into()));
        let cache = cache.lock().unwrap();
        assert_eq!(
            cache
                .snapshot
                .as_ref()
                .unwrap()
                .targets
                .get("term-1")
                .map(String::as_str),
            Some("new")
        );
        assert!(!cache.refresh_in_flight);
    }

    #[test]
    fn failed_refresh_preserves_stale_target_and_clears_in_flight_state() {
        let cache = Mutex::new(LegacyAttachTargetCache {
            snapshot: Some(LegacyAttachTargetSnapshot {
                sampled_at: Instant::now() - LEGACY_ATTACH_TARGET_TTL - Duration::from_millis(1),
                targets: HashMap::from([("term-1".into(), "stable".into())]),
            }),
            refresh_in_flight: false,
            last_refresh_failed_at: None,
        });

        assert_eq!(
            cached_legacy_attached_hmux_target("term-1", &cache, || None),
            Some("stable".into())
        );
        assert_eq!(
            cached_legacy_attached_hmux_target("term-1", &cache, || {
                panic!("failed refresh must observe retry backoff")
            }),
            Some("stable".into())
        );
        let mut cache_state = cache.lock().unwrap();
        assert_eq!(
            cache_state
                .snapshot
                .as_ref()
                .unwrap()
                .targets
                .get("term-1")
                .map(String::as_str),
            Some("stable")
        );
        assert!(!cache_state.refresh_in_flight);
        assert!(cache_state.last_refresh_failed_at.is_some());
        cache_state.snapshot.as_mut().unwrap().sampled_at =
            Instant::now() - LEGACY_ATTACH_MAX_STALE - Duration::from_millis(1);
        drop(cache_state);
        assert_eq!(
            cached_legacy_attached_hmux_target("term-1", &cache, || {
                panic!("retry backoff remains active")
            }),
            None
        );
    }

    #[test]
    fn fresh_negative_lookup_is_cached_without_another_snapshot_request() {
        let cache = Mutex::new(LegacyAttachTargetCache::default());
        assert_eq!(
            cached_legacy_attached_hmux_target("term-1", &cache, || {
                Some(ProcessSnapshot {
                    revision: 3,
                    processes: process_records_for_test(
                        "10 1 10 /app/hebbian-session __serve term-1 -- zsh",
                    ),
                })
            }),
            None
        );
        assert_eq!(
            cached_legacy_attached_hmux_target("term-1", &cache, || {
                panic!("fresh negative lookup must not resample")
            }),
            None
        );
    }

    #[test]
    fn parses_tmux_compatible_attach_target_forms() {
        assert_eq!(
            hmux_attach_target("/usr/local/bin/hmux a -t dev").as_deref(),
            Some("dev")
        );
        assert_eq!(
            hmux_attach_target("hebbian session hmux attach --read-only main").as_deref(),
            Some("main")
        );
        assert_eq!(
            hmux_attach_target("hebbian session hmux at --target=review").as_deref(),
            Some("review")
        );
        assert_eq!(hmux_attach_target("hmux ls"), None);
    }
}
