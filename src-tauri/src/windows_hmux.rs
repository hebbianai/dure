use dure_app::provider_credential_environment_policy_v1;
use hmux_client::{
    inspect_local_sessions, inspect_local_sessions_exact_isolated, project_agent_identity,
    project_agent_runtime_state, project_provider_conversation_identity,
    project_working_directory_projection, AgentIdentityDescriptor,
    AgentIdentitySource, AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
    AgentRuntimeStateDescriptor, AgentRuntimeStateSource, ClientError, ConnectionInterrupt,
    ConnectionRecord, CreatedManagedSession, CreatedStandaloneSession, ExactDiscoveryWorker,
    ExactSessionProbeResult,
    FrameBody, LocalSessionCatalog, ManagedCreateChainStopReceipt, ManagedCreateChainStopReceiptV2,
    ManagedCreateOutcome, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ManagedSessionStopper, ManagedStopRequest, PermissionMode,
    ProviderConversationIdentityDescriptor, ProviderConversationIdentitySeed,
    ProviderConversationIdentitySource, ProviderStateEnvironment, RetryDirective, SessionClass,
    SessionDescriptor, SessionFence, SessionHealth, SessionInspection, SessionLifecycle,
    SessionRetirementPolicy, SessionRetirementReceipt, SessionRetirementReceiptReason,
    SessionRetirementReceiptState, SessionSelector,
    TerminalDefaultColors, TerminalEnvironment, TerminalSurfaceAccess,
    TerminalSurfaceAttachment,
    TerminalSurfaceDetachHandle, TerminalUpstreamHandles,
    MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION, MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError, Response};
use tauri::{Runtime, State};

use crate::hmux_input_contract::{
    project_command_input_receipt, send_fresh_agent_prompt, HmuxCommandInputReceipt,
    HmuxInitialAgentPromptReceipt, HmuxInputFailure,
};
use crate::managed_create_resolution::{
    project_checkout_advance, LegacyManagedCreateReceipt,
    ManagedCreateAdvanceCommandResolution,
};
use crate::structured_terminal_access::RequestedTerminalSurfaceAccess;
use crate::windows_managed_provider_launch::{
    apply_terminal_environment, prepare_windows_managed_provider_command,
    resolve_windows_command, windows_command_line,
};

const EXACT_DISCOVERY_WORKERS: usize = 4;
const EXACT_DISCOVERY_BUDGET: Duration = Duration::from_secs(4);
const LIST_DISCOVERY_BUDGET: Duration = Duration::from_secs(4);
const SURFACE_DETACH_TIMEOUT: Duration = Duration::from_secs(5);
const COMMAND_INPUT_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_VERSION_OUTPUT_LIMIT: usize = 8 * 1024;
const APP_STANDALONE_RETIREMENT_GRACE_MS: u64 = 2_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsSessionSummary {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_name: Option<String>,
    workspace_id: String,
    session_class: &'static str,
    lifecycle: &'static str,
    manifest_lifecycle: &'static str,
    health: &'static str,
    host_build_version: String,
    client_selection: &'static str,
    input_allowed: bool,
    detach_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<WindowsSessionDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<WindowsSessionFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_process_alive: Option<bool>,
    terminal_epoch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_fence: Option<WindowsManagedStopFence>,
    output_seq: String,
    capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retirement_policy: Option<WindowsRetirementPolicy>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsSessionDiagnostic {
    code: &'static str,
    message: &'static str,
    retry: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsSessionFailure {
    correlation_id: String,
    session_id: String,
    workspace_id: String,
    terminal_epoch: String,
    code: String,
    phase: String,
    summary: String,
    exit_kind: String,
    exit_code: Option<i32>,
    occurred_unix_ms: String,
    retry_posture: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WindowsManagedStopFence {
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsRetirementPolicy {
    kind: &'static str,
    grace_period_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WindowsExactSessionTarget {
    session_id: String,
    workspace_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum WindowsExactSessionInspectionResult {
    Found {
        session: Box<WindowsSessionSummary>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_runtime_state: Option<WindowsAgentRuntimeState>,
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

#[derive(Clone, Copy)]
enum ProjectedHealth {
    Healthy,
    StaleTransport,
    IncompatibleProtocol,
    Exited,
    GenerationChanged,
    Unprobed,
}

fn project_inspection(inspection: SessionInspection) -> WindowsSessionSummary {
    let health = match inspection.health {
        SessionHealth::Healthy => ProjectedHealth::Healthy,
        SessionHealth::StaleTransport => ProjectedHealth::StaleTransport,
        SessionHealth::IncompatibleProtocol => ProjectedHealth::IncompatibleProtocol,
        SessionHealth::Exited => ProjectedHealth::Exited,
        SessionHealth::GenerationChanged => ProjectedHealth::GenerationChanged,
        SessionHealth::Unprobed => ProjectedHealth::Unprobed,
    };
    project_descriptor(inspection.descriptor, health)
}

fn project_descriptor(
    descriptor: SessionDescriptor,
    health: ProjectedHealth,
) -> WindowsSessionSummary {
    let manifest_lifecycle = match descriptor.lifecycle {
        SessionLifecycle::Ready => "ready",
        SessionLifecycle::Exited => "exited",
    };
    let (lifecycle, health, input_allowed, detach_only, diagnostic) = match health {
        ProjectedHealth::Healthy => ("ready", "current_healthy", true, false, None),
        ProjectedHealth::StaleTransport => (
            "unavailable",
            "stale_transport",
            false,
            true,
            Some(WindowsSessionDiagnostic {
                code: "hmux_stale_transport",
                message: "The manifest is ready but the bounded Hmux handshake failed.",
                retry: "detach_only",
            }),
        ),
        ProjectedHealth::IncompatibleProtocol => (
            "unavailable",
            "incompatible_protocol",
            false,
            true,
            Some(WindowsSessionDiagnostic {
                code: "hmux_incompatible_protocol",
                message: "The live Hmux Host rejected the direct client protocol.",
                retry: "version_matched_client_required",
            }),
        ),
        ProjectedHealth::Exited => ("exited", "exited", false, true, None),
        ProjectedHealth::GenerationChanged => (
            "unavailable",
            "generation_changed",
            false,
            true,
            Some(WindowsSessionDiagnostic {
                code: "hmux_session_generation_changed",
                message: "The session generation changed while its health was being verified.",
                retry: "refresh_session_census",
            }),
        ),
        ProjectedHealth::Unprobed => (
            "unavailable",
            "unprobed",
            false,
            true,
            Some(WindowsSessionDiagnostic {
                code: "hmux_health_unprobed",
                message: "The session was not probed before the bounded census deadline.",
                retry: "refresh_session_census",
            }),
        ),
    };
    let stop_fence =
        (descriptor.session_class == SessionClass::Managed).then(|| WindowsManagedStopFence {
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.clone(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        });
    WindowsSessionSummary {
        session_id: descriptor.session_id,
        session_name: descriptor.session_name,
        workspace_id: descriptor.workspace_id,
        session_class: match descriptor.session_class {
            SessionClass::Managed => "managed",
            SessionClass::Standalone => "standalone",
        },
        lifecycle,
        manifest_lifecycle,
        health,
        host_build_version: descriptor.host_build_version,
        client_selection: "direct_rust",
        input_allowed,
        detach_only,
        diagnostic,
        failure: descriptor.failure.map(|failure| WindowsSessionFailure {
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
        runtime_host: descriptor.runtime_host,
        host_process_alive: None,
        terminal_epoch: descriptor.terminal_epoch,
        stop_fence,
        output_seq: descriptor.output_seq,
        capabilities: descriptor.capabilities,
        retirement_policy: descriptor
            .retirement_policy
            .map(|policy| WindowsRetirementPolicy {
                kind: "after_graceful_last_client_departure_v1",
                grace_period_ms: policy.grace_period_ms(),
            }),
    }
}

fn project_windows_managed_create(
    created: CreatedManagedSession,
    cwd: Option<PathBuf>,
    credential_id: Option<String>,
    credential_generation: Option<u64>,
    initial_prompt_accepted: bool,
) -> Result<WindowsManagedCreateSummary, String> {
    let idempotency_key = created.receipt().idempotency_key().to_string();
    let descriptor = created.session().descriptor().clone();
    if descriptor.session_class != SessionClass::Managed {
        return Err("Windows Hmux runtime returned a standalone session".to_string());
    }
    Ok(WindowsManagedCreateSummary {
        session: project_descriptor(descriptor, ProjectedHealth::Healthy),
        idempotency_key,
        cwd: cwd.map(|path| path.to_string_lossy().into_owned()),
        credential_id,
        credential_generation,
        outcome: match created.receipt().outcome() {
            ManagedCreateOutcome::Created => "created",
            ManagedCreateOutcome::Reused => "reused",
        },
        initial_prompt_accepted,
    })
}

fn exact_selector_identity(selector: SessionSelector) -> (String, String) {
    (
        selector.session_id,
        selector
            .workspace_id
            .expect("validated exact selector has a workspace id"),
    )
}

fn project_exact(result: ExactSessionProbeResult) -> WindowsExactSessionInspectionResult {
    match result {
        ExactSessionProbeResult::Inspection(inspection) => {
            let agent_runtime_state = inspection
                .agent_runtime_state
                .clone()
                .map(project_agent_runtime_record);
            WindowsExactSessionInspectionResult::Found {
                session: Box::new(project_inspection(*inspection)),
                agent_runtime_state,
            }
        }
        ExactSessionProbeResult::NotFound(selector) => {
            let (session_id, workspace_id) = exact_selector_identity(selector);
            WindowsExactSessionInspectionResult::NotFound {
                session_id,
                workspace_id,
            }
        }
        ExactSessionProbeResult::LookupFailed {
            selector,
            error_code,
        } => {
            let (session_id, workspace_id) = exact_selector_identity(selector);
            WindowsExactSessionInspectionResult::LookupFailed {
                session_id,
                workspace_id,
                error_code: error_code.to_string(),
            }
        }
        ExactSessionProbeResult::Unprobed(selector) => {
            let (session_id, workspace_id) = exact_selector_identity(selector);
            WindowsExactSessionInspectionResult::Unprobed {
                session_id,
                workspace_id,
            }
        }
    }
}

pub(crate) use crate::standalone_create_request::AppStandaloneCreateRequest as WindowsStandaloneCreateRequest;

type WindowsManagedCreatePayload = crate::managed_create_resolution::ManagedCreateCommandPayload;

struct PreparedWindowsManagedCreate {
    request: ManagedCreateRequest,
    replace_current: bool,
    cwd: PathBuf,
    credential_id: Option<String>,
    credential_generation: Option<u64>,
    initial_prompt_accepted: bool,
}

fn prepare_windows_managed_create(
    request: WindowsManagedCreatePayload,
) -> Result<PreparedWindowsManagedCreate, String> {
    let WindowsManagedCreatePayload {
        replace_current,
        idempotency_key,
        session_id,
        workspace_id,
        provider_id,
        conversation_id,
        permission_mode,
        credential_id,
        credential_directory,
        credential_generation,
        cwd,
        command,
        initial_prompt,
        rows,
        columns,
        terminal_env,
        terminal_default_colors,
    } = request;
    let (credential_id, credential_generation) = if replace_current {
        // Windows has no credential-overlay consumer yet. An old credential
        // projection must not reject exact Resume before Hmux can attempt the
        // replacement; the current provider-default profile is launchable.
        (None, None)
    } else {
        reject_unimplemented_credential_overlay(
            credential_id.as_deref(),
            credential_directory.as_deref(),
            credential_generation,
        )?;
        (credential_id, credential_generation)
    };
    if command.trim().is_empty() {
        return Err("managed provider command must not be empty".to_string());
    }
    let cwd = if replace_current && conversation_id.is_some() {
        crate::working_directory::resolve_exact_resume_cwd(&cwd)
            .map_err(|error| format!("resolve managed Hmux cwd failed: {error}"))?
    } else {
        canonical_directory(&cwd, "managed Hmux cwd")?
    };
    let terminal_environment = TerminalEnvironment::new(terminal_env.unwrap_or_default())
        .map_err(|error| error.to_string())?;
    let (provider_command, initial_prompt_accepted) = prepare_windows_managed_provider_command(
        &provider_id,
        permission_mode,
        conversation_id.as_deref(),
        &command,
        initial_prompt.as_deref(),
        &cwd,
        &terminal_environment,
    )?;
    let mut create = ManagedCreateRequest::new(
        &idempotency_key,
        session_id,
        workspace_id,
        &provider_id,
        permission_mode,
        &cwd,
        provider_command,
        rows,
        columns,
    )
    .and_then(|create| {
        create.with_required_managed_stop_request_version(
            MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
        )
    })
    .and_then(|create| create.with_terminal_environment(terminal_environment))
    .and_then(|create| create.with_terminal_default_colors(terminal_default_colors))
    .map_err(|error| error.to_string())?;
    create = with_default_provider_state_environment(create)?;
    if let Some(conversation_id) = conversation_id.as_deref() {
        let identity = ProviderConversationIdentitySeed::new(&provider_id, conversation_id)
            .map_err(|error| error.to_string())?;
        create = create
            .with_conversation_identity(identity)
            .map_err(|error| error.to_string())?;
    }
    Ok(PreparedWindowsManagedCreate {
        request: create,
        replace_current,
        cwd,
        credential_id,
        credential_generation,
        initial_prompt_accepted,
    })
}

pub(crate) struct WindowsManagedCreateCommand(WindowsManagedCreatePayload);

impl<'de, R: Runtime> CommandArg<'de, R> for WindowsManagedCreateCommand {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        deserialize_flat_command(command).map(Self)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowsManagedShellCreatePayload {
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
    cwd: String,
    rows: u16,
    columns: u16,
    terminal_env: Option<BTreeMap<String, Option<String>>>,
    terminal_default_colors: TerminalDefaultColors,
}

pub(crate) struct WindowsManagedShellCreateCommand(WindowsManagedShellCreatePayload);

impl<'de, R: Runtime> CommandArg<'de, R> for WindowsManagedShellCreateCommand {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        deserialize_flat_command(command).map(Self)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsManagedCreateSummary {
    session: WindowsSessionSummary,
    idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_generation: Option<u64>,
    outcome: &'static str,
    initial_prompt_accepted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsStructuredTerminalAttachReceipt {
    terminal_epoch: String,
    through_output_seq: String,
    state_revision: String,
    initial_delivery_record_count: usize,
    selected_capabilities: Vec<String>,
    session: WindowsSessionSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsStructuredAttachFailure {
    code: String,
    message: String,
    retry_directive: RetryDirective,
}

impl WindowsStructuredAttachFailure {
    fn adapter(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry_directive: RetryDirective::Never,
        }
    }

    fn client(error: ClientError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
            retry_directive: error.retry_directive(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsPaneDepartureReceipt {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy: Option<WindowsRetirementPolicy>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsPaneAttachmentStatus {
    owner_id: String,
    session_id: String,
    workspace_id: String,
    state: &'static str,
    observer_attached: bool,
    controller_attached: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WindowsCommandInputRequest {
    session_id: String,
    workspace_id: String,
    expected_fence: Option<WindowsManagedStopFence>,
    text: String,
    submit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WindowsInitialAgentPromptRequest {
    session_id: String,
    workspace_id: String,
    expected_fence: WindowsManagedStopFence,
    prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsProviderPreflight {
    provider: String,
    command: String,
    ready: bool,
    status: &'static str,
    message: String,
    shell: String,
    cwd: String,
    environment_source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_path: Option<String>,
    symlink_chain: Vec<String>,
    executable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    version_timeout_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    inherited_no_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effective_no_color: Option<String>,
    recovery_requires_user_approval: bool,
    suggested_recovery: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AdapterRecord<'a> {
    Control {
        body: &'a FrameBody,
    },
    AgentIdentity {
        identity: WindowsAgentIdentity,
    },
    AgentRuntimeState {
        state: WindowsAgentRuntimeState,
    },
    WorkingDirectory {
        /// Explicit rename: the container's `rename_all` renames variants, not
        /// struct-variant fields.
        #[serde(rename = "workingDirectory")]
        working_directory: WindowsWorkingDirectory,
    },
    ProviderConversationIdentity {
        identity: WindowsProviderConversationIdentity,
    },
    Closed {
        code: &'a str,
        message: String,
        #[serde(rename = "retryDirective")]
        retry_directive: RetryDirective,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsAgentIdentity {
    terminal_epoch: String,
    observed_through_output_seq: String,
    agent: Option<&'static str>,
    source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsWorkingDirectory {
    terminal_epoch: String,
    observed_through_output_seq: String,
    path: String,
    source: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsAgentRuntimeState {
    terminal_epoch: String,
    revision: String,
    observed_through_output_seq: String,
    lifecycle: &'static str,
    activity: &'static str,
    attention: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    attention_id: Option<String>,
    source: &'static str,
    turn_completed_count: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsProviderConversationIdentity {
    session_id: String,
    workspace_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
    revision: String,
    observed_through_output_seq: String,
    provider_id: String,
    conversation_id: String,
    source: &'static str,
}

fn project_agent_identity_record(identity: AgentIdentityDescriptor) -> WindowsAgentIdentity {
    WindowsAgentIdentity {
        terminal_epoch: identity.terminal_epoch,
        observed_through_output_seq: identity.observed_through_output_seq,
        agent: identity.agent.map(|agent| agent.as_str()),
        source: match identity.source {
            AgentIdentitySource::ProcessInspection => "process_inspection",
        },
    }
}

fn project_working_directory_record(
    working_directory: hmux_client::WorkingDirectoryDescriptor,
) -> WindowsWorkingDirectory {
    WindowsWorkingDirectory {
        terminal_epoch: working_directory.terminal_epoch,
        observed_through_output_seq: working_directory.observed_through_output_seq,
        path: working_directory.path,
        source: match working_directory.source {
            hmux_client::WorkingDirectorySource::LaunchFallback => "launch_fallback",
            hmux_client::WorkingDirectorySource::Osc7 => "osc7",
            hmux_client::WorkingDirectorySource::ProcessInspection => "process_inspection",
        },
    }
}

fn project_agent_runtime_record(state: AgentRuntimeStateDescriptor) -> WindowsAgentRuntimeState {
    WindowsAgentRuntimeState {
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

fn project_conversation_record(
    identity: ProviderConversationIdentityDescriptor,
) -> WindowsProviderConversationIdentity {
    WindowsProviderConversationIdentity {
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

fn encode_json(record: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_json::to_vec(record)
        .map_err(|error| format!("encode Windows structured terminal record failed: {error}"))
}

fn encode_control(body: &FrameBody) -> Result<(Vec<u8>, bool), String> {
    let record = match body {
        FrameBody::AgentIdentity(identity) => AdapterRecord::AgentIdentity {
            identity: project_agent_identity_record(project_agent_identity(identity.clone())),
        },
        FrameBody::AgentRuntimeState(state) => AdapterRecord::AgentRuntimeState {
            state: project_agent_runtime_record(
                project_agent_runtime_state(state.clone())
                    .map_err(|error| format!("{}: {error}", error.code()))?,
            ),
        },
        FrameBody::WorkingDirectory(projection) => AdapterRecord::WorkingDirectory {
            working_directory: project_working_directory_record(
                project_working_directory_projection(projection.clone()),
            ),
        },
        FrameBody::ProviderConversationIdentity(identity) => {
            AdapterRecord::ProviderConversationIdentity {
                identity: project_conversation_record(project_provider_conversation_identity(
                    identity.clone(),
                )),
            }
        }
        body => AdapterRecord::Control { body },
    };
    Ok((
        encode_json(&record)?,
        matches!(body, FrameBody::Exit(_) | FrameBody::Error(_)),
    ))
}

fn encode_closed(error: &ClientError) -> Vec<u8> {
    serde_json::to_vec(&AdapterRecord::Closed {
        code: error.code(),
        message: error.to_string(),
        retry_directive: error.retry_directive(),
    })
    .unwrap_or_else(|_| {
        br#"{"kind":"closed","code":"hmux_adapter_encoding_failed","retryDirective":"never"}"#
            .to_vec()
    })
}

struct SurfacePullState {
    initial_records: VecDeque<Vec<u8>>,
    surface: Option<TerminalSurfaceAttachment>,
}

struct WindowsSurface {
    webview_instance_id: String,
    surface_id: String,
    session: SessionDescriptor,
    pull: Mutex<SurfacePullState>,
    upstream: TerminalUpstreamHandles,
    departure: TerminalSurfaceDetachHandle,
    interrupt: ConnectionInterrupt,
    active_pull: AtomicBool,
    stopping: AtomicBool,
    ended: AtomicBool,
}

struct PullLease<'a>(&'a AtomicBool);

impl Drop for PullLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl WindowsSurface {
    fn enter_pull(&self) -> Result<PullLease<'_>, String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("hmux_structured_pull_retired: attachment is retired".to_string());
        }
        self.active_pull
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                "hmux_structured_pull_concurrent: one record request is already active".to_string()
            })?;
        if self.stopping.load(Ordering::Acquire) {
            self.active_pull.store(false, Ordering::Release);
            return Err("hmux_structured_pull_retired: attachment is retired".to_string());
        }
        Ok(PullLease(&self.active_pull))
    }

    fn next_record(&self) -> Result<Vec<u8>, String> {
        let _lease = self.enter_pull()?;
        if self.ended.load(Ordering::Acquire) {
            return Err("hmux_structured_pull_ended: terminal stream ended".to_string());
        }
        let mut pull = self
            .pull
            .lock()
            .map_err(|_| "Windows Hmux structured terminal pull state poisoned".to_string())?;
        if let Some(record) = pull.initial_records.pop_front() {
            return Ok(record);
        }
        let surface = pull.surface.as_mut().ok_or_else(|| {
            "hmux_structured_pull_retired: terminal surface is detached".to_string()
        })?;
        match surface.read_delivery_record() {
            Ok(ConnectionRecord::TerminalState(record)) => Ok(record),
            Ok(ConnectionRecord::Control(body)) => {
                let (record, terminal) = encode_control(body.as_ref())?;
                if terminal {
                    self.ended.store(true, Ordering::Release);
                }
                Ok(record)
            }
            Err(_) if self.stopping.load(Ordering::Acquire) => {
                Err("hmux_structured_pull_retired: attachment is retired".to_string())
            }
            Err(error) => {
                self.ended.store(true, Ordering::Release);
                Ok(encode_closed(&error))
            }
        }
    }

    fn stop_confirmed(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        let departure = self
            .departure
            .begin_detach()
            .map(|_| ())
            .map_err(|error| format!("{}: {error}", error.code()));
        if departure.is_err() {
            self.interrupt.interrupt();
        }
        let mut pull = self
            .pull
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let detached = pull
            .surface
            .take()
            .map(|surface| {
                if departure.is_ok() {
                    surface.detach_confirmed(SURFACE_DETACH_TIMEOUT)
                } else {
                    surface.detach()
                }
                .map_err(|error| format!("{}: {error}", error.code()))
            })
            .transpose();
        pull.initial_records.clear();
        departure?;
        detached.map(|_| ())
    }
}

pub(crate) struct WindowsHmuxState {
    runtime_override: Option<PathBuf>,
    discovery_override: Option<PathBuf>,
    operations: Mutex<()>,
    surfaces: Mutex<HashMap<String, Arc<WindowsSurface>>>,
    pending_standalone: Mutex<HashMap<String, CreatedStandaloneSession>>,
}

impl Default for WindowsHmuxState {
    fn default() -> Self {
        Self {
            runtime_override: None,
            discovery_override: None,
            operations: Mutex::new(()),
            surfaces: Mutex::new(HashMap::new()),
            pending_standalone: Mutex::new(HashMap::new()),
        }
    }
}

impl WindowsHmuxState {
    #[cfg(test)]
    fn with_paths(runtime: PathBuf, discovery_root: PathBuf) -> Self {
        Self {
            runtime_override: Some(runtime),
            discovery_override: Some(discovery_root),
            ..Self::default()
        }
    }

    pub(crate) fn runtime(&self) -> Result<PathBuf, String> {
        if let Some(runtime) = self.runtime_override.as_ref() {
            return validate_runtime(runtime, "test runtime override");
        }
        for variable in [
            "HMUX_RUNTIME",
            "HEBBIAN_HMUX_RUNTIME",
            "DURE_HMUX_RUNTIME_BIN",
        ] {
            if let Some(value) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
                return validate_runtime(&PathBuf::from(value), variable);
            }
        }
        let current_executable = std::env::current_exe()
            .map_err(|error| format!("resolve current Windows executable failed: {error}"))?;
        let executable_directory = current_executable
            .parent()
            .ok_or_else(|| "current Windows executable has no containing directory".to_string())?;
        let candidates = [
            executable_directory.join("hmux-runtime.exe"),
            executable_directory.join("hmux-runtime-x86_64-pc-windows-msvc.exe"),
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries/hmux-runtime-x86_64-pc-windows-msvc.exe"),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return candidate.canonicalize().map_err(|error| {
                    format!("resolve bundled Windows Hmux runtime failed: {error}")
                });
            }
        }
        Err("hmux_windows_runtime_unavailable: bundled hmux-runtime.exe was not found".to_string())
    }

    fn catalog(&self) -> Result<LocalSessionCatalog, String> {
        match self.discovery_override.as_ref() {
            Some(root) => Ok(LocalSessionCatalog::new(root)),
            None => LocalSessionCatalog::from_environment().map_err(client_message),
        }
    }

    fn list_sessions(&self) -> Result<Vec<WindowsSessionSummary>, String> {
        let catalog = self.catalog()?;
        let descriptors = catalog.list().map_err(client_message)?;
        Ok(inspect_local_sessions(
            &catalog,
            descriptors,
            EXACT_DISCOVERY_WORKERS,
            LIST_DISCOVERY_BUDGET,
        )
        .into_iter()
        .map(project_inspection)
        .collect())
    }

    fn inspect_sessions_exact(
        &self,
        targets: Vec<WindowsExactSessionTarget>,
    ) -> Result<Vec<WindowsExactSessionInspectionResult>, String> {
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
        let catalog = self.catalog()?;
        let worker = ExactDiscoveryWorker::new(self.runtime()?);
        inspect_local_sessions_exact_isolated(
            &catalog,
            &worker,
            selectors,
            EXACT_DISCOVERY_WORKERS,
            EXACT_DISCOVERY_BUDGET,
        )
        .map(|results| results.into_iter().map(project_exact).collect())
        .map_err(|error| error.to_string())
    }

    fn create_standalone(
        &self,
        request: WindowsStandaloneCreateRequest,
    ) -> Result<WindowsSessionSummary, String> {
        let command = match request.command_line.as_deref().map(str::trim) {
            Some("") => return Err("standalone command line must be non-empty".to_string()),
            Some(command) => windows_command_line(command),
            None => Vec::new(),
        };
        let (operation, create) = request.prepare(command)?;
        let create = create.with_retirement_policy(
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: APP_STANDALONE_RETIREMENT_GRACE_MS,
            },
        ).map_err(|error| error.to_string())?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        let catalog = self.catalog()?;
        let created = crate::session_checkout::create_standalone(
            self.runtime()?, Some(catalog.discovery_root().to_path_buf()), operation, create,
        )?;
        let descriptor = created.session().descriptor().clone();
        if descriptor.session_class != SessionClass::Standalone {
            return Err("Windows Hmux runtime returned a managed session".to_string());
        }
        self.pending_standalone
            .lock()
            .map_err(|_| "Windows Hmux pending create registry poisoned".to_string())?
            .insert(descriptor.session_id.clone(), created);
        Ok(project_descriptor(descriptor, ProjectedHealth::Healthy))
    }

    fn create_managed(
        &self,
        request: WindowsManagedCreatePayload,
    ) -> Result<WindowsManagedCreateSummary, String> {
        let prepared = prepare_windows_managed_create(request)?;
        if prepared.replace_current {
            return Err("replace-current intent requires managed create advance".to_string());
        }
        self.create_managed_request(
            prepared.request,
            prepared.cwd,
            prepared.credential_id,
            prepared.credential_generation,
            prepared.initial_prompt_accepted,
        )
    }

    fn advance_managed_create(
        &self,
        request: WindowsManagedCreatePayload,
    ) -> Result<ManagedCreateAdvanceCommandResolution<WindowsManagedCreateSummary>, String> {
        let prepared = prepare_windows_managed_create(request)?;
        self.advance_managed_create_request(
            prepared.request,
            prepared.replace_current,
            prepared.cwd,
            prepared.credential_id,
            prepared.credential_generation,
            prepared.initial_prompt_accepted,
        )
    }

    fn create_managed_shell(
        &self,
        request: WindowsManagedShellCreatePayload,
    ) -> Result<WindowsManagedCreateSummary, String> {
        let WindowsManagedShellCreatePayload {
            idempotency_key,
            session_id,
            workspace_id,
            cwd,
            rows,
            columns,
            terminal_env,
            terminal_default_colors,
        } = request;
        let cwd = canonical_directory(&cwd, "managed Hmux shell cwd")?;
        let terminal_environment = TerminalEnvironment::new(terminal_env.unwrap_or_default())
            .map_err(|error| error.to_string())?;
        let create = ManagedCreateRequest::new(
            &idempotency_key,
            session_id,
            workspace_id,
            "local-shell",
            PermissionMode::Default,
            &cwd,
            Vec::new(),
            rows,
            columns,
        )
        .and_then(|create| {
            // The managed shell carries no provider-conversation authority;
            // its complete generation fence remains the lifecycle contract.
            create.with_required_managed_stop_request_version(
                MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
        })
        .and_then(|create| create.with_terminal_environment(terminal_environment))
        .and_then(|create| create.with_terminal_default_colors(terminal_default_colors))
        .map_err(|error| error.to_string())?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        let created = crate::session_checkout::create(
            self.runtime()?,
            Some(self.catalog()?.discovery_root().to_path_buf()),
            create,
        )?;
        project_windows_managed_create(created, Some(cwd), None, None, false)
    }

    fn create_managed_request(
        &self,
        request: ManagedCreateRequest,
        cwd: PathBuf,
        credential_id: Option<String>,
        credential_generation: Option<u64>,
        initial_prompt_accepted: bool,
    ) -> Result<WindowsManagedCreateSummary, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        let catalog = self.catalog()?;
        let created = crate::session_checkout::create(
            self.runtime()?,
            Some(catalog.discovery_root().to_path_buf()),
            request,
        )?;
        project_windows_managed_create(
            created,
            Some(cwd),
            credential_id,
            credential_generation,
            initial_prompt_accepted,
        )
    }

    fn advance_managed_create_request(
        &self,
        request: ManagedCreateRequest,
        replace_current: bool,
        cwd: PathBuf,
        credential_id: Option<String>,
        credential_generation: Option<u64>,
        initial_prompt_accepted: bool,
    ) -> Result<ManagedCreateAdvanceCommandResolution<WindowsManagedCreateSummary>, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        let catalog = self.catalog()?;
        let runtime = self.runtime()?;
        let resolution = project_checkout_advance(crate::session_checkout::advance(
            runtime,
            Some(catalog.discovery_root().to_path_buf()),
            request,
            replace_current,
            false,
            |_| {},
        ))?;
        match resolution {
            ManagedCreateAdvanceCommandResolution::Current { receipt: created } => {
                Ok(ManagedCreateAdvanceCommandResolution::Current {
                    receipt: project_windows_managed_create(
                        created,
                        Some(cwd),
                        credential_id,
                        credential_generation,
                        initial_prompt_accepted,
                    )?,
                })
            }
            ManagedCreateAdvanceCommandResolution::Advanced { receipt: created } => {
                Ok(ManagedCreateAdvanceCommandResolution::Advanced {
                    receipt: project_windows_managed_create(
                        created,
                        Some(cwd),
                        credential_id,
                        credential_generation,
                        initial_prompt_accepted,
                    )?,
                })
            }
            ManagedCreateAdvanceCommandResolution::RetrySame {
                reason,
                code,
                message,
            } => Ok(ManagedCreateAdvanceCommandResolution::RetrySame {
                reason,
                code,
                message,
            }),
            ManagedCreateAdvanceCommandResolution::Rejected { code, message } => {
                Ok(ManagedCreateAdvanceCommandResolution::Rejected { code, message })
            }
        }
    }

    fn attach_structured_terminal(
        &self,
        observer_id: String,
        webview_instance_id: String,
        surface_id: String,
        session_id: String,
        workspace_id: Option<String>,
        access: TerminalSurfaceAccess,
    ) -> Result<WindowsStructuredTerminalAttachReceipt, WindowsStructuredAttachFailure> {
        validate_identifier("observer id", &observer_id).map_err(|error| {
            WindowsStructuredAttachFailure::adapter("hmux_structured_attach_invalid", error)
        })?;
        validate_identifier("webview instance id", &webview_instance_id).map_err(|error| {
            WindowsStructuredAttachFailure::adapter("hmux_structured_attach_invalid", error)
        })?;
        validate_identifier("surface id", &surface_id).map_err(|error| {
            WindowsStructuredAttachFailure::adapter("hmux_structured_attach_invalid", error)
        })?;
        validate_identifier("session id", &session_id).map_err(|error| {
            WindowsStructuredAttachFailure::adapter("hmux_structured_attach_invalid", error)
        })?;
        if let Some(workspace_id) = workspace_id.as_deref() {
            validate_identifier("workspace id", workspace_id).map_err(|error| {
                WindowsStructuredAttachFailure::adapter("hmux_structured_attach_invalid", error)
            })?;
        }
        let _operation = self.operations.lock().map_err(|_| {
            WindowsStructuredAttachFailure::adapter(
                "hmux_structured_registry_failed",
                "Windows Hmux operation lock poisoned",
            )
        })?;
        {
            let surfaces = self.surfaces.lock().map_err(|_| {
                WindowsStructuredAttachFailure::adapter(
                    "hmux_structured_registry_failed",
                    "Windows Hmux structured terminal registry poisoned",
                )
            })?;
            if surfaces.contains_key(&observer_id)
                || surfaces
                    .values()
                    .any(|surface| surface.surface_id == surface_id)
            {
                return Err(WindowsStructuredAttachFailure::adapter(
                    "hmux_structured_attach_conflict",
                    "observer or surface is already attached",
                ));
            }
        }
        let pending_session = self
            .pending_standalone
            .lock()
            .map_err(|_| {
                WindowsStructuredAttachFailure::adapter(
                    "hmux_structured_registry_failed",
                    "Windows Hmux pending create registry poisoned",
                )
            })?
            .get(&session_id)
            .filter(|created| {
                workspace_id.as_deref().is_none_or(|workspace_id| {
                    created.session().descriptor().workspace_id.as_str() == workspace_id
                })
            })
            .map(|created| created.session().clone());
        let session = match pending_session {
            Some(session) => session,
            None => {
                let catalog = self.catalog().map_err(|error| {
                    WindowsStructuredAttachFailure::adapter("hmux_catalog_failed", error)
                })?;
                let selector = SessionSelector::new(session_id, workspace_id);
                let discovered = catalog
                    .open(&selector)
                    .map_err(WindowsStructuredAttachFailure::client)?;
                match discovered.descriptor().session_class {
                    SessionClass::Standalone => Ok(discovered),
                    SessionClass::Managed => catalog.open_current_managed(&selector),
                }
                .map_err(WindowsStructuredAttachFailure::client)?
            }
        };
        let descriptor = session.descriptor().clone();
        let connection = session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                access,
                None,
            ))
            .map_err(WindowsStructuredAttachFailure::client)?;
        let surface = TerminalSurfaceAttachment::from_connection(connection)
            .map_err(WindowsStructuredAttachFailure::client)?;
        let frame = surface.current_frame().clone();
        let selected_capabilities = surface.selected_capabilities().to_vec();
        let mut initial_records = VecDeque::new();
        if let Some(identity) = surface.initial_agent_identity().cloned() {
            initial_records.push_back(
                encode_json(&AdapterRecord::AgentIdentity {
                    identity: project_agent_identity_record(identity),
                })
                .map_err(|error| {
                    WindowsStructuredAttachFailure::adapter(
                        "hmux_structured_record_encoding_failed",
                        error,
                    )
                })?,
            );
        }
        if let Some(state) = surface.initial_agent_runtime_state().cloned() {
            initial_records.push_back(
                encode_json(&AdapterRecord::AgentRuntimeState {
                    state: project_agent_runtime_record(state),
                })
                .map_err(|error| {
                    WindowsStructuredAttachFailure::adapter(
                        "hmux_structured_record_encoding_failed",
                        error,
                    )
                })?,
            );
        }
        if let Some(working_directory) = surface.initial_working_directory().cloned() {
            initial_records.push_back(
                encode_json(&AdapterRecord::WorkingDirectory {
                    working_directory: project_working_directory_record(working_directory),
                })
                .map_err(|error| {
                    WindowsStructuredAttachFailure::adapter(
                        "hmux_structured_record_encoding_failed",
                        error,
                    )
                })?,
            );
        }
        if let Some(identity) = surface.initial_provider_conversation_identity().cloned() {
            initial_records.push_back(
                encode_json(&AdapterRecord::ProviderConversationIdentity {
                    identity: project_conversation_record(identity),
                })
                .map_err(|error| {
                    WindowsStructuredAttachFailure::adapter(
                        "hmux_structured_record_encoding_failed",
                        error,
                    )
                })?,
            );
        }
        initial_records.extend(surface.initial_delivery_records().iter().cloned());
        let initial_delivery_record_count = initial_records.len();
        let attached = Arc::new(WindowsSurface {
            webview_instance_id,
            surface_id,
            session: descriptor.clone(),
            upstream: surface.upstream_handles(),
            departure: surface.detach_handle(),
            interrupt: surface
                .interrupt_handle()
                .map_err(WindowsStructuredAttachFailure::client)?,
            pull: Mutex::new(SurfacePullState {
                initial_records,
                surface: Some(surface),
            }),
            active_pull: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            ended: AtomicBool::new(false),
        });
        let mut surfaces = self.surfaces.lock().map_err(|_| {
            WindowsStructuredAttachFailure::adapter(
                "hmux_structured_registry_failed",
                "Windows Hmux structured terminal registry poisoned",
            )
        })?;
        if surfaces.contains_key(&observer_id)
            || surfaces
                .values()
                .any(|surface| surface.surface_id == attached.surface_id)
        {
            drop(surfaces);
            let _ = attached.stop_confirmed();
            return Err(WindowsStructuredAttachFailure::adapter(
                "hmux_structured_attach_conflict",
                "observer or surface was attached concurrently",
            ));
        }
        surfaces.insert(observer_id, attached);
        self.pending_standalone
            .lock()
            .map_err(|_| {
                WindowsStructuredAttachFailure::adapter(
                    "hmux_structured_registry_failed",
                    "Windows Hmux pending create registry poisoned",
                )
            })?
            .remove(&descriptor.session_id);
        Ok(WindowsStructuredTerminalAttachReceipt {
            terminal_epoch: frame.terminal_epoch().to_string(),
            through_output_seq: frame.through_output_seq().to_string(),
            state_revision: frame.state_revision().to_string(),
            initial_delivery_record_count,
            selected_capabilities,
            session: project_descriptor(descriptor, ProjectedHealth::Healthy),
        })
    }

    fn next_structured_terminal_record(
        &self,
        observer_id: &str,
        webview_instance_id: &str,
    ) -> Result<Vec<u8>, String> {
        validate_identifier("observer id", observer_id)?;
        validate_identifier("webview instance id", webview_instance_id)?;
        let surface = self.surface(observer_id)?;
        if surface.webview_instance_id != webview_instance_id {
            return Err(
                "hmux_structured_pull_retired: attachment belongs to another WebView generation"
                    .to_string(),
            );
        }
        surface.next_record()
    }

    fn structured_terminal_upstream(
        &self,
        observer_id: &str,
        record: Vec<u8>,
    ) -> Result<String, String> {
        validate_identifier("observer id", observer_id)?;
        let surface = self.surface(observer_id)?;
        if surface.stopping.load(Ordering::Acquire) || surface.ended.load(Ordering::Acquire) {
            return Err("hmux_structured_upstream_retired: attachment is retired".to_string());
        }
        surface
            .upstream
            .send_envelope(&record)
            .map(|record_id| record_id.to_string())
            .map_err(client_message)
    }

    fn detach_structured_terminal(&self, observer_id: &str) -> Result<(), String> {
        validate_identifier("observer id", observer_id)?;
        let surface = self
            .surfaces
            .lock()
            .map_err(|_| "Windows Hmux structured terminal registry poisoned".to_string())?
            .remove(observer_id);
        match surface {
            Some(surface) => surface.stop_confirmed(),
            None => Ok(()),
        }
    }

    fn surface(&self, observer_id: &str) -> Result<Arc<WindowsSurface>, String> {
        self.surfaces
            .lock()
            .map_err(|_| "Windows Hmux structured terminal registry poisoned".to_string())?
            .get(observer_id)
            .cloned()
            .ok_or_else(|| "hmux_structured_pull_retired: attachment is not registered".to_string())
    }

    fn abandon_unpresented_creation(
        &self,
        session_id: String,
        workspace_id: String,
    ) -> Result<WindowsPaneDepartureReceipt, String> {
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        let created = self
            .pending_standalone
            .lock()
            .map_err(|_| "Windows Hmux pending create registry poisoned".to_string())?
            .remove(&session_id);
        let Some(created) = created else {
            return Ok(preserved_departure("creation_authority_unavailable", None));
        };
        if created.session().descriptor().workspace_id != workspace_id {
            self.pending_standalone
                .lock()
                .map_err(|_| "Windows Hmux pending create registry poisoned".to_string())?
                .insert(session_id, created);
            return Ok(preserved_departure("generation_changed", None));
        }
        let policy = created.session().descriptor().retirement_policy;
        Ok(match created.abandon_unpresented_creation() {
            Ok(receipt) => project_departure(receipt, policy),
            Err(error) => preserved_departure(error.code(), policy),
        })
    }

    fn pane_attachment_status(
        &self,
        owner_id: String,
        session_id: String,
        workspace_id: String,
    ) -> Result<WindowsPaneAttachmentStatus, String> {
        validate_identifier("pane owner id", &owner_id)?;
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        let observer_attached = self
            .surfaces
            .lock()
            .map_err(|_| "Windows Hmux structured terminal registry poisoned".to_string())?
            .values()
            .any(|surface| {
                surface_matches_pane(surface, &owner_id, &session_id, &workspace_id)
                    && !surface.stopping.load(Ordering::Acquire)
                    && !surface.ended.load(Ordering::Acquire)
            });
        Ok(WindowsPaneAttachmentStatus {
            owner_id,
            session_id,
            workspace_id,
            state: if observer_attached {
                "attached"
            } else {
                "detached"
            },
            observer_attached,
            controller_attached: false,
        })
    }

    fn depart_pane_gracefully(
        &self,
        owner_id: String,
        session_id: String,
        workspace_id: String,
    ) -> Result<WindowsPaneDepartureReceipt, String> {
        validate_identifier("pane owner id", &owner_id)?;
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        let attached = {
            let mut surfaces = self
                .surfaces
                .lock()
                .map_err(|_| "Windows Hmux structured terminal registry poisoned".to_string())?;
            let observer_id = surfaces.iter().find_map(|(observer_id, surface)| {
                surface_matches_pane(surface, &owner_id, &session_id, &workspace_id)
                    .then(|| observer_id.clone())
            });
            observer_id.and_then(|observer_id| surfaces.remove(&observer_id))
        };
        let Some(attached) = attached else {
            return Ok(preserved_departure("not_attached", None));
        };
        let attached_generation = attached.session.clone();
        if attached.stop_confirmed().is_err() {
            return Ok(preserved_departure(
                "observer_detach_ack_unavailable",
                attached_generation.retirement_policy,
            ));
        }
        let catalog = self.catalog()?;
        let selector = SessionSelector::new(session_id, Some(workspace_id));
        let session = match catalog.open(&selector) {
            Ok(session) => session,
            Err(error) if error.is_session_absent() => {
                return Ok(preserved_departure("session_absent", None));
            }
            Err(error) => {
                return Ok(preserved_departure(
                    error.code(),
                    attached_generation.retirement_policy,
                ));
            }
        };
        let policy = session.descriptor().retirement_policy;
        if !attached_generation.same_generation(session.descriptor()) {
            return Ok(preserved_departure("generation_changed", policy));
        }
        Ok(match session.depart_gracefully() {
            Ok(receipt) => project_departure(receipt, policy),
            Err(error) => preserved_departure(error.code(), policy),
        })
    }

    fn command_input(
        &self,
        request: WindowsCommandInputRequest,
    ) -> Result<HmuxCommandInputReceipt, HmuxInputFailure> {
        let mut surface = self.command_input_writer(
            &request.session_id,
            &request.workspace_id,
            request.expected_fence.as_ref(),
        )?;
        let receipt = surface
            .send_command_input_confirmed(request.text, request.submit, COMMAND_INPUT_TIMEOUT)
            .map_err(HmuxInputFailure::from_command_input)?;
        let projected = project_command_input_receipt(&receipt);
        let _ = surface.detach();
        Ok(projected)
    }

    fn initial_agent_prompt(
        &self,
        request: WindowsInitialAgentPromptRequest,
    ) -> Result<HmuxInitialAgentPromptReceipt, HmuxInputFailure> {
        let (catalog, selector) = self.input_target(&request.session_id, &request.workspace_id)?;
        let provider_id = catalog
            .find(&selector)
            .map_err(HmuxInputFailure::from_client)?
            .provider_id;
        let fence = windows_input_fence(
            &request.session_id,
            &request.workspace_id,
            &request.expected_fence,
        )?;
        let mut surface = TerminalSurfaceAttachment::connect_local_agent_prompt(&catalog, &fence)
            .map_err(HmuxInputFailure::from_client)?;
        let projected = send_fresh_agent_prompt(
            &mut surface,
            &provider_id,
            request.prompt,
            COMMAND_INPUT_TIMEOUT,
        )?;
        let _ = surface.detach();
        Ok(projected)
    }

    fn command_input_writer(
        &self,
        session_id: &str,
        workspace_id: &str,
        expected_fence: Option<&WindowsManagedStopFence>,
    ) -> Result<TerminalSurfaceAttachment, HmuxInputFailure> {
        let (catalog, selector) = self.input_target(session_id, workspace_id)?;
        let descriptor = catalog
            .find(&selector)
            .map_err(HmuxInputFailure::from_client)?;
        let session = match descriptor.session_class {
            SessionClass::Managed => {
                let expected = expected_fence.ok_or_else(|| {
                    HmuxInputFailure::not_written(
                        "hmux_expected_generation_required",
                        "managed command input requires a complete generation fence",
                    )
                })?;
                let fence = windows_input_fence(session_id, workspace_id, expected)?;
                catalog
                    .open_current_managed_for_mutation(&selector, &fence)
                    .map_err(HmuxInputFailure::from_client)?
            }
            SessionClass::Standalone => {
                if expected_fence.is_some() {
                    return Err(HmuxInputFailure::not_written(
                        "hmux_command_input_fence_invalid",
                        "standalone command input must not carry a managed fence",
                    ));
                }
                catalog
                    .open(&selector)
                    .map_err(HmuxInputFailure::from_client)?
            }
        };
        let connection = session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::Writer,
                None,
            ))
            .map_err(HmuxInputFailure::from_client)?;
        TerminalSurfaceAttachment::from_connection(connection)
            .map_err(HmuxInputFailure::from_client)
    }

    fn input_target(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<(LocalSessionCatalog, SessionSelector), HmuxInputFailure> {
        validate_identifier("session id", session_id).map_err(|message| {
            HmuxInputFailure::not_written("hmux_command_input_invalid", message)
        })?;
        validate_identifier("workspace id", workspace_id).map_err(|message| {
            HmuxInputFailure::not_written("hmux_command_input_invalid", message)
        })?;
        let catalog = self.catalog().map_err(|message| {
            HmuxInputFailure::not_written("hmux_catalog_failed", message)
        })?;
        Ok((
            catalog,
            SessionSelector::new(session_id, Some(workspace_id.to_string())),
        ))
    }

    fn terminate_standalone(&self, session_id: &str, workspace_id: &str) -> Result<(), String> {
        validate_identifier("session id", session_id)?;
        validate_identifier("workspace id", workspace_id)?;
        let catalog = self.catalog()?;
        let session = match catalog.open(&SessionSelector::new(
            session_id,
            Some(workspace_id.to_string()),
        )) {
            Ok(session) => session,
            Err(error) if error.is_session_absent() => return Ok(()),
            Err(error) => return Err(client_message(error)),
        };
        session
            .terminate_standalone(&catalog, Duration::from_secs(5))
            .map_err(client_message)
    }

    fn terminate_exact(
        &self,
        session_id: &str,
        workspace_id: &str,
        terminal_epoch: &str,
        session_class: SessionClass,
    ) -> Result<crate::hmux_exact_termination::ExactSessionTerminationReceipt, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        let catalog = self.catalog()?;
        crate::hmux_exact_termination::terminate_exact_session(
            &catalog,
            session_id,
            workspace_id,
            terminal_epoch,
            session_class,
            Duration::from_secs(5),
            |descriptor, stop_id| {
                let receipt = self.stop_managed_locked(
                    stop_id,
                    descriptor.session_id.clone(),
                    descriptor.workspace_id.clone(),
                    WindowsManagedStopFence {
                        runner_principal: descriptor.runner_principal.clone(),
                        runner_instance: descriptor.runner_instance.clone(),
                        channel_epoch: descriptor.channel_epoch.clone(),
                        host_instance_id: descriptor.host_instance_id.clone(),
                        terminal_epoch: descriptor.terminal_epoch.clone(),
                    },
                )?;
                Ok(receipt.outcome())
            },
        )
    }

    fn stop_managed(
        &self,
        stop_id: String,
        session_id: String,
        workspace_id: String,
        expected_fence: WindowsManagedStopFence,
    ) -> Result<hmux_client::ManagedStopReceipt, String> {
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        self.stop_managed_locked(stop_id, session_id, workspace_id, expected_fence)
    }

    fn stop_managed_locked(
        &self,
        stop_id: String,
        session_id: String,
        workspace_id: String,
        expected_fence: WindowsManagedStopFence,
    ) -> Result<hmux_client::ManagedStopReceipt, String> {
        validate_identifier("managed stop id", &stop_id)?;
        validate_identifier("session id", &session_id)?;
        validate_identifier("workspace id", &workspace_id)?;
        validate_stop_fence(&expected_fence)?;
        let channel_epoch = expected_fence
            .channel_epoch
            .parse::<u64>()
            .map_err(|_| "managed stop channel epoch is invalid".to_string())?;
        let runtime = self.runtime()?;
        let working_directory = runtime
            .parent()
            .ok_or_else(|| "Windows Hmux runtime has no containing directory".to_string())?;
        let catalog = self.catalog()?;
        let request = ManagedStopRequest::new(stop_id, session_id, workspace_id)
            .and_then(|request| {
                request.with_expected_fence(
                    expected_fence.runner_principal,
                    expected_fence.runner_instance,
                    channel_epoch,
                    expected_fence.host_instance_id,
                    expected_fence.terminal_epoch,
                )
            })
            .map_err(|error| error.to_string())?;
        ManagedSessionStopper::new(&runtime, working_directory)
            .with_discovery_root(catalog.discovery_root())
            .stop(request)
            .map_err(client_message)
    }

    fn stop_managed_create_chain(
        &self,
        idempotency_key: String,
        session_id: String,
        workspace_id: String,
    ) -> Result<ManagedCreateChainStopReceipt, String> {
        let root = ManagedCreateReconcileRequest::new(
            idempotency_key,
            session_id,
            workspace_id,
        )
        .map_err(|error| error.to_string())?;
        let runtime = self.runtime()?;
        let catalog = self.catalog()?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        crate::session_checkout::close_legacy(
            runtime,
            Some(catalog.discovery_root().to_path_buf()),
            root,
        )
    }

    fn stop_managed_create_chain_v2(
        &self,
        idempotency_key: String,
        session_id: String,
        workspace_id: String,
    ) -> Result<ManagedCreateChainStopReceiptV2, String> {
        let root = ManagedCreateReconcileRequest::new(
            idempotency_key,
            session_id,
            workspace_id,
        )
        .map_err(|error| error.to_string())?;
        let runtime = self.runtime()?;
        let catalog = self.catalog()?;
        let _operation = self
            .operations
            .lock()
            .map_err(|_| "Windows Hmux operation lock poisoned".to_string())?;
        crate::session_checkout::close(
            runtime,
            Some(catalog.discovery_root().to_path_buf()),
            root,
        )
    }
}

fn deserialize_flat_command<T, R>(command: CommandItem<'_, R>) -> Result<T, InvokeError>
where
    T: serde::de::DeserializeOwned,
    R: Runtime,
{
    match command.message.payload() {
        InvokeBody::Json(value) => {
            serde_json::from_value(value.clone()).map_err(InvokeError::from_error)
        }
        InvokeBody::Raw(_) => Err(InvokeError::from(
            "Windows Hmux command requires a JSON payload".to_string(),
        )),
    }
}

fn surface_matches_pane(
    surface: &WindowsSurface,
    owner_id: &str,
    session_id: &str,
    workspace_id: &str,
) -> bool {
    let owner_matches = surface.surface_id == owner_id
        || surface.surface_id.strip_suffix("-view") == Some(owner_id);
    owner_matches
        && surface.session.session_id == session_id
        && surface.session.workspace_id == workspace_id
}

fn project_retirement_policy(policy: SessionRetirementPolicy) -> WindowsRetirementPolicy {
    match policy {
        SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 { grace_period_ms } => {
            WindowsRetirementPolicy {
                kind: "after_graceful_last_client_departure_v1",
                grace_period_ms,
            }
        }
    }
}

fn preserved_departure(
    reason: impl Into<String>,
    policy: Option<SessionRetirementPolicy>,
) -> WindowsPaneDepartureReceipt {
    WindowsPaneDepartureReceipt {
        state: "session_preserved",
        reason: Some(reason.into()),
        policy: policy.map(project_retirement_policy),
    }
}

fn project_departure(
    receipt: SessionRetirementReceipt,
    fallback_policy: Option<SessionRetirementPolicy>,
) -> WindowsPaneDepartureReceipt {
    WindowsPaneDepartureReceipt {
        state: match receipt.state {
            SessionRetirementReceiptState::PolicyUpdated => "policy_updated",
            SessionRetirementReceiptState::RetirementArmed => "retirement_armed",
            SessionRetirementReceiptState::Eligible => "eligible",
            SessionRetirementReceiptState::SessionPreserved => "session_preserved",
            SessionRetirementReceiptState::Refused => "refused",
        },
        reason: receipt
            .reason
            .map(project_retirement_reason)
            .map(str::to_string),
        policy: receipt
            .policy
            .or(fallback_policy)
            .map(project_retirement_policy),
    }
}

fn project_retirement_reason(reason: SessionRetirementReceiptReason) -> &'static str {
    match reason {
        SessionRetirementReceiptReason::PolicyNotConfigured => "policy_not_configured",
        SessionRetirementReceiptReason::OtherClientsAttached => "other_clients_attached",
        SessionRetirementReceiptReason::ProviderBusy => "provider_busy",
        SessionRetirementReceiptReason::ProviderIdentityChanged => "provider_identity_changed",
        SessionRetirementReceiptReason::ProcessObservationUnavailable => {
            "process_observation_unavailable"
        }
        SessionRetirementReceiptReason::PersistenceUnavailable => "persistence_unavailable",
        SessionRetirementReceiptReason::SessionExited => "session_exited",
        SessionRetirementReceiptReason::GenerationChanged => "generation_changed",
        SessionRetirementReceiptReason::HostExiting => "host_exiting",
        SessionRetirementReceiptReason::ManagedSession => "managed_session",
        SessionRetirementReceiptReason::UnsupportedAction => "unsupported_action",
    }
}

fn run_provider_preflight(
    provider: String,
    command: String,
    cwd: String,
    terminal_env: Option<BTreeMap<String, Option<String>>>,
) -> Result<WindowsProviderPreflight, String> {
    validate_provider_token("provider id", &provider)?;
    validate_provider_token("provider command", &command)?;
    let cwd = canonical_directory(&cwd, "provider preflight cwd")?;
    let terminal_environment = TerminalEnvironment::new(terminal_env.unwrap_or_default())
        .map_err(|error| error.to_string())?;
    let shell = std::env::var_os("COMSPEC")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    let inherited_no_color = std::env::var("NO_COLOR").ok();
    let effective_no_color = terminal_environment
        .values()
        .get("NO_COLOR")
        .cloned()
        .unwrap_or_else(|| inherited_no_color.clone());
    let path = std::env::var("PATH").ok();
    let mut result = WindowsProviderPreflight {
        provider: provider.clone(),
        command: command.clone(),
        ready: false,
        status: "not_found",
        message: format!("{command} was not found in the Windows process PATH"),
        shell: shell.to_string_lossy().into_owned(),
        cwd: cwd.to_string_lossy().into_owned(),
        environment_source: "login_shell",
        path,
        command_path: None,
        resolved_path: None,
        symlink_chain: Vec::new(),
        executable: false,
        version: None,
        version_timeout_ms: PROVIDER_VERSION_TIMEOUT.as_millis() as u64,
        inherited_no_color,
        effective_no_color,
        recovery_requires_user_approval: true,
        suggested_recovery: vec![
            "Install the provider CLI for this Windows user or add it to PATH, then retry."
                .to_string(),
        ],
    };
    let resolved_command = match resolve_windows_command(&command, &cwd, &terminal_environment) {
        Ok(Some(resolved)) => resolved,
        Ok(None) => return Ok(result),
        Err(crate::provider_preflight::CommandFailure::Timeout) => {
            result.status = "environment_timeout";
            result.message = "Windows provider PATH lookup timed out".to_string();
            return Ok(result);
        }
        Err(crate::provider_preflight::CommandFailure::Failed(message)) => {
            result.status = "environment_failed";
            result.message = message;
            return Ok(result);
        }
    };
    result.command_path = Some(
        resolved_command
            .command_path
            .to_string_lossy()
            .into_owned(),
    );
    result.resolved_path = Some(
        resolved_command
            .resolved_path
            .to_string_lossy()
            .into_owned(),
    );
    result.executable = true;

    let mut version = provider_version_command(&resolved_command.resolved_path, &shell);
    version.current_dir(&cwd);
    apply_terminal_environment(&mut version, &terminal_environment);
    match crate::provider_preflight::run_command(
        &mut version,
        PROVIDER_VERSION_TIMEOUT,
        PROVIDER_VERSION_OUTPUT_LIMIT,
    ) {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("version reported without text")
                .to_string();
            result.ready = true;
            result.status = "ready";
            result.message = format!("{provider} provider is ready");
            result.version = Some(version);
            result.recovery_requires_user_approval = false;
            result.suggested_recovery.clear();
        }
        Ok(output) => {
            result.status = "version_failed";
            result.message = format!(
                "{} --version exited with code {}",
                resolved_command.resolved_path.display(),
                output.status.code().unwrap_or(-1)
            );
            result.suggested_recovery = vec![
                "Inspect or reinstall the reported executable only after user approval."
                    .to_string(),
            ];
        }
        Err(crate::provider_preflight::CommandFailure::Timeout) => {
            result.status = "version_timeout";
            result.message = format!(
                "{} --version exceeded the {} ms timeout",
                resolved_command.resolved_path.display(),
                PROVIDER_VERSION_TIMEOUT.as_millis()
            );
            result.suggested_recovery = vec![
                "Run the reported executable's --version command manually and inspect why it blocks."
                    .to_string(),
            ];
        }
        Err(crate::provider_preflight::CommandFailure::Failed(message)) => {
            result.status = "version_failed";
            result.message = message;
            result.suggested_recovery = vec![
                "Inspect or reinstall the reported executable only after user approval."
                    .to_string(),
            ];
        }
    }
    Ok(result)
}

fn provider_version_command(executable: &Path, shell: &Path) -> Command {
    let extension = executable
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
        let mut command = Command::new(shell);
        command
            .arg("/D")
            .arg("/Q")
            .arg("/C")
            .arg(executable)
            .arg("--version");
        command
    } else {
        let mut command = Command::new(executable);
        command.arg("--version");
        command
    }
}

#[tauri::command]
pub(crate) async fn provider_preflight(
    provider: String,
    command: String,
    cwd: String,
    terminal_env: Option<BTreeMap<String, Option<String>>>,
) -> Result<WindowsProviderPreflight, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_provider_preflight(provider, command, cwd, terminal_env)
    })
    .await
    .map_err(|error| format!("Windows provider preflight task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_list_sessions(
    state: State<'_, Arc<WindowsHmuxState>>,
) -> Result<Vec<WindowsSessionSummary>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.list_sessions())
        .await
        .map_err(|error| format!("list Windows Hmux sessions task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_inspect_sessions_exact(
    state: State<'_, Arc<WindowsHmuxState>>,
    targets: Vec<WindowsExactSessionTarget>,
) -> Result<Vec<WindowsExactSessionInspectionResult>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.inspect_sessions_exact(targets))
        .await
        .map_err(|error| format!("inspect exact Windows Hmux sessions task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_standalone_create(
    state: State<'_, Arc<WindowsHmuxState>>,
    request: WindowsStandaloneCreateRequest,
) -> Result<WindowsSessionSummary, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.create_standalone(request))
        .await
        .map_err(|error| format!("create standalone Windows Hmux session task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_standalone_abandon_unpresented(
    state: State<'_, Arc<WindowsHmuxState>>,
    session_id: String,
    workspace_id: String,
) -> Result<WindowsPaneDepartureReceipt, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.abandon_unpresented_creation(session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("abandon standalone Windows Hmux session task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_pane_depart_gracefully(
    state: State<'_, Arc<WindowsHmuxState>>,
    owner_id: String,
    session_id: String,
    workspace_id: String,
) -> Result<WindowsPaneDepartureReceipt, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.depart_pane_gracefully(owner_id, session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("depart Windows Hmux pane task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_pane_attachment_status(
    state: State<'_, Arc<WindowsHmuxState>>,
    owner_id: String,
    session_id: String,
    workspace_id: String,
) -> Result<WindowsPaneAttachmentStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.pane_attachment_status(owner_id, session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("inspect Windows Hmux pane attachment task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_managed_create(
    state: State<'_, Arc<WindowsHmuxState>>,
    payload: WindowsManagedCreateCommand,
) -> Result<LegacyManagedCreateReceipt<WindowsManagedCreateSummary>, String> {
    let state = Arc::clone(state.inner());
    let receipt = tauri::async_runtime::spawn_blocking(move || state.create_managed(payload.0))
        .await
        .map_err(|error| format!("create managed Windows Hmux session task failed: {error}"))??;
    Ok(LegacyManagedCreateReceipt::new(receipt))
}

#[tauri::command]
pub(crate) async fn hmux_managed_create_advance_v1(
    state: State<'_, Arc<WindowsHmuxState>>,
    request: WindowsManagedCreatePayload,
    broker_timing: Option<bool>,
) -> Result<ManagedCreateAdvanceCommandResolution<WindowsManagedCreateSummary>, String> {
    if broker_timing == Some(true) {
        return Ok(ManagedCreateAdvanceCommandResolution::Rejected {
            code: "managed_broker_timing_unavailable".into(),
            message: "Managed broker timing is unavailable on Windows".into(),
        });
    }
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.advance_managed_create(request))
        .await
        .map_err(|error| format!("create managed Windows Hmux session task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_managed_shell_create(
    state: State<'_, Arc<WindowsHmuxState>>,
    payload: WindowsManagedShellCreateCommand,
) -> Result<WindowsManagedCreateSummary, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.create_managed_shell(payload.0))
        .await
        .map_err(|error| format!("create managed Windows Hmux shell task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_structured_terminal_attach(
    state: State<'_, Arc<WindowsHmuxState>>,
    observer_id: String,
    webview_instance_id: String,
    surface_id: String,
    session_id: String,
    workspace_id: Option<String>,
    access: RequestedTerminalSurfaceAccess,
) -> Result<WindowsStructuredTerminalAttachReceipt, WindowsStructuredAttachFailure> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.attach_structured_terminal(
            observer_id,
            webview_instance_id,
            surface_id,
            session_id,
            workspace_id,
            access.into(),
        )
    })
    .await
    .map_err(|error| {
        WindowsStructuredAttachFailure::adapter(
            "hmux_structured_attach_task_failed",
            format!("attach Windows structured terminal task failed: {error}"),
        )
    })?
}

#[tauri::command]
pub(crate) async fn hmux_structured_terminal_next(
    state: State<'_, Arc<WindowsHmuxState>>,
    observer_id: String,
    webview_instance_id: String,
) -> Result<Response, String> {
    let state = Arc::clone(state.inner());
    let record = tauri::async_runtime::spawn_blocking(move || {
        state.next_structured_terminal_record(&observer_id, &webview_instance_id)
    })
    .await
    .map_err(|error| format!("read Windows structured terminal task failed: {error}"))??;
    Ok(Response::new(record))
}

#[tauri::command]
pub(crate) async fn hmux_structured_terminal_detach(
    state: State<'_, Arc<WindowsHmuxState>>,
    observer_id: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.detach_structured_terminal(&observer_id))
        .await
        .map_err(|error| format!("detach Windows structured terminal task failed: {error}"))?
}

#[tauri::command]
pub(crate) fn hmux_structured_terminal_upstream(
    state: State<'_, Arc<WindowsHmuxState>>,
    observer_id: String,
    record: Vec<u8>,
) -> Result<String, String> {
    state.structured_terminal_upstream(&observer_id, record)
}

#[tauri::command]
pub(crate) async fn hmux_command_input(
    state: State<'_, Arc<WindowsHmuxState>>,
    request: WindowsCommandInputRequest,
) -> Result<HmuxCommandInputReceipt, HmuxInputFailure> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.command_input(request))
        .await
        .map_err(|error| {
            HmuxInputFailure::unknown("hmux_command_input_task_failed", error.to_string())
        })?
}

#[tauri::command]
pub(crate) async fn hmux_initial_agent_prompt(
    state: State<'_, Arc<WindowsHmuxState>>,
    request: WindowsInitialAgentPromptRequest,
) -> Result<HmuxInitialAgentPromptReceipt, HmuxInputFailure> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.initial_agent_prompt(request))
        .await
        .map_err(|error| {
            HmuxInputFailure::unknown(
                "hmux_initial_agent_prompt_task_failed",
                error.to_string(),
            )
        })?
}

#[tauri::command]
pub(crate) async fn hmux_standalone_terminate(
    state: State<'_, Arc<WindowsHmuxState>>,
    session_id: String,
    workspace_id: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.terminate_standalone(&session_id, &workspace_id)
    })
    .await
    .map_err(|error| format!("terminate standalone Windows Hmux task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_session_terminate_exact(
    state: State<'_, Arc<WindowsHmuxState>>,
    session_id: String,
    workspace_id: String,
    terminal_epoch: String,
    session_class: SessionClass,
) -> Result<crate::hmux_exact_termination::ExactSessionTerminationReceipt, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.terminate_exact(&session_id, &workspace_id, &terminal_epoch, session_class)
    })
    .await
    .map_err(|error| format!("terminate exact Windows Hmux task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_managed_stop(
    state: State<'_, Arc<WindowsHmuxState>>,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    expected_fence: WindowsManagedStopFence,
) -> Result<hmux_client::ManagedStopReceipt, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.stop_managed(stop_id, session_id, workspace_id, expected_fence)
    })
    .await
    .map_err(|error| format!("stop managed Windows Hmux task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_managed_create_chain_stop_v1(
    state: State<'_, Arc<WindowsHmuxState>>,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
) -> Result<ManagedCreateChainStopReceipt, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.stop_managed_create_chain(idempotency_key, session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("stop managed Windows Hmux create chain task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_managed_create_chain_stop_v2(
    state: State<'_, Arc<WindowsHmuxState>>,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
) -> Result<ManagedCreateChainStopReceiptV2, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.stop_managed_create_chain_v2(idempotency_key, session_id, workspace_id)
    })
    .await
    .map_err(|error| format!("stop managed Windows Hmux create chain task failed: {error}"))?
}

fn validate_runtime(path: &Path, source: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err(format!(
            "hmux_windows_runtime_invalid: {source} must name an absolute runtime executable"
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("resolve Windows Hmux runtime failed: {error}"))
}

fn canonical_directory(path: &str, label: &str) -> Result<PathBuf, String> {
    let path =
        std::fs::canonicalize(path).map_err(|error| format!("resolve {label} failed: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{label} must be a directory"));
    }
    Ok(path)
}

fn reject_unimplemented_credential_overlay(
    credential_id: Option<&str>,
    credential_directory: Option<&str>,
    credential_generation: Option<u64>,
) -> Result<(), String> {
    if credential_id.is_some() || credential_directory.is_some() || credential_generation.is_some()
    {
        return Err(
            "windows_credential_overlay_unsupported: native Windows credential profiles are not implemented"
                .to_string(),
        );
    }
    Ok(())
}

fn with_default_provider_state_environment(
    request: ManagedCreateRequest,
) -> Result<ManagedCreateRequest, String> {
    let Some(policy) = provider_credential_environment_policy_v1(request.provider_id()) else {
        return Ok(request);
    };
    let environment = ProviderStateEnvironment::from_mutations(
        BTreeMap::new(),
        policy
            .state_roots()
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
    )
    .map_err(|error| error.to_string())?;
    request
        .with_provider_state_environment(environment)
        .map_err(|error| error.to_string())
}

fn validate_stop_fence(fence: &WindowsManagedStopFence) -> Result<(), String> {
    validate_identifier("managed stop runner principal", &fence.runner_principal)?;
    validate_identifier("managed stop runner instance", &fence.runner_instance)?;
    validate_identifier("managed stop channel epoch", &fence.channel_epoch)?;
    validate_identifier("managed stop Host instance id", &fence.host_instance_id)?;
    validate_identifier("managed stop terminal epoch", &fence.terminal_epoch)
}

fn windows_input_fence(
    session_id: &str,
    workspace_id: &str,
    fence: &WindowsManagedStopFence,
) -> Result<SessionFence, HmuxInputFailure> {
    validate_stop_fence(fence).map_err(|message| {
        HmuxInputFailure::not_written("hmux_expected_generation_invalid", message)
    })?;
    let channel_epoch = fence.channel_epoch.parse::<u64>().map_err(|_| {
        HmuxInputFailure::not_written(
            "hmux_expected_generation_invalid",
            "managed input channel epoch is invalid",
        )
    })?;
    Ok(SessionFence {
        workspace_id: workspace_id.to_string(),
        session_id: session_id.to_string(),
        runner_principal: fence.runner_principal.clone(),
        runner_instance: fence.runner_instance.clone(),
        channel_epoch,
        host_instance_id: fence.host_instance_id.clone(),
        terminal_epoch: fence.terminal_epoch.clone(),
    })
}

fn validate_provider_token(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 512
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-' | b'/' | b'@')
        })
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn client_message(error: ClientError) -> String {
    format!("{}: {error}", error.code())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;
    use terminal_state_protocol::{
        decode_record, encode_record_for_minor, input_intent, input_receipt, resize_receipt,
        terminal_state_record, InputIntent, ResizeInputIntent, TerminalStateRecord,
        TextInputIntent, ENVELOPE_MAGIC,
    };

    #[test]
    fn managed_create_projects_default_provider_state_authority() {
        for (provider_id, state_roots) in [
            ("codex", &["CODEX_HOME", "CODEX_SQLITE_HOME"][..]),
            ("claude", &["CLAUDE_CONFIG_DIR", "ANTHROPIC_CONFIG_DIR"][..]),
            ("kimi", &["KIMI_CODE_HOME"][..]),
        ] {
            let request = ManagedCreateRequest::new(
                "windows-default-profile",
                "session-default-profile",
                "workspace-default-profile",
                provider_id,
                PermissionMode::Default,
                r"C:\work",
                vec![provider_id.to_string()],
                24,
                80,
            )
            .unwrap();
            let request = with_default_provider_state_environment(request).unwrap();

            assert!(request.provider_state_environment().values().is_empty());
            assert_eq!(
                request.provider_state_environment().removals().len(),
                state_roots.len()
            );
            let serialized = serde_json::to_value(&request).unwrap();
            let mutations = serialized["providerStateEnvironment"].as_object().unwrap();
            assert_eq!(mutations.len(), state_roots.len());
            for state_root in state_roots {
                assert_eq!(mutations.get(*state_root), Some(&serde_json::Value::Null));
            }
        }

        let unknown = ManagedCreateRequest::new(
            "windows-unknown-profile",
            "session-unknown-profile",
            "workspace-unknown-profile",
            "custom-provider",
            PermissionMode::Default,
            r"C:\work",
            vec!["custom-provider".to_string()],
            24,
            80,
        )
        .unwrap();
        let unknown = with_default_provider_state_environment(unknown).unwrap();
        assert!(unknown.provider_state_environment().is_empty());
        assert!(serde_json::to_value(unknown).unwrap()["providerStateEnvironment"].is_null());
    }

    #[test]
    fn exact_absent_replay_waits_for_an_in_flight_create() {
        let fixture = tempfile::tempdir().unwrap();
        let state = Arc::new(WindowsHmuxState::with_paths(
            fixture.path().join("unused-runtime.exe"),
            fixture.path().join("discovery"),
        ));
        let create_operation = state.operations.lock().unwrap();
        let state_for_termination = Arc::clone(&state);
        let (started_sender, started_receiver) = mpsc::sync_channel(1);
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        let termination = std::thread::spawn(move || {
            started_sender.send(()).unwrap();
            let result = state_for_termination.terminate_exact(
                "session-during-create",
                "workspace-during-create",
                "terminal-during-create",
                SessionClass::Standalone,
            );
            result_sender.send(result).unwrap();
        });

        started_receiver.recv().unwrap();
        assert_eq!(
            result_receiver.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        drop(create_operation);

        let receipt = result_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt.outcome,
            crate::hmux_exact_termination::ExactSessionTerminationOutcome::AlreadyExited
        );
        termination.join().unwrap();
    }

    struct NativeSessionCleanup {
        state: Arc<WindowsHmuxState>,
        observer_ids: Vec<String>,
        session_id: String,
        workspace_id: String,
    }

    impl Drop for NativeSessionCleanup {
        fn drop(&mut self) {
            for observer_id in &self.observer_ids {
                let _ = self.state.detach_structured_terminal(observer_id);
            }
            let _ = self
                .state
                .terminate_standalone(&self.session_id, &self.workspace_id);
        }
    }

    #[test]
    fn native_adapter_creates_streams_inputs_resizes_and_reattaches() {
        let runtime = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/hmux-runtime-x86_64-pc-windows-msvc.exe")
            .canonicalize()
            .expect("Windows release Hmux runtime must be staged before adapter tests");
        let fixture = tempfile::tempdir().unwrap();
        let discovery_root = fixture.path().join("discovery");
        let state = Arc::new(WindowsHmuxState::with_paths(runtime, discovery_root));
        let created = state
            .create_standalone(WindowsStandaloneCreateRequest {
                operation_id: None,
                cwd: fixture
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                rows: 24,
                columns: 80,
                terminal_env: None,
                command_line: None,
                terminal_default_colors: TerminalDefaultColors::default(),
            })
            .expect("native Windows adapter must create a standalone Hmux session");
        let session_id = created.session_id.clone();
        let workspace_id = created.workspace_id.clone();
        let mut cleanup = NativeSessionCleanup {
            state: Arc::clone(&state),
            observer_ids: Vec::new(),
            session_id: session_id.clone(),
            workspace_id: workspace_id.clone(),
        };

        let observer_one = "windows-adapter-observer-1".to_string();
        cleanup.observer_ids.push(observer_one.clone());
        let attached = state
            .attach_structured_terminal(
                observer_one.clone(),
                "windows-adapter-webview-1".to_string(),
                "windows-adapter-pane".to_string(),
                session_id.clone(),
                Some(workspace_id.clone()),
                TerminalSurfaceAccess::Writer,
            )
            .expect("native Windows adapter must attach its structured terminal surface");
        assert!(attached
            .selected_capabilities
            .iter()
            .any(|capability| capability == "terminal_state_binary_v1"));
        let seed = next_binary_record(
            &state,
            &observer_one,
            "windows-adapter-webview-1",
            Duration::from_secs(5),
        );
        let seed =
            decode_record(&seed).expect("initial adapter record must be terminal-state data");
        assert_eq!(seed.record.terminal_epoch, attached.terminal_epoch);

        let text_record_id = 1;
        let text = TerminalStateRecord {
            schema_minor: seed.record.schema_minor,
            terminal_epoch: seed.record.terminal_epoch.clone(),
            through_output_seq: seed.record.through_output_seq,
            state_revision: seed.record.state_revision,
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Text(TextInputIntent {
                    utf8: b"echo WINDOWS_ADAPTER_READY\r".to_vec(),
                })),
            })),
        };
        let text_record =
            encode_record_for_minor(seed.metadata.protocol_minor, text_record_id, &text).unwrap();
        assert_eq!(
            state
                .structured_terminal_upstream(&observer_one, text_record)
                .unwrap(),
            text_record_id.to_string()
        );

        let resize_record_id = 2;
        let resize = TerminalStateRecord {
            schema_minor: seed.record.schema_minor,
            terminal_epoch: seed.record.terminal_epoch.clone(),
            through_output_seq: seed.record.through_output_seq,
            state_revision: seed.record.state_revision,
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                    columns: 101,
                    rows: 41,
                    geometry_generation: resize_record_id,
                })),
            })),
        };
        let resize_record =
            encode_record_for_minor(seed.metadata.protocol_minor, resize_record_id, &resize)
                .unwrap();
        assert_eq!(
            state
                .structured_terminal_upstream(&observer_one, resize_record)
                .unwrap(),
            resize_record_id.to_string()
        );

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut input_confirmed = false;
        let mut resize_confirmed = false;
        while !input_confirmed || !resize_confirmed {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("native adapter did not return input and resize receipts in time");
            let record = next_record(
                &state,
                &observer_one,
                "windows-adapter-webview-1",
                remaining,
            );
            if !record.starts_with(&ENVELOPE_MAGIC) {
                continue;
            }
            let decoded = decode_record(&record).unwrap();
            match decoded.record.body {
                Some(terminal_state_record::Body::InputReceipt(receipt))
                    if receipt.in_reply_to_record_id == text_record_id =>
                {
                    input_confirmed = matches!(
                        receipt.outcome,
                        Some(input_receipt::Outcome::WrittenToPty(_))
                    );
                }
                Some(terminal_state_record::Body::ResizeReceipt(receipt))
                    if receipt.in_reply_to_record_id == resize_record_id =>
                {
                    resize_confirmed = matches!(
                        receipt.outcome,
                        Some(resize_receipt::Outcome::AppliedToTerminal(applied))
                            if (applied.columns, applied.rows) == (101, 41)
                    );
                }
                _ => {}
            }
        }

        state.detach_structured_terminal(&observer_one).unwrap();
        let observer_two = "windows-adapter-observer-2".to_string();
        cleanup.observer_ids.push(observer_two.clone());
        let reattached = state
            .attach_structured_terminal(
                observer_two.clone(),
                "windows-adapter-webview-2".to_string(),
                "windows-adapter-pane".to_string(),
                session_id.clone(),
                Some(workspace_id.clone()),
                TerminalSurfaceAccess::Writer,
            )
            .expect("native Windows adapter must reattach the same Host generation");
        assert_eq!(reattached.terminal_epoch, attached.terminal_epoch);
        let replay = next_binary_record(
            &state,
            &observer_two,
            "windows-adapter-webview-2",
            Duration::from_secs(5),
        );
        let replay = decode_record(&replay).expect("reattach must return a replay seed");
        assert_eq!(replay.record.terminal_epoch, attached.terminal_epoch);

        let exact = state
            .inspect_sessions_exact(vec![WindowsExactSessionTarget {
                session_id: session_id.clone(),
                workspace_id: workspace_id.clone(),
            }])
            .unwrap();
        assert!(matches!(
            exact.as_slice(),
            [WindowsExactSessionInspectionResult::Found { .. }]
        ));
        state.detach_structured_terminal(&observer_two).unwrap();
        state
            .terminate_standalone(&session_id, &workspace_id)
            .unwrap();
    }

    fn next_binary_record(
        state: &Arc<WindowsHmuxState>,
        observer_id: &str,
        webview_instance_id: &str,
        timeout: Duration,
    ) -> Vec<u8> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("adapter did not return a terminal-state record in time");
            let record = next_record(state, observer_id, webview_instance_id, remaining);
            if record.starts_with(&ENVELOPE_MAGIC) {
                return record;
            }
        }
    }

    fn next_record(
        state: &Arc<WindowsHmuxState>,
        observer_id: &str,
        webview_instance_id: &str,
        timeout: Duration,
    ) -> Vec<u8> {
        let state_for_pull = Arc::clone(state);
        let observer_for_pull = observer_id.to_string();
        let webview_for_pull = webview_instance_id.to_string();
        let (sender, receiver) = mpsc::sync_channel(1);
        let pull = std::thread::spawn(move || {
            let result = state_for_pull
                .next_structured_terminal_record(&observer_for_pull, &webview_for_pull);
            let _ = sender.send(result);
        });
        match receiver.recv_timeout(timeout) {
            Ok(result) => {
                pull.join()
                    .expect("structured terminal pull thread panicked");
                result.expect("structured terminal pull failed")
            }
            Err(error) => {
                let _ = state.detach_structured_terminal(observer_id);
                let _ = pull.join();
                panic!("structured terminal pull timed out: {error}");
            }
        }
    }
}
