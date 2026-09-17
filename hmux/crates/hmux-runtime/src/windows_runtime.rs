// Native Windows Hmux runtime entry point.

#[path = "server/client_connection/transport.rs"]
mod client_transport;
mod agent_state_report;
mod managed_agent_state_report;
mod managed_create_failure;
mod managed_create_advance;
mod managed_create_chain_stop;
mod managed_create_intent;
mod managed_create_reconcile;
mod managed_starting_generation;
mod managed_stop_fence;
mod managed_stop_intent;
mod windows_conpty;
mod windows_managed_stop;
mod windows_provider_environment;
#[cfg(feature = "terminal-state-stream")]
mod windows_terminal;
#[cfg(feature = "terminal-state-stream")]
#[path = "terminal_surface/encoding.rs"]
mod windows_terminal_encoding;

#[cfg(feature = "terminal-state-stream")]
use crate::terminal_geometry::TerminalSurfaceGeometry;

use client_transport::{ClientTransport, SharedFrameWriter};
use hmux_client::recovery_journal::managed_create_ledger::{
    self, ManagedStartingGeneration, ManagedStartingProviderContainment,
};
use hmux_client::{
    EXACT_DISCOVERY_WORKER_SUBCOMMAND, LocalSession, LocalSessionCatalog, ProcessDescriptor,
    SessionSelector, prepare_managed_attach_receipt, serve_catalog_census,
    serve_exact_discovery_lookup,
};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ExitedManifest,
    HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind, ManifestCommon, ReadyManifest,
    SessionClass, SessionRetirementPolicy, StartingManifest, launch_program_label,
    workspace_id_for_path,
};
use hmux_host::local_protocol::{
    AGENT_RUNTIME_STATE_CAPABILITY, AGENT_STATE_REPORT_CAPABILITY,
    AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY, AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
    AttachMode, AuthorizationPosture, ErrorCode, ErrorFrame,
    FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY, FrameBody, FrameCodec, FrameLimits,
    HelloAck, InputReceipt, InputReceiptState, LifecycleState,
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
    MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY,
    MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY, MANAGED_PROVIDER_STOP_CAPABILITY,
    ManagedProviderStopReceipt, ManagedProviderStopReceiptState, OperationReceiptReason,
    PROTOCOL_V1, PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY, ProcessProof,
    RECONNECT_RESUME_CAPABILITY, ResizeReceipt, ResizeReceiptState, RetryPosture,
    SCREEN_SNAPSHOT_PROFILE_CAPABILITY, SHARED_TERMINAL_INPUT_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY, ScreenSnapshotProfile, SessionFence,
    StandaloneTerminateReceipt, StandaloneTerminateReceiptState, VersionRange, WireFrame,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::local_protocol::{
    AGENT_PROMPT_CAPABILITY, AgentProvider, AgentRuntimeStateSource,
    LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    select_managed_agent_prompt_capability,
};
use hmux_local_platform::transport::windows_named_pipe::WindowsNamedPipeListener;
use hmux_host::local_transport::{TransportError, TransportInterrupt};
use hmux_local_platform::peer_attestation::SessionScope;
use hmux_host::provider_epoch::{ProviderExitKind, ProviderExitStatus};
use hmux_host::session_host::{SessionHost, SessionHostError};
use hmux_host::terminal_replay::{
    ExecutionLocationObservation, ProviderConversationIdentityObservation, ReplayResult,
    TerminalReplayLimits, WorkingDirectoryObservation,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::terminal_replay::{AgentIdentityObservation, AgentRuntimeObservation};
use hmux_runtime_contract::{
    DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE, HOST_REGISTRATION_CAPACITY_EXIT_CODE,
    MANAGED_AGENT_STATE_REPORT_BROKER_SUBCOMMAND, MANAGED_ATTACH_BROKER_SUBCOMMAND,
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, MANAGED_CREATE_ADVANCE_CAPABILITY,
    MANAGED_CREATE_BROKER_SUBCOMMAND, MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND,
    MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2, MANAGED_CREATE_CHAIN_STOP_CAPABILITY,
    MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2, MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedAttachBrokerResponse, ManagedAttachReceipt, ManagedAttachRequest,
    ManagedCreateBrokerResponse, ManagedCreateGenerationFence, ManagedCreateOutcome,
    ManagedCreateReceipt, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ManagedStopBrokerResponse, ManagedStopOutcome, ManagedStopReceipt, ManagedStopReconcileRequest,
    ManagedStopRequest, PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
    PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY, ProviderConversationIdentitySeed,
    ProviderStateEnvironment, STANDALONE_CREATE_BROKER_SUBCOMMAND, StandaloneCreateBrokerResponse,
    StandaloneCreateReceipt, StandaloneCreateRequest, TerminalDefaultColors, TerminalEnvironment,
    read_json_frame, read_managed_attach_finalization, read_managed_attach_request,
    read_managed_create_request, read_managed_stop_reconcile_request, read_managed_stop_request,
    read_standalone_create_request, write_json_frame, write_managed_attach_response,
    write_managed_create_response, write_managed_stop_response, write_standalone_create_response,
};
use hmux_runtime_contract::{
    TERMINAL_DEFAULT_COLORS_CAPABILITY, TERMINAL_INPUT_INTENT_CAPABILITY,
    terminal_capability_permitted_for_agent_prompt,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_runtime_contract::{
    TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    terminal_capability_request_is_consistent,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use windows_conpty::ConPtyProcess;
use windows_provider_environment::provider_environment;
#[cfg(feature = "terminal-state-stream")]
use crate::structured_upstream::StructuredUpstream;
#[cfg(feature = "terminal-state-stream")]
use windows_terminal::WindowsTerminalSurface;
use crate::controller_input_effect::ControllerInputEffect;
use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, GetProcessTimes, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

const BUILD_INFO_SUBCOMMAND: &str = "hmux-build-info";
const INTERNAL_HOST_SUBCOMMAND: &str = "internal-hmux-windows-host";
const HOST_BUILD_ID: &str = env!("HMUX_BUILD_ID");
#[cfg(feature = "terminal-state-stream")]
const RUNTIME_PRODUCT_PROFILE: &str = "structured-terminal-v1";
#[cfg(not(feature = "terminal-state-stream"))]
const RUNTIME_PRODUCT_PROFILE: &str = "runtime-core-v1";
const HOST_READY_TIMEOUT: Duration = Duration::from_secs(20);
const HOST_READY_POLL: Duration = Duration::from_millis(25);
const EXIT_GRACE: Duration = Duration::from_secs(3);
const CLIENT_ADMISSION_TIMEOUT: Duration = Duration::from_secs(3);
const FRAME_COMPLETION_TIMEOUT: Duration = Duration::from_secs(64);
const CLIENT_QUEUE_CAPACITY: usize = 2_048;
const PROVIDER_WAIT_POLL: Duration = Duration::from_millis(20);
const AGENT_RUNTIME_EXPIRY_POLL: Duration = Duration::from_millis(750);
const PROVIDER_JOB_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const TEST_GUARDIAN_CUT_PHASE_ENV: &str = "HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE";
const TEST_GUARDIAN_CUT_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER";
#[cfg(all(feature = "terminal-state-stream", debug_assertions))]
const TEST_AGENT_PROMPT_POST_WAIT_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_AGENT_PROMPT_POST_WAIT_MARKER";
#[cfg(all(feature = "terminal-state-stream", debug_assertions))]
const TEST_AGENT_PROMPT_POST_WAIT_RELEASE_ENV: &str =
    "HMUX_RUNTIME_TEST_AGENT_PROMPT_POST_WAIT_RELEASE";
const HOST_CAPABILITIES: &[&str] = &[
    "screen_snapshot",
    "live_output",
    "terminal_input",
    "terminal_resize",
    "terminal_control",
    SHARED_TERMINAL_INPUT_CAPABILITY,
    SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
    RECONNECT_RESUME_CAPABILITY,
];

fn advertised_capabilities() -> Vec<String> {
    #[cfg(feature = "terminal-state-stream")]
    let mut capabilities = HOST_CAPABILITIES
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    #[cfg(not(feature = "terminal-state-stream"))]
    let capabilities = HOST_CAPABILITIES
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    #[cfg(feature = "terminal-state-stream")]
    capabilities.extend(
        [
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            TERMINAL_INPUT_INTENT_CAPABILITY,
            TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
            TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        ]
        .map(str::to_string),
    );
    capabilities
}

fn managed_host_capabilities(process_observed_agent_prompt: bool) -> Vec<String> {
    #[cfg(not(feature = "terminal-state-stream"))]
    let _ = process_observed_agent_prompt;
    let capabilities = [
        managed_starting_generation::PROVIDER_RELEASE_BARRIER_CAPABILITY,
        hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
        AGENT_RUNTIME_STATE_CAPABILITY,
        AGENT_STATE_REPORT_CAPABILITY,
        AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
        AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
        FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
        MANAGED_PROVIDER_STOP_CAPABILITY,
        MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY,
        MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY,
        hmux_host::local_protocol::SEMANTIC_IDLE_OBSERVATION_CAPABILITY,
        MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
        PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
        PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
        PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY,
    ]
    .map(str::to_string)
    .to_vec();
    #[cfg(feature = "terminal-state-stream")]
    let mut capabilities = capabilities;
    #[cfg(feature = "terminal-state-stream")]
    capabilities.extend(
        [AGENT_PROMPT_CAPABILITY, LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY].map(str::to_string),
    );
    #[cfg(feature = "terminal-state-stream")]
    if process_observed_agent_prompt {
        capabilities.push(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY.to_string());
    }
    capabilities
}

fn effective_managed_host_capabilities(process_observed_agent_prompt: bool) -> Vec<String> {
    managed_create_failure::effective_host_capabilities(managed_host_capabilities(
        process_observed_agent_prompt,
    ))
}

type DynError = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, DynError>;

#[derive(Debug)]
struct HostSpawnFailure {
    code: &'static str,
    message: String,
}

impl HostSpawnFailure {
    fn from_child_exit(status: std::process::ExitStatus, message: String) -> Self {
        let code = if status.code() == Some(HOST_REGISTRATION_CAPACITY_EXIT_CODE) {
            DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE
        } else {
            "hmux_host_launch_failed"
        };
        Self { code, message }
    }

    fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for HostSpawnFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HostSpawnFailure {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsHostLaunchPacket {
    discovery_root: PathBuf,
    provider_program: PathBuf,
    provider_args: Vec<String>,
    provider_cwd: PathBuf,
    workspace_id: String,
    session_id: String,
    session_class: SessionClass,
    provider_id: String,
    session_name: Option<String>,
    idempotency_key: Option<String>,
    initial_rows: u16,
    initial_columns: u16,
    terminal_default_colors: TerminalDefaultColors,
    terminal_environment: TerminalEnvironment,
    provider_state_environment: ProviderStateEnvironment,
    conversation_identity: Option<ProviderConversationIdentitySeed>,
    launch_owner_proof: Option<String>,
    retirement_policy: Option<SessionRetirementPolicy>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("hmux-runtime: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let arguments = runtime_arguments(env::args().skip(1));
    match arguments.as_slice() {
        [command] if command == BUILD_INFO_SUBCOMMAND => write_build_info(),
        [command] if command == STANDALONE_CREATE_BROKER_SUBCOMMAND => {
            standalone_create_broker()
        }
        [command] if command == MANAGED_CREATE_BROKER_SUBCOMMAND => managed_create_broker(),
        [command] if command == MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND => {
            managed_create_reconcile::broker()
        }
        [command] if command == MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND => {
            managed_create_advance::broker()
        }
        [command] if command == MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND => {
            managed_create_chain_stop::broker()
        }
        [command] if command == MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2 => {
            managed_create_chain_stop::broker_v2()
        }
        [command] if command == MANAGED_ATTACH_BROKER_SUBCOMMAND => managed_attach_broker(),
        [command] if command == MANAGED_AGENT_STATE_REPORT_BROKER_SUBCOMMAND => {
            managed_agent_state_report::broker()
        }
        [command] if command == MANAGED_STOP_BROKER_SUBCOMMAND => managed_stop_broker(),
        [command] if command == MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND => {
            managed_stop_reconcile_broker()
        }
        [command] if command == hmux_client::CATALOG_CENSUS_WORKER_SUBCOMMAND => {
            serve_catalog_census(io::stdin().lock(), io::stdout().lock())?;
            Ok(())
        }
        [discovery_flag, discovery_root, command]
            if discovery_flag == "--discovery-root"
                && command == EXACT_DISCOVERY_WORKER_SUBCOMMAND =>
        {
            let catalog = LocalSessionCatalog::new(PathBuf::from(discovery_root));
            serve_exact_discovery_lookup(&catalog, io::stdin().lock(), io::stdout().lock())?;
            Ok(())
        }
        [command] if command == INTERNAL_HOST_SUBCOMMAND => {
            let packet = read_json_frame(&mut io::stdin())?;
            run_host(packet)
        }
        _ => Err("unsupported Windows Hmux runtime command".into()),
    }
}

fn write_build_info() -> Result<()> {
    serde_json::to_writer(
        io::stdout(),
        &serde_json::json!({
            "schemaVersion": 1,
            "buildId": HOST_BUILD_ID,
            "source": "hmux_runtime",
            "sourceCommit": env!("HMUX_SOURCE_COMMIT"),
            "targetTriple": env!("HMUX_TARGET_TRIPLE"),
            "productProfile": RUNTIME_PRODUCT_PROFILE,
            "protocol": { "minimum": "1.0", "maximum": "1.0" },
            "capabilities": [
                hmux_runtime_contract::MANAGED_CREATE_CAPABILITY,
                hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
                MANAGED_CREATE_ADVANCE_CAPABILITY,
                MANAGED_CREATE_CHAIN_STOP_CAPABILITY,
                MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2,
            ],
        }),
    )?;
    Ok(())
}

fn standalone_create_broker() -> Result<()> {
    let response = match read_standalone_create_request(&mut io::stdin()) {
        Ok(request) => match launch_standalone(request) {
            Ok(receipt) => StandaloneCreateBrokerResponse::Created(receipt),
            Err(error) => StandaloneCreateBrokerResponse::refused(
                "hmux_standalone_launch_failed",
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

fn managed_create_broker() -> Result<()> {
    let response = match read_managed_create_request(&mut io::stdin()) {
        Ok(request) => match launch_managed(request) {
            Ok(receipt) => ManagedCreateBrokerResponse::Completed(Box::new(receipt)),
            Err(error) => {
                match managed_create_failure::failure_code(error.as_ref()) {
                    Some(code) => ManagedCreateBrokerResponse::refused(code, error.to_string()),
                    None => ManagedCreateBrokerResponse::retryable(
                        "hmux_managed_launch_failed",
                        error.to_string(),
                    ),
                }
            }
        },
        Err(error) => {
            ManagedCreateBrokerResponse::refused(
                hmux_runtime_contract::MANAGED_CREATE_REQUEST_INVALID_CODE,
                error.to_string(),
            )
        }
    };
    write_managed_create_response(&mut io::stdout(), &response)?;
    Ok(())
}

fn launch_managed(request: ManagedCreateRequest) -> Result<ManagedCreateReceipt> {
    launch_managed_with_lineage(
        request,
        managed_create_intent::ManagedCreateIntentLineage::Root,
    )
}

fn launch_managed_successor(request: ManagedCreateRequest) -> Result<ManagedCreateReceipt> {
    launch_managed_with_lineage(
        request,
        managed_create_intent::ManagedCreateIntentLineage::Successor,
    )
}

fn launch_managed_with_lineage(
    request: ManagedCreateRequest,
    lineage: managed_create_intent::ManagedCreateIntentLineage,
) -> Result<ManagedCreateReceipt> {
    request.validate()?;
    #[cfg(feature = "terminal-state-stream")]
    let process_observed_agent_prompt = {
        let (provider_program, _) = resolve_command(request.command());
        direct_launch_agent(request.provider_id(), &provider_program).is_some()
    };
    #[cfg(not(feature = "terminal-state-stream"))]
    let process_observed_agent_prompt = false;
    managed_create_failure::ensure_required_capabilities(
        &request,
        &effective_managed_host_capabilities(process_observed_agent_prompt),
    )?;
    let catalog = LocalSessionCatalog::from_environment()?;
    let discovery_root = catalog.discovery_root().to_path_buf();
    let root = DiscoveryRoot::create(&discovery_root)?;
    prepare_host_admission_capacity(&discovery_root);
    let create_maintenance = root.acquire_maintenance_shared()?;
    let (mut intent, terminal_default_colors) =
        match managed_create_intent::acquire_with_lineage(&discovery_root, &request, lineage)? {
        managed_create_intent::ManagedCreateIntent::Completed(receipt) => {
            return managed_create_intent::replay_receipt(&request, &discovery_root, receipt);
        }
        managed_create_intent::ManagedCreateIntent::SpawnReserved {
            intent,
            host_process: _observed_host_process,
        }
        | managed_create_intent::ManagedCreateIntent::LaunchReleased {
            intent,
            host_process: _observed_host_process,
        } => {
            drop(intent);
            drop(create_maintenance);
            let identity = ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )?;
            let reconciled = managed_create_reconcile::reconcile_for_same_create_retry(
                &discovery_root,
                &identity,
                |host_process| {
                    let Some(ready) = managed_ready(&root, &request)
                        .map_err(|error| error.to_string())?
                    else {
                        return Ok(None);
                    };
                    if ready.common.host_process.process_id != host_process.process_id
                        || ready.common.host_process.start_marker != host_process.start_marker
                    {
                        return Err(
                            "managed create retry Ready Host generation changed".to_string()
                        );
                    }
                    managed_receipt(
                        &root,
                        &request,
                        &discovery_root,
                        ManagedCreateOutcome::Reused,
                    )
                    .map(Some)
                    .map_err(|error| error.to_string())
                },
            )?;
            return match reconciled {
                managed_create_reconcile::ManagedCreateRetryReconcile::Completed(receipt) => {
                    managed_create_intent::replay_receipt(&request, &discovery_root, *receipt)
                }
                managed_create_reconcile::ManagedCreateRetryReconcile::Reopened => {
                    launch_managed_with_lineage(request, lineage)
                }
                managed_create_reconcile::ManagedCreateRetryReconcile::Pending => Err(
                    "managed create retry remains pending after exact reconciliation".into(),
                ),
                managed_create_reconcile::ManagedCreateRetryReconcile::NotFound => Err(
                    "managed create retry authority disappeared during reconciliation".into(),
                ),
                managed_create_reconcile::ManagedCreateRetryReconcile::Retired => Err(
                    hmux_client::recovery_journal::managed_create_ledger::ManagedCreateAdmissionError::GenerationRetiredExact.into(),
                ),
            };
        }
        managed_create_intent::ManagedCreateIntent::Retired => {
            return Err(hmux_client::recovery_journal::managed_create_ledger::ManagedCreateAdmissionError::GenerationRetiredExact.into());
        }
        managed_create_intent::ManagedCreateIntent::Prepared(mut intent) => {
            match root.find_manifest_by_session(request.workspace_id(), request.session_id()) {
                Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound) => {}
                Ok(_) => {
                    return Err("managed session identity is already present in discovery".into());
                }
                Err(error) => return Err(error.into()),
            }
            intent.checkpoint_pre_spawn_absence()?;
            let terminal_default_colors =
                intent.resolve_terminal_default_colors(request.terminal_default_colors())?;
            (intent, terminal_default_colors)
        }
    };
    drop(create_maintenance);
    let provider_cwd = fs::canonicalize(request.provider_cwd())?;
    if !provider_cwd.is_dir() {
        return Err("provider cwd is not a directory".into());
    }
    let (provider_program, provider_args) = resolve_command(request.command());
    let packet = WindowsHostLaunchPacket {
        discovery_root: discovery_root.clone(),
        provider_program,
        provider_args,
        provider_cwd,
        workspace_id: request.workspace_id().to_string(),
        session_id: request.session_id().to_string(),
        session_class: SessionClass::Managed,
        provider_id: request.provider_id().to_string(),
        session_name: None,
        idempotency_key: Some(request.idempotency_key().to_string()),
        initial_rows: request.initial_rows(),
        initial_columns: request.initial_columns(),
        terminal_default_colors: terminal_default_colors.unwrap_or_default(),
        terminal_environment: request.terminal_environment().clone(),
        provider_state_environment: request.provider_state_environment().clone(),
        conversation_identity: request.conversation_identity().cloned(),
        launch_owner_proof: None,
        retirement_policy: None,
    };
    spawn_host_after_preflight(&packet, |host_process| {
        intent.mark_spawn_reserved(host_process)?;
        intent.release_with_barrier_proof()?;
        Ok(())
    })?;
    let receipt = managed_receipt(
        &root,
        &request,
        &discovery_root,
        ManagedCreateOutcome::Created,
    )?;
    Ok(intent.complete(&receipt)?)
}

fn managed_ready(
    root: &DiscoveryRoot,
    request: &ManagedCreateRequest,
) -> Result<Option<ReadyManifest>> {
    let found = match root
        .find_current_manifest_by_session(request.workspace_id(), request.session_id())
    {
        Ok(found) => found,
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let common = found.manifest.common();
    if common.session_class != SessionClass::Managed
        || common.provider_id != request.provider_id()
        || common.claim_linkage.kickoff_action_id.as_deref() != Some(request.idempotency_key())
    {
        return Err("managed discovery identity conflicts with the create request".into());
    }
    match found.manifest {
        DiscoveryManifest::Ready(ready)
            if ready.endpoint.kind == LocalEndpointKind::WindowsNamedPipe =>
        {
            Ok(Some(ready))
        }
        DiscoveryManifest::Starting(_) => Ok(None),
        DiscoveryManifest::Exited(_) => {
            Err("managed provider already exited; explicit recovery is required".into())
        }
        DiscoveryManifest::Ready(_) => Err("managed endpoint is not a Windows named pipe".into()),
    }
}

fn managed_receipt(
    root: &DiscoveryRoot,
    request: &ManagedCreateRequest,
    discovery_root: &Path,
    outcome: ManagedCreateOutcome,
) -> Result<ManagedCreateReceipt> {
    let ready = managed_ready(root, request)?
        .ok_or("managed create receipt cannot fence a session that is not ready")?;
    let common = &ready.common;
    if !managed_create_failure::ready_satisfies_required_capabilities(
        request,
        &common.capabilities,
    ) {
        return Err(
            "managed create Host is ready without a required request capability".into(),
        );
    }
    let fence = ManagedCreateGenerationFence::new(
        &common.lifetime.runner_principal,
        &common.lifetime.runner_instance,
        common.lifetime.channel_epoch,
        &common.host_instance_id,
        &ready.terminal_epoch,
    )?;
    Ok(ManagedCreateReceipt::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
        request.provider_id(),
        request.permission_mode(),
        discovery_root,
        outcome,
    )?
    .with_generation_fence(fence)?)
}

fn managed_attach_broker() -> Result<()> {
    let request = match read_managed_attach_request(&mut io::stdin()) {
        Ok(request) => request,
        Err(error) => {
            write_managed_attach_response(
                &mut io::stdout(),
                &ManagedAttachBrokerResponse::refused(
                    "hmux_managed_attach_request_invalid",
                    error.to_string(),
                ),
            )?;
            return Ok(());
        }
    };
    let response = prepare_managed_attach(&request);
    let transaction_id = match &response {
        ManagedAttachBrokerResponse::Prepared(receipt) => {
            Some(receipt.transaction_id().to_string())
        }
        ManagedAttachBrokerResponse::Refused(_) => None,
    };
    write_managed_attach_response(&mut io::stdout(), &response)?;
    if let Some(transaction_id) = transaction_id {
        read_managed_attach_finalization(&mut io::stdin(), &transaction_id)?;
    }
    Ok(())
}

fn prepare_managed_attach(request: &ManagedAttachRequest) -> ManagedAttachBrokerResponse {
    let prepared = (|| -> Result<ManagedAttachReceipt> {
        let catalog = LocalSessionCatalog::from_environment()?;
        Ok(prepare_managed_attach_receipt(&catalog, request)?)
    })();
    match prepared {
        Ok(receipt) => ManagedAttachBrokerResponse::prepared(receipt),
        Err(error) => ManagedAttachBrokerResponse::refused(
            "hmux_managed_attach_unavailable",
            error.to_string(),
        ),
    }
}

fn managed_stop_broker() -> Result<()> {
    let response = match read_managed_stop_request(&mut io::stdin()) {
        Ok(request) => match stop_managed_provider(&request) {
            Ok(receipt) => ManagedStopBrokerResponse::Completed(Box::new(receipt)),
            Err(error) => ManagedStopBrokerResponse::refused(error.code(), error.to_string()),
        },
        Err(error) => ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_request_invalid",
            error.to_string(),
        ),
    };
    write_managed_stop_response(&mut io::stdout(), &response)?;
    Ok(())
}

fn managed_stop_reconcile_broker() -> Result<()> {
    let response = match read_managed_stop_reconcile_request(&mut io::stdin()) {
        Ok(request) => match reconcile_managed_stop(&request) {
            Ok(receipt) => ManagedStopBrokerResponse::Completed(Box::new(receipt)),
            Err(error) => ManagedStopBrokerResponse::refused(error.code(), error.to_string()),
        },
        Err(error) => ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_reconcile_request_invalid",
            error.to_string(),
        ),
    };
    write_managed_stop_response(&mut io::stdout(), &response)?;
    Ok(())
}

#[derive(Debug)]
enum WindowsManagedStopError {
    Refused(String),
    OutcomeUnknown(String),
    IntentNotFound(String),
    Capacity(String),
}

impl WindowsManagedStopError {
    fn code(&self) -> &'static str {
        match self {
            Self::Refused(_) => "hmux_managed_stop_unavailable",
            Self::OutcomeUnknown(_) => "hmux_managed_stop_outcome_unknown",
            Self::IntentNotFound(_) => "hmux_managed_stop_intent_not_found",
            Self::Capacity(_) => "hmux_managed_stop_capacity_exceeded",
        }
    }
}

impl std::fmt::Display for WindowsManagedStopError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(message)
            | Self::OutcomeUnknown(message)
            | Self::IntentNotFound(message)
            | Self::Capacity(message) => formatter.write_str(message),
        }
    }
}

fn managed_stop_intent_error(
    error: managed_stop_intent::ManagedStopIntentError,
) -> WindowsManagedStopError {
    if error.outcome_unknown() {
        WindowsManagedStopError::OutcomeUnknown(error.to_string())
    } else if error.not_found() {
        WindowsManagedStopError::IntentNotFound(error.to_string())
    } else if error.capacity() {
        WindowsManagedStopError::Capacity(error.to_string())
    } else {
        WindowsManagedStopError::Refused(error.to_string())
    }
}

fn reconcile_managed_stop(
    request: &ManagedStopReconcileRequest,
) -> std::result::Result<ManagedStopReceipt, WindowsManagedStopError> {
    request
        .validate()
        .map_err(|error| WindowsManagedStopError::Refused(error.to_string()))?;
    let roots = LocalSessionCatalog::from_environment()
        .and_then(|catalog| catalog.managed_stop_reconcile_roots())
        .map_err(|error| WindowsManagedStopError::Refused(error.to_string()))?;
    let mut matches = Vec::new();
    for root in roots {
        match managed_stop_intent::reconciliation_exists(&root, request) {
            Ok(true) => matches.push(root),
            Ok(false) => {}
            Err(error) => return Err(managed_stop_intent_error(error)),
        }
    }
    if matches.len() > 1 {
        return Err(WindowsManagedStopError::OutcomeUnknown(
            "managed stop reconciliation is ambiguous across discovery roots".to_string(),
        ));
    }
    let Some(root) = matches.pop() else {
        return Err(WindowsManagedStopError::IntentNotFound(
            "managed stop intent was not found".to_string(),
        ));
    };
    let intent = managed_stop_intent::reconcile(&root, request)
        .map_err(managed_stop_intent_error)?;
    continue_managed_stop_intent(&root, intent)
}

fn stop_managed_provider(
    request: &ManagedStopRequest,
) -> std::result::Result<ManagedStopReceipt, WindowsManagedStopError> {
    let root = resolve_managed_stop_root(request)?;
    match managed_stop_intent::reconcile(
        &root,
        &ManagedStopReconcileRequest::from_stop_request(request)
            .map_err(|error| WindowsManagedStopError::Refused(error.to_string()))?,
    ) {
        Ok(intent) => return continue_managed_stop_intent(&root, intent),
        Err(error) if error.not_found() => {}
        Err(error) => return Err(managed_stop_intent_error(error)),
    }
    let discovery = DiscoveryRoot::open(&root)
        .map_err(|error| WindowsManagedStopError::Refused(error.to_string()))?;
    let found = discovery
        .find_manifest_by_session(request.workspace_id(), request.session_id())
        .map_err(|error| WindowsManagedStopError::Refused(error.to_string()))?;
    validate_managed_stop_fence(request, &found.manifest)
        .map_err(WindowsManagedStopError::Refused)?;
    if matches!(found.manifest, DiscoveryManifest::Starting(_)) {
        return Err(WindowsManagedStopError::Refused(
            "managed session is still starting".to_string(),
        ));
    }
    let intent = managed_stop_intent::acquire(&root, request)
        .map_err(managed_stop_intent_error)?;
    match intent {
        managed_stop_intent::ManagedStopIntent::Pending(intent) => {
            execute_managed_stop_request(&root, request, intent, true)
        }
        other => continue_managed_stop_intent(&root, other),
    }
}

fn continue_managed_stop_intent(
    root: &Path,
    intent: managed_stop_intent::ManagedStopIntent,
) -> std::result::Result<ManagedStopReceipt, WindowsManagedStopError> {
    match intent {
        managed_stop_intent::ManagedStopIntent::Pending(_) => Err(
            WindowsManagedStopError::OutcomeUnknown(
                "managed stop reconciliation unexpectedly created a fresh intent".to_string(),
            ),
        ),
        managed_stop_intent::ManagedStopIntent::Resume { request, intent } => {
            execute_managed_stop_request(root, &request, intent, false)
        }
        managed_stop_intent::ManagedStopIntent::Checkpointed { receipt, intent } => {
            finish_checkpointed_managed_stop(root, receipt, intent)
        }
        managed_stop_intent::ManagedStopIntent::Completed(receipt) => {
            hmux_client::recovery_journal::managed_create_ledger::finalize_retirement_exact(
                root, &receipt,
            )
            .map_err(WindowsManagedStopError::OutcomeUnknown)?;
            Ok(receipt)
        }
        managed_stop_intent::ManagedStopIntent::Refused => {
            Err(WindowsManagedStopError::Refused(
                "managed stop was previously refused".to_string(),
            ))
        }
    }
}

fn execute_managed_stop_request(
    root: &Path,
    request: &ManagedStopRequest,
    mut intent: managed_stop_intent::ManagedStopIntentGuard,
    fresh: bool,
) -> std::result::Result<ManagedStopReceipt, WindowsManagedStopError> {
    let catalog = LocalSessionCatalog::new(root);
    let discovery = DiscoveryRoot::open(root)
        .map_err(|error| WindowsManagedStopError::OutcomeUnknown(error.to_string()))?;
    let found = discovery
        .find_manifest_by_session(request.workspace_id(), request.session_id())
        .map_err(|error| WindowsManagedStopError::OutcomeUnknown(error.to_string()))?;
    if let Err(error) = validate_managed_stop_fence(request, &found.manifest) {
        if fresh {
            intent
                .refuse(request)
                .map_err(managed_stop_intent_error)?;
            return Err(WindowsManagedStopError::Refused(error));
        }
        return Err(WindowsManagedStopError::OutcomeUnknown(error));
    }
    let outcome = match &found.manifest {
        DiscoveryManifest::Ready(ready) => {
            let session = LocalSession::from_manifest(found.manifest.clone())
                .map_err(|error| WindowsManagedStopError::OutcomeUnknown(error.to_string()))?;
            let stop = match request.expected_conversation() {
                Some(expected_conversation) => session.stop_managed_fenced_with_proof(
                    &catalog,
                    ready.capability_token.clone(),
                    Duration::from_secs(5),
                    expected_conversation,
                    request.expected_quiescence(),
                ),
                None => match request.expected_quiescence() {
                    Some(expected) => session.stop_managed_quiescent_with_proof(
                        &catalog,
                        ready.capability_token.clone(),
                        Duration::from_secs(5),
                        expected,
                    ),
                    None => session.stop_managed_with_proof(
                        &catalog,
                        ready.capability_token.clone(),
                        Duration::from_secs(5),
                    ),
                },
            };
            match stop {
                Ok(_) => ManagedStopOutcome::Stopped,
                Err(error) => {
                    let current = catalog
                        .find(&SessionSelector::new(
                            request.session_id(),
                            Some(request.workspace_id().to_string()),
                        ))
                        .map_err(|_| WindowsManagedStopError::OutcomeUnknown(error.to_string()))?;
                    if current.lifecycle != hmux_client::SessionLifecycle::Exited {
                        if error.is_definitive_managed_stop_refusal() {
                            intent
                                .refuse(request)
                                .map_err(managed_stop_intent_error)?;
                            return Err(WindowsManagedStopError::Refused(error.to_string()));
                        }
                        return Err(WindowsManagedStopError::OutcomeUnknown(error.to_string()));
                    }
                    ManagedStopOutcome::AlreadyExited
                }
            }
        }
        DiscoveryManifest::Exited(_) => ManagedStopOutcome::AlreadyExited,
        DiscoveryManifest::Starting(_) => {
            if fresh {
                intent
                    .refuse(request)
                    .map_err(managed_stop_intent_error)?;
                return Err(WindowsManagedStopError::Refused(
                    "managed session is still starting".to_string(),
                ));
            }
            return Err(WindowsManagedStopError::OutcomeUnknown(
                "managed stop target returned to starting".to_string(),
            ));
        }
    };
    let descriptor = catalog
        .find(&SessionSelector::new(
            request.session_id(),
            Some(request.workspace_id().to_string()),
        ))
        .map_err(|error| WindowsManagedStopError::OutcomeUnknown(error.to_string()))?;
    if descriptor.lifecycle != hmux_client::SessionLifecycle::Exited
        || descriptor.session_class != hmux_client::SessionClass::Managed
        || descriptor.runner_principal != request.expected_runner_principal().unwrap_or_default()
        || descriptor.runner_instance != request.expected_runner_instance().unwrap_or_default()
        || descriptor.channel_epoch
            != request
                .expected_channel_epoch()
                .unwrap_or_default()
                .to_string()
        || descriptor.host_instance_id != request.expected_host_instance_id().unwrap_or_default()
        || descriptor.terminal_epoch != request.expected_terminal_epoch().unwrap_or_default()
    {
        return Err(WindowsManagedStopError::OutcomeUnknown(
            "managed session generation changed during provider stop".to_string(),
        ));
    }
    let exit_reason = descriptor
        .exit
        .as_ref()
        .map(|exit| exit.reason.clone())
        .ok_or_else(|| {
            WindowsManagedStopError::OutcomeUnknown(
                "managed exited session has no exit reason".to_string(),
            )
        })?;
    let receipt = ManagedStopReceipt::from_request(request, outcome, exit_reason)
        .map_err(|error| WindowsManagedStopError::OutcomeUnknown(error.to_string()))?;
    intent
        .checkpoint_receipt(request, &receipt)
        .map_err(managed_stop_intent_error)?;
    finish_checkpointed_managed_stop(root, receipt, intent)
}

fn finish_checkpointed_managed_stop(
    root: &Path,
    receipt: ManagedStopReceipt,
    mut intent: managed_stop_intent::ManagedStopIntentGuard,
) -> std::result::Result<ManagedStopReceipt, WindowsManagedStopError> {
    hmux_client::recovery_journal::managed_create_ledger::checkpoint_retirement_exact(
        root, &receipt,
    )
    .map_err(WindowsManagedStopError::OutcomeUnknown)?;
    hmux_client::recovery_journal::managed_create_ledger::finalize_retirement_exact(root, &receipt)
        .map_err(WindowsManagedStopError::OutcomeUnknown)?;
    intent
        .finish_checkpointed(&receipt)
        .map_err(managed_stop_intent_error)?;
    Ok(receipt)
}

fn resolve_managed_stop_root(
    request: &ManagedStopRequest,
) -> std::result::Result<PathBuf, WindowsManagedStopError> {
    request
        .validate_complete_fence()
        .map_err(|error| WindowsManagedStopError::Refused(error.to_string()))?;
    let expected = SessionFence {
        workspace_id: request.workspace_id().to_string(),
        session_id: request.session_id().to_string(),
        runner_principal: request.expected_runner_principal().unwrap().to_string(),
        runner_instance: request.expected_runner_instance().unwrap().to_string(),
        channel_epoch: request.expected_channel_epoch().unwrap(),
        host_instance_id: request.expected_host_instance_id().unwrap().to_string(),
        terminal_epoch: request.expected_terminal_epoch().unwrap().to_string(),
    };
    let selector = SessionSelector::new(request.session_id(), Some(request.workspace_id().into()));
    LocalSessionCatalog::from_environment()
        .and_then(|catalog| catalog.resolve_managed_stop_discovery_root(&selector, &expected))
        .map_err(|error| WindowsManagedStopError::Refused(error.to_string()))
}

fn validate_managed_stop_fence(
    request: &ManagedStopRequest,
    manifest: &DiscoveryManifest,
) -> std::result::Result<(), String> {
    request
        .validate_complete_fence()
        .map_err(|error| error.to_string())?;
    let common = manifest.common();
    let generation = manifest.generation();
    if common.session_class != SessionClass::Managed
        || request.expected_runner_principal() != Some(&common.lifetime.runner_principal)
        || request.expected_runner_instance() != Some(&common.lifetime.runner_instance)
        || request.expected_channel_epoch() != Some(common.lifetime.channel_epoch)
        || request.expected_host_instance_id() != Some(common.host_instance_id.as_str())
        || request.expected_terminal_epoch() != generation.terminal_epoch.as_deref()
    {
        return Err("managed session generation changed before provider stop".to_string());
    }
    Ok(())
}

fn launch_standalone(request: StandaloneCreateRequest) -> Result<StandaloneCreateReceipt> {
    request.validate()?;
    if request.recovery_identity().is_some() {
        return Err("Windows standalone recovery is not available in this runtime build".into());
    }
    let provider_cwd = fs::canonicalize(request.provider_cwd())?;
    if !provider_cwd.is_dir() {
        return Err("provider cwd is not a directory".into());
    }
    let catalog = LocalSessionCatalog::from_environment()?;
    let discovery_root = catalog.discovery_root().to_path_buf();
    DiscoveryRoot::create(&discovery_root)?;
    prepare_host_admission_capacity(&discovery_root);
    let random = Uuid::new_v4().simple().to_string();
    let session_id = format!("standalone_{}", &random[..12]);
    let session_name = request
        .session_name()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("hmux-{}", &random[..6]));
    if catalog.list_named(&session_name)?.iter().any(|descriptor| {
        descriptor.session_class == hmux_client::SessionClass::Standalone
    }) {
        return Err(format!("an Hmux session named `{session_name}` already exists").into());
    }
    let workspace_id = workspace_id_for_path(&provider_cwd);
    let launch_owner_proof = Uuid::new_v4().to_string();
    let (provider_program, provider_args) = resolve_command(request.command());
    let packet = WindowsHostLaunchPacket {
        discovery_root: discovery_root.clone(),
        provider_program,
        provider_args,
        provider_cwd,
        workspace_id: workspace_id.clone(),
        session_id: session_id.clone(),
        session_class: SessionClass::Standalone,
        provider_id: "local-shell".to_string(),
        session_name: Some(session_name.clone()),
        idempotency_key: None,
        initial_rows: request.initial_rows(),
        initial_columns: request.initial_columns(),
        terminal_default_colors: request.terminal_default_colors().unwrap_or_default(),
        terminal_environment: request.terminal_environment().clone(),
        provider_state_environment: ProviderStateEnvironment::default(),
        conversation_identity: None,
        launch_owner_proof: Some(launch_owner_proof.clone()),
        retirement_policy: request.retirement_policy(),
    };
    spawn_host(&packet)?;
    Ok(StandaloneCreateReceipt::new(
        session_id,
        workspace_id,
        session_name,
        discovery_root,
        launch_owner_proof,
    )?)
}

fn spawn_host(packet: &WindowsHostLaunchPacket) -> Result<()> {
    spawn_host_after_preflight(packet, |_| Ok(()))
}

fn spawn_host_after_preflight(
    packet: &WindowsHostLaunchPacket,
    before_release: impl FnOnce(ProcessDescriptor) -> Result<()>,
) -> Result<()> {
    // The broker's standard streams are inherited pipe handles. A long-lived
    // Host must not retain them when Windows enables handle inheritance for
    // the launch packet pipe, or the caller can never observe broker EOF.
    seal_broker_standard_handles()?;
    let capture_stderr = env::var_os("HMUX_RUNTIME_LOG")
        .filter(|value| !value.is_empty())
        .is_none();
    let mut command = Command::new(env::current_exe()?);
    for key in hmux_runtime_contract::launching_client_session_env_keys(
        env::vars_os().filter_map(|(key, _)| key.into_string().ok()),
    ) {
        command.env_remove(key);
    }
    command
        .arg(INTERNAL_HOST_SUBCOMMAND)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(if capture_stderr {
            Stdio::piped()
        } else {
            host_stderr()
        })
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    let mut child = command.spawn()?;
    let mut captured_stderr = child.stderr.take();
    let child_proof = match process_proof(child.id()) {
        Ok(proof) => proof,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if let Err(error) = before_release(ProcessDescriptor {
        process_id: child_proof.process_id,
        start_marker: child_proof.start_marker,
    }) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let write_result: Result<()> = match child.stdin.take() {
        Some(mut input) => write_json_frame(&mut input, packet).map_err(Into::into),
        None => Err("Windows Hmux Host launch pipe is unavailable".into()),
    };
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let deadline = Instant::now() + HOST_READY_TIMEOUT;
    loop {
        let ready = match host_is_ready(packet) {
            Ok(ready) => ready,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        if ready {
            return Ok(());
        }
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
        };
        if let Some(status) = status {
            let detail = captured_stderr
                .as_mut()
                .and_then(|stderr| {
                    let mut detail = String::new();
                    stderr.read_to_string(&mut detail).ok().map(|_| detail)
                })
                .filter(|detail| !detail.trim().is_empty())
                .map(|detail| format!(": {}", detail.trim()))
                .unwrap_or_default();
            return Err(HostSpawnFailure::from_child_exit(
                status,
                format!("Windows Hmux Host exited before ready: {status}{detail}"),
            )
            .into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Windows Hmux Host did not become ready before the deadline".into());
        }
        thread::sleep(HOST_READY_POLL);
    }
}

fn seal_broker_standard_handles() -> Result<()> {
    for standard_handle in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let handle = unsafe { GetStdHandle(standard_handle) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            continue;
        }
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(format!(
                "Windows Hmux broker could not seal a standard handle before Host launch: {}",
                io::Error::last_os_error()
            )
            .into());
        }
    }
    Ok(())
}

fn host_is_ready(packet: &WindowsHostLaunchPacket) -> Result<bool> {
    let root = DiscoveryRoot::open(&packet.discovery_root)?;
    match root.find_manifest_by_session(&packet.workspace_id, &packet.session_id) {
        Ok(found) => Ok(matches!(
            found.manifest,
            DiscoveryManifest::Ready(ref ready)
                if ready.common.session_class == packet.session_class
                    && ready.common.provider_id == packet.provider_id
                    && ready.common.session_name == packet.session_name
                    && ready.common.claim_linkage.kickoff_action_id == packet.idempotency_key
                    && ready.endpoint.kind == LocalEndpointKind::WindowsNamedPipe
        )),
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound)
        | Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery { .. }) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestGuardianCutPhase {
    HostStartingPublished,
    BeforeProviderSpawn,
    ProviderSpawnedBeforeCheckpoint,
}

impl TestGuardianCutPhase {
    const fn as_str(self) -> &'static str {
        match self {
            Self::HostStartingPublished => "host_starting_published",
            Self::BeforeProviderSpawn => "before_provider_spawn",
            Self::ProviderSpawnedBeforeCheckpoint => "provider_spawned_before_checkpoint",
        }
    }
}

#[cfg(debug_assertions)]
fn cut_host_at_guardian_boundary_for_test(phase: TestGuardianCutPhase) -> Result<()> {
    if env::var_os(TEST_GUARDIAN_CUT_PHASE_ENV).as_deref()
        != Some(std::ffi::OsStr::new(phase.as_str()))
    {
        return Ok(());
    }
    let marker = env::var_os(TEST_GUARDIAN_CUT_MARKER_ENV)
        .map(PathBuf::from)
        .ok_or("guardian cut marker is required")?;
    if !marker.is_absolute() {
        return Err("guardian cut marker must be absolute".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)?;
    file.write_all(phase.as_str().as_bytes())?;
    file.sync_all()?;
    // `process::exit` bypasses Rust destructors, matching an abrupt Host
    // failure. Windows still closes the Host's kernel handles, so a suspended
    // provider already assigned to its KILL_ON_JOB_CLOSE Job is terminated.
    std::process::exit(86);
}

#[cfg(not(debug_assertions))]
fn cut_host_at_guardian_boundary_for_test(_phase: TestGuardianCutPhase) -> Result<()> {
    Ok(())
}

#[cfg(all(feature = "terminal-state-stream", debug_assertions))]
fn pause_after_agent_prompt_wait_for_test(
    wait: Option<crate::agent_prompt_admission::AgentPromptWaitOutcome>,
) -> Result<()> {
    let Some(wait) = wait else {
        return Ok(());
    };
    if wait.not_written_reason(false).is_none() {
        return Ok(());
    }
    let Some(marker) = env::var_os(TEST_AGENT_PROMPT_POST_WAIT_MARKER_ENV).map(PathBuf::from)
    else {
        return Ok(());
    };
    let release = env::var_os(TEST_AGENT_PROMPT_POST_WAIT_RELEASE_ENV)
        .map(PathBuf::from)
        .ok_or("agent prompt post-wait test release is required")?;
    if !marker.is_absolute() || !release.is_absolute() {
        return Err("agent prompt post-wait test paths must be absolute".into());
    }
    let mut marker_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)?;
    marker_file.write_all(format!("{wait:?}").as_bytes())?;
    marker_file.sync_all()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !release.exists() {
        if Instant::now() >= deadline {
            return Err("agent prompt post-wait test release timed out".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(all(feature = "terminal-state-stream", not(debug_assertions)))]
fn pause_after_agent_prompt_wait_for_test(
    _wait: Option<crate::agent_prompt_admission::AgentPromptWaitOutcome>,
) -> Result<()> {
    Ok(())
}

fn run_host(packet: WindowsHostLaunchPacket) -> Result<()> {
    let host_process = process_proof(std::process::id())?;
    let host_nonce = Uuid::new_v4().simple().to_string();
    let host_instance_id = format!("host_{host_nonce}");
    let runner_instance = format!("runner_{}", Uuid::new_v4().simple());
    let terminal_epoch = format!("terminal_{}", Uuid::new_v4().simple());
    let fence = SessionFence {
        workspace_id: packet.workspace_id.clone(),
        session_id: packet.session_id.clone(),
        runner_principal: "local-user".to_string(),
        runner_instance: runner_instance.clone(),
        channel_epoch: 1,
        host_instance_id: host_instance_id.clone(),
        terminal_epoch: terminal_epoch.clone(),
    };
    #[cfg(feature = "terminal-state-stream")]
    let launched_agent = direct_launch_agent(&packet.provider_id, &packet.provider_program);
    #[cfg(feature = "terminal-state-stream")]
    let process_observed_agent_prompt = launched_agent.is_some();
    #[cfg(not(feature = "terminal-state-stream"))]
    let process_observed_agent_prompt = false;
    let mut capabilities = advertised_capabilities();
    match packet.session_class {
        SessionClass::Standalone => {
            capabilities.push(STANDALONE_TERMINATION_CAPABILITY.to_string());
        }
        SessionClass::Managed => {
            capabilities.extend(managed_host_capabilities(process_observed_agent_prompt));
        }
    }
    let capabilities = managed_create_failure::effective_host_capabilities(capabilities);
    let common = ManifestCommon {
        schema_version: 1,
        host_build_version: HOST_BUILD_ID.to_string(),
        supported_protocol: VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        },
        capabilities,
        lifetime: HostLifetimeIdentity {
            workspace_id: packet.workspace_id.clone(),
            session_id: packet.session_id.clone(),
            runner_principal: "local-user".to_string(),
            runner_instance: runner_instance.clone(),
            channel_epoch: 1,
        },
        host_instance_id,
        provider_id: packet.provider_id.clone(),
        runtime_context: hmux_host::local_protocol::RuntimeContext {
            runtime_host: Some(windows_host_name()),
            worktree_alias: None,
            branch: None,
        },
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: packet.idempotency_key.clone(),
        },
        host_process: host_process.clone(),
        created_unix_ms: unix_time_ms(),
        session_class: packet.session_class,
        session_name: packet.session_name.clone(),
        retirement_policy: packet.retirement_policy,
        launch_program: launch_program_label(&packet.provider_program),
    };
    let root = DiscoveryRoot::create(&packet.discovery_root)?;
    let discovery = root.session(DiscoveryKey::new(
        packet.workspace_id.clone(),
        packet.session_id.clone(),
        runner_instance,
        1,
    )?)?;
    let lifetime_lock = discovery.acquire_lifetime_lock()?;
    discovery.publish_starting(
        &lifetime_lock,
        StartingManifest {
            common: common.clone(),
            starting_unix_ms: unix_time_ms(),
        },
    )?;
    cut_host_at_guardian_boundary_for_test(TestGuardianCutPhase::HostStartingPublished)?;

    let pipe_address = PathBuf::from(format!(r"\\.\pipe\hmux-{}", &host_nonce[..24]));
    let listener = WindowsNamedPipeListener::bind(&pipe_address)?;
    let listener_interrupt = listener.interrupt_handle();
    let endpoint = LocalEndpoint {
        kind: LocalEndpointKind::WindowsNamedPipe,
        address: pipe_address.to_string_lossy().into_owned(),
    };
    let capability_token = Uuid::new_v4().to_string();
    let environment = provider_environment(&packet, &fence);
    cut_host_at_guardian_boundary_for_test(TestGuardianCutPhase::BeforeProviderSpawn)?;
    let suspended = ConPtyProcess::spawn_suspended(
        &packet.provider_program,
        &packet.provider_args,
        &packet.provider_cwd,
        &environment,
        packet.initial_rows,
        packet.initial_columns,
    )?;
    let provider_process = process_proof(suspended.process().process_id())?;
    cut_host_at_guardian_boundary_for_test(TestGuardianCutPhase::ProviderSpawnedBeforeCheckpoint)?;
    if packet.session_class == SessionClass::Managed {
        let idempotency_key = packet
            .idempotency_key
            .as_deref()
            .ok_or("managed Host lost its create idempotency key")?;
        let generation = ManagedStartingGeneration::new(
            idempotency_key,
            ProcessDescriptor {
                process_id: host_process.process_id,
                start_marker: host_process.start_marker.clone(),
            },
            ProcessDescriptor {
                process_id: provider_process.process_id,
                start_marker: provider_process.start_marker.clone(),
            },
            ManagedCreateGenerationFence::new(
                &fence.runner_principal,
                &fence.runner_instance,
                fence.channel_epoch,
                &fence.host_instance_id,
                &fence.terminal_epoch,
            )?,
            endpoint.clone(),
            capability_token.clone(),
            packet.conversation_identity.clone(),
        )?
        .with_provider_containment(
            ManagedStartingProviderContainment::WindowsKillOnJobCloseV1,
        )?;
        managed_create_ledger::checkpoint_starting_generation_exact(
            &packet.discovery_root,
            &packet.workspace_id,
            &packet.session_id,
            idempotency_key,
            generation,
        )?;
    }
    let spawned = suspended.resume()?;
    let provider = Arc::new(spawned.process);
    let mut session_host = SessionHost::new_with_default_colors(
        fence.clone(),
        provider_process.clone(),
        packet.initial_rows,
        packet.initial_columns,
        terminal_replay_limits(),
        1,
        packet.terminal_default_colors,
    )?;
    #[cfg(feature = "terminal-state-stream")]
    if let Some(agent) = launched_agent {
        session_host.observe_agent_identity(
            &fence,
            AgentIdentityObservation::process_inspection(Some(agent)),
        )?;
        session_host.observe_agent_runtime_state(
            &fence,
            AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProcessLifecycle),
        )?;
    }
    session_host.observe_working_directory(
        &fence,
        WorkingDirectoryObservation::new(
            packet.provider_cwd.to_string_lossy(),
            hmux_host::local_protocol::WorkingDirectorySource::LaunchFallback,
        ),
    )?;
    session_host.observe_execution_location(&fence, ExecutionLocationObservation::local())?;
    if let Some(identity) = packet.conversation_identity.as_ref() {
        session_host.observe_provider_conversation_identity(
            &fence,
            ProviderConversationIdentityObservation::new(
                identity.provider_id(),
                identity.conversation_id(),
                hmux_host::local_protocol::ProviderConversationIdentitySource::LaunchRequest,
            ),
        )?;
    }
    let (termination_tx, termination_rx) = mpsc::sync_channel(1);
    let state = Arc::new(WindowsServerState {
        common: common.clone(),
        fence: fence.clone(),
        host_process,
        host: Mutex::new(session_host),
        #[cfg(feature = "terminal-state-stream")]
        agent_prompt_admission:
            agent_prompt_admission::AgentPromptAdmissionSignal::default(),
        provider: Arc::clone(&provider),
        controller_submit: Mutex::new(crate::controller_input::SubmitScanner::default()),
        subscribers: Mutex::new(HashMap::new()),
        controller: Mutex::new(None),
        launch_owner_proof: Mutex::new(packet.launch_owner_proof.clone()),
        next_client: AtomicU64::new(1),
        #[cfg(feature = "terminal-state-stream")]
        next_terminal_state_record: AtomicU64::new(1),
        #[cfg(feature = "terminal-state-stream")]
        structured_publication: Mutex::new(()),
        #[cfg(feature = "terminal-state-stream")]
        terminal_surfaces: Mutex::new(HashMap::new()),
        stopping: AtomicBool::new(false),
        termination_tx,
    });
    let ready = ReadyManifest {
        common: common.clone(),
        provider_process,
        terminal_epoch,
        ready_output_seq: 0,
        endpoint: endpoint.clone(),
        capability_token: capability_token.clone(),
        ready_unix_ms: unix_time_ms(),
    };
    let accept_state = Arc::clone(&state);
    let accept_token = capability_token.clone();
    let accept_thread = thread::spawn(move || accept_loop(listener, accept_state, accept_token));
    let output_state = Arc::clone(&state);
    let output_thread = thread::spawn(move || output_loop(spawned.output, output_state));
    discovery.publish_ready(&lifetime_lock, ready)?;

    let mut terminated = false;
    let mut next_agent_runtime_expiry = Instant::now() + AGENT_RUNTIME_EXPIRY_POLL;
    let exit_code = loop {
        if termination_rx.try_recv().is_ok() {
            terminated = true;
            provider.terminate_job()?;
        }
        if let Some(code) = provider.wait_timeout(PROVIDER_WAIT_POLL)? {
            state.stopping.store(true, Ordering::Release);
            #[cfg(feature = "terminal-state-stream")]
            state.agent_prompt_admission.notify();
            break code;
        }
        let now = Instant::now();
        if now >= next_agent_runtime_expiry {
            state.expire_agent_runtime_state(now)?;
            next_agent_runtime_expiry = now + AGENT_RUNTIME_EXPIRY_POLL;
        }
    };
    provider.terminate_job()?;
    provider.wait_for_job_exit(PROVIDER_JOB_EXIT_TIMEOUT)?;
    provider.close_console()?;
    output_thread
        .join()
        .map_err(|_| "Windows Hmux output worker panicked")??;

    let status = ProviderExitStatus {
        exit_code: Some(exit_code as i32),
        platform_status: Some(format!("windows_exit_code_{exit_code}")),
        kind: if terminated {
            ProviderExitKind::Signaled
        } else if exit_code == 0 {
            ProviderExitKind::Normal
        } else {
            ProviderExitKind::ProviderError
        },
        reason: if terminated {
            "provider Job terminated by Host".to_string()
        } else {
            format!("provider exited with Windows status {exit_code}")
        },
        created_unix_ms: unix_time_ms(),
        failure: None,
    };
    let completed = lock(&state.host)?.complete_provider(&fence, status)?;
    #[cfg(feature = "terminal-state-stream")]
    state
        .agent_prompt_admission
        .seal_and_wait_for_publications()?;
    state.broadcast_control(FrameBody::Exit(completed.tombstone.exit.clone()));
    listener_interrupt.interrupt();
    let _ = accept_thread.join();
    discovery.publish_exited(
        &lifetime_lock,
        ExitedManifest {
            common,
            tombstone: Box::new(completed.tombstone),
            endpoint,
            capability_token,
            exited_unix_ms: unix_time_ms(),
        },
    )?;
    if terminated && packet.session_class == SessionClass::Standalone {
        // `terminate_standalone` observes this exact Exited generation before
        // treating retirement as complete. Keep it authoritative for the same
        // grace period as the Unix Host instead of exposing a session
        // directory whose current manifest has already disappeared.
        thread::sleep(EXIT_GRACE);
        let exited_generation = discovery.read_manifest()?.generation();
        discovery.retire_exited_current(&lifetime_lock, &exited_generation)?;
    }
    Ok(())
}

enum WindowsOutboundRecord {
    Control(Box<FrameBody>),
    #[cfg(feature = "terminal-state-stream")]
    TerminalStateBatch(Vec<Vec<u8>>),
}

#[derive(Clone)]
struct WindowsSubscriber {
    sender: mpsc::SyncSender<WindowsOutboundRecord>,
    interrupt: Arc<dyn TransportInterrupt>,
    #[cfg(feature = "terminal-state-stream")]
    surface: Option<Arc<Mutex<WindowsTerminalSurface>>>,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Copy)]
struct WindowsTerminalSurfaceState {
    geometry: Option<TerminalSurfaceGeometry>,
    geometry_generation: u64,
    default_colors: Option<TerminalDefaultColors>,
}

#[cfg(feature = "terminal-state-stream")]
enum PreparedStructuredInput {
    StaleTerminalEpoch,
    StaleGeometryGeneration,
    Valid(crate::input_transaction::InputAdmission),
}

#[cfg(feature = "terminal-state-stream")]
impl PreparedStructuredInput {
    fn admission(&self) -> Option<&crate::input_transaction::InputAdmission> {
        match self {
            Self::Valid(admission) => Some(admission),
            Self::StaleTerminalEpoch | Self::StaleGeometryGeneration => None,
        }
    }
}

struct WindowsServerState {
    common: ManifestCommon,
    fence: SessionFence,
    host_process: ProcessProof,
    host: Mutex<SessionHost>,
    #[cfg(feature = "terminal-state-stream")]
    agent_prompt_admission: agent_prompt_admission::AgentPromptAdmissionSignal,
    provider: Arc<ConPtyProcess>,
    controller_submit: Mutex<crate::controller_input::SubmitScanner>,
    subscribers: Mutex<HashMap<u64, WindowsSubscriber>>,
    controller: Mutex<Option<u64>>,
    launch_owner_proof: Mutex<Option<String>>,
    next_client: AtomicU64,
    #[cfg(feature = "terminal-state-stream")]
    next_terminal_state_record: AtomicU64,
    #[cfg(feature = "terminal-state-stream")]
    structured_publication: Mutex<()>,
    #[cfg(feature = "terminal-state-stream")]
    terminal_surfaces: Mutex<HashMap<u64, WindowsTerminalSurfaceState>>,
    stopping: AtomicBool,
    termination_tx: mpsc::SyncSender<()>,
}

impl WindowsServerState {
    fn apply_pty_input_transaction(
        &self,
        host: &mut SessionHost,
        input: crate::input_transaction::PtyInput<'_>,
        input_effect: ControllerInputEffect,
        admission: crate::input_transaction::InputAdmission,
    ) -> Result<
        std::result::Result<
            crate::input_transaction::InputTransaction,
            crate::input_transaction::InputTransactionFailure,
        >,
    > {
        let mut controller_submit = lock(&self.controller_submit)?;
        let transaction = crate::input_transaction::apply_input_transaction(
            host,
            &self.fence,
            &mut controller_submit,
            input,
            input_effect,
            admission,
            |bytes| {
                let (written, outcome) = self.provider.write_with_progress(bytes);
                let outcome = outcome.map_err(|_| {
                    if written == 0 && self.stopping.load(Ordering::Acquire) {
                        OperationReceiptReason::HostExiting
                    } else {
                        OperationReceiptReason::PtyWriteFailed
                    }
                });
                crate::input_transaction::PtyWriteOutcome::from_progress(
                    bytes.len(),
                    written,
                    outcome,
                )
            },
        );
        #[cfg(feature = "terminal-state-stream")]
        self.agent_prompt_admission.notify();
        Ok(transaction)
    }

    fn expire_agent_runtime_state(&self, now: Instant) -> Result<()> {
        let runtime_state = {
            let mut host = lock(&self.host)?;
            host.expire_agent_runtime_state(&self.fence, now)?
        };
        if let Some(runtime_state) = runtime_state {
            self.broadcast_control(FrameBody::AgentRuntimeState(runtime_state));
            #[cfg(feature = "terminal-state-stream")]
            self.agent_prompt_admission.notify();
        }
        Ok(())
    }

    fn broadcast_control(&self, body: FrameBody) {
        if let Ok(subscribers) = self.subscribers.lock() {
            for subscriber in subscribers.values() {
                if subscriber
                    .sender
                    .try_send(WindowsOutboundRecord::Control(Box::new(body.clone())))
                    .is_err()
                {
                    subscriber.interrupt.interrupt();
                }
            }
        }
    }

    fn broadcast_classic_output(&self, body: FrameBody) {
        if let Ok(subscribers) = self.subscribers.lock() {
            for subscriber in subscribers.values() {
                #[cfg(feature = "terminal-state-stream")]
                if subscriber.surface.is_some() {
                    continue;
                }
                if subscriber
                    .sender
                    .try_send(WindowsOutboundRecord::Control(Box::new(body.clone())))
                    .is_err()
                {
                    subscriber.interrupt.interrupt();
                }
            }
        }
    }

    fn enqueue(&self, client_id: u64, record: WindowsOutboundRecord) -> Result<()> {
        let subscriber = lock(&self.subscribers)?.get(&client_id).cloned();
        let Some(subscriber) = subscriber else {
            return Err("Windows Hmux subscriber is no longer attached".into());
        };
        match subscriber.sender.try_send(record) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_))
            | Err(mpsc::TrySendError::Disconnected(_)) => {
                subscriber.interrupt.interrupt();
                Err("Windows Hmux subscriber output backlog is full".into())
            }
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn apply_structured_upstream(&self, client_id: u64, payload: &[u8]) -> Result<()> {
        let surface = lock(&self.subscribers)?
            .get(&client_id)
            .and_then(|subscriber| subscriber.surface.as_ref())
            .cloned()
            .ok_or("structured terminal surface is no longer attached")?;
        let upstream = lock(&surface)?.decode_upstream(payload, &self.common.provider_id)?;
        let _agent_prompt_publication = match &upstream {
            StructuredUpstream::Input { admission, .. } if admission.agent_prompt().is_some() => {
                Some(self.agent_prompt_admission.begin_publication()?)
            }
            StructuredUpstream::Input { .. }
            | StructuredUpstream::ViewportIntent { .. }
            | StructuredUpstream::Unauthorized(_) => None,
        };
        let input_admission = match &upstream {
            StructuredUpstream::Input {
                record_id,
                record,
                admission,
            } => Some(self.validated_input_admission(
                *record_id,
                record,
                admission.clone(),
            )?),
            StructuredUpstream::ViewportIntent { .. }
            | StructuredUpstream::Unauthorized(_) => None,
        };
        let agent_prompt_wait = input_admission
            .as_ref()
            .and_then(PreparedStructuredInput::admission)
            .map(|admission| self.wait_for_agent_prompt(admission))
            .transpose()?
            .flatten();
        pause_after_agent_prompt_wait_for_test(agent_prompt_wait)?;
        let _publication = lock(&self.structured_publication)?;
        match upstream {
            StructuredUpstream::Input {
                record_id, record, ..
            } => {
                let (receipt, publish_viewport) = self.apply_structured_input(
                    client_id,
                    &surface,
                    record_id,
                    &record,
                    input_admission.expect("input record must carry prepared admission"),
                    agent_prompt_wait,
                )?;
                self.enqueue_terminal_record(client_id, receipt)?;
                if publish_viewport {
                    self.publish_structured_viewports_locked()?;
                }
            }
            StructuredUpstream::ViewportIntent { record } => {
                let receipt = self.apply_structured_viewport(client_id, &surface, &record)?;
                if let Some(receipt) = receipt {
                    self.enqueue_terminal_record(client_id, receipt)?;
                }
                self.publish_structured_viewports_locked()?;
            }
            StructuredUpstream::Unauthorized(required_capability) => {
                self.enqueue(
                    client_id,
                    WindowsOutboundRecord::Control(Box::new(FrameBody::Error(ErrorFrame {
                        origin_code: None,
                        code: ErrorCode::AuthorizationDenied,
                        message: "structured terminal operation is not authorized".into(),
                        retry: RetryPosture::Never,
                        required_capability: Some(required_capability.into()),
                        supported_versions: None,
                        in_reply_to_request_id: None,
                    }))),
                )?;
            }
        }
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn validated_input_admission(
        &self,
        record_id: u64,
        record: &terminal_state_protocol::TerminalStateRecord,
        admission: crate::input_transaction::InputAdmission,
    ) -> Result<PreparedStructuredInput> {
        use terminal_state_protocol::{InputIngressAuthority, input_intent, terminal_state_record};

        if record.terminal_epoch != self.fence.terminal_epoch {
            return Ok(PreparedStructuredInput::StaleTerminalEpoch);
        }

        let Some(terminal_state_record::Body::InputIntent(intent)) = record.body.as_ref() else {
            return Err("structured input record lost its typed intent".into());
        };
        if matches!(
            intent.intent.as_ref(),
            Some(input_intent::Intent::Resize(resize))
                if resize.geometry_generation != record_id
        ) {
            return Ok(PreparedStructuredInput::StaleGeometryGeneration);
        }
        terminal_state_protocol::validate_input_ingress(
            record,
            &InputIngressAuthority {
                terminal_epoch: &self.fence.terminal_epoch,
                geometry_generation: record_id,
            },
        )?;
        Ok(PreparedStructuredInput::Valid(admission))
    }

    #[cfg(feature = "terminal-state-stream")]
    fn wait_for_agent_prompt(
        &self,
        admission: &crate::input_transaction::InputAdmission,
    ) -> Result<Option<crate::agent_prompt_admission::AgentPromptWaitOutcome>> {
        use hmux_host::terminal_replay::AgentPromptAdmission;

        let Some((target, wait)) = admission.agent_prompt() else {
            return Ok(None);
        };
        self.agent_prompt_admission
            .wait(wait, || {
                if self.stopping.load(Ordering::Acquire) {
                    return Ok(AgentPromptAdmission::Refused);
                }
                let host = lock(&self.host)?;
                Ok(host
                    .agent_prompt_admission(&self.fence, target)
                    .unwrap_or(AgentPromptAdmission::Refused))
            })
            .map(Some)
    }

    #[cfg(feature = "terminal-state-stream")]
    fn apply_structured_input(
        &self,
        client_id: u64,
        surface: &Arc<Mutex<WindowsTerminalSurface>>,
        record_id: u64,
        record: &terminal_state_protocol::TerminalStateRecord,
        admission: PreparedStructuredInput,
        agent_prompt_wait: Option<crate::agent_prompt_admission::AgentPromptWaitOutcome>,
    ) -> Result<(terminal_state_protocol::TerminalStateRecord, bool)> {
        use terminal_state_protocol::{
            InputRefusalReason, ResizeFailureReason, ResizeRefusalReason, input_intent,
            terminal_state_record,
        };

        let mut host = lock(&self.host)?;
        if self.stopping.load(Ordering::Acquire) {
            return Ok((
                windows_terminal::terminal_record(
                    &host,
                    &self.fence,
                    windows_terminal::input_refused(record_id, InputRefusalReason::HostExiting),
                ),
                false,
            ));
        }
        let admission = match admission {
            PreparedStructuredInput::StaleTerminalEpoch => {
                let receipt = windows_terminal::terminal_record(
                    &host,
                    &self.fence,
                    windows_terminal::input_refused(
                        record_id,
                        InputRefusalReason::StaleTerminalEpoch,
                    ),
                );
                return Ok((receipt, false));
            }
            PreparedStructuredInput::StaleGeometryGeneration => {
                let receipt = windows_terminal::terminal_record(
                    &host,
                    &self.fence,
                    windows_terminal::resize_refused(
                        record_id,
                        ResizeRefusalReason::StaleGeometryGeneration,
                    ),
                );
                return Ok((receipt, false));
            }
            PreparedStructuredInput::Valid(admission) => admission,
        };
        let Some(terminal_state_record::Body::InputIntent(intent)) = record.body.as_ref() else {
            return Err("structured input record lost its typed intent".into());
        };
        let exact_host_exiting = admission.agent_prompt().is_some_and(|(target, _)| {
            matches!(
                host.agent_prompt_admission(&self.fence, target),
                Err(hmux_host::session_host::SessionHostError::SessionExited
                    | hmux_host::session_host::SessionHostError::FenceMismatch)
            )
        });
        if let Some(reason) = agent_prompt_wait.and_then(|wait| {
            wait.not_written_reason(
                self.stopping.load(Ordering::Acquire) || exact_host_exiting,
            )
        }) {
            let receipt = windows_terminal::terminal_record(
                &host,
                &self.fence,
                windows_terminal::input_not_written(record_id, reason, None),
            );
            return Ok((receipt, false));
        }

        let Some(input) = intent.intent.as_ref() else {
            return Err("structured input intent is empty".into());
        };
        if let input_intent::Intent::Resize(resize) = input {
            let rows = match u16::try_from(resize.rows).ok().filter(|rows| *rows != 0) {
                Some(rows) => rows,
                None => {
                    let receipt = windows_terminal::terminal_record(
                        &host,
                        &self.fence,
                        windows_terminal::resize_refused(
                            record_id,
                            ResizeRefusalReason::InvalidTerminalDimensions,
                        ),
                    );
                    return Ok((receipt, false));
                }
            };
            let columns = match u16::try_from(resize.columns)
                .ok()
                .filter(|columns| *columns != 0)
            {
                Some(columns) => columns,
                None => {
                    let receipt = windows_terminal::terminal_record(
                        &host,
                        &self.fence,
                        windows_terminal::resize_refused(
                            record_id,
                            ResizeRefusalReason::InvalidTerminalDimensions,
                        ),
                    );
                    return Ok((receipt, false));
                }
            };
            let selected = {
                let mut surfaces = lock(&self.terminal_surfaces)?;
                let current = surfaces
                    .get_mut(&client_id)
                    .ok_or("structured terminal geometry is no longer attached")?;
                if record_id <= current.geometry_generation {
                    let receipt = windows_terminal::terminal_record(
                        &host,
                        &self.fence,
                        windows_terminal::resize_refused(
                            record_id,
                            ResizeRefusalReason::StaleGeometryGeneration,
                        ),
                    );
                    return Ok((receipt, false));
                }
                current.geometry_generation = record_id;
                surfaces
                    .iter()
                    .filter_map(|(candidate_id, state)| {
                        if *candidate_id == client_id {
                            Some(TerminalSurfaceGeometry { rows, columns })
                        } else {
                            state.geometry
                        }
                    })
                    .fold(
                        TerminalSurfaceGeometry { rows, columns },
                        TerminalSurfaceGeometry::fit_surfaces,
                    )
            };
            let outcome = if self.stopping.load(Ordering::Acquire) {
                Err(OperationReceiptReason::HostExiting)
            } else {
                let result = (|| -> Result<()> {
                    if host.current_dimensions() != (selected.rows, selected.columns) {
                        let generation = host.controller_generation();
                        let prepared = host.prepare_resize(
                            &self.fence,
                            generation,
                            selected.rows,
                            selected.columns,
                        )?;
                        self.provider.resize(selected.rows, selected.columns)?;
                        prepared.commit()?;
                    }
                    lock(surface)?.set_viewport_rows(&mut host, &self.fence, rows)?;
                    Ok(())
                })();
                result.map_err(|error| match error.downcast_ref::<SessionHostError>() {
                    Some(SessionHostError::SessionExited) => OperationReceiptReason::HostExiting,
                    Some(SessionHostError::TerminalReplay(_)) => {
                        OperationReceiptReason::InvalidTerminalDimensions
                    }
                    _ => OperationReceiptReason::PlatformResizeFailed,
                })
            };
            let publish_viewport = outcome.is_ok();
            let body = match outcome {
                Ok(()) => {
                    lock(&self.terminal_surfaces)?
                        .get_mut(&client_id)
                        .ok_or("structured terminal geometry is no longer attached")?
                        .geometry = Some(TerminalSurfaceGeometry { rows, columns });
                    windows_terminal::resize_applied(record_id, selected.rows, selected.columns)
                }
                Err(OperationReceiptReason::InvalidTerminalDimensions) => {
                    windows_terminal::resize_refused(
                        record_id,
                        ResizeRefusalReason::InvalidTerminalDimensions,
                    )
                }
                Err(OperationReceiptReason::HostExiting) => windows_terminal::resize_refused(
                    record_id,
                    ResizeRefusalReason::HostExiting,
                ),
                Err(_) => windows_terminal::resize_failed(
                    record_id,
                    ResizeFailureReason::PlatformResizeFailed,
                ),
            };
            return Ok((
                windows_terminal::terminal_record(&host, &self.fence, body),
                publish_viewport,
            ));
        }

        let input_effect = ControllerInputEffect::from_non_resize_structured(input)
            .ok_or("structured PTY input lost its non-resize semantic effect")?;
        let generation = host.controller_generation();
        if let Err(error) = host.admit_mutation(&self.fence, generation) {
            let reason = crate::input_transaction::input_operation_reason(&error);
            let detail = crate::input_transaction::input_operation_detail(&error);
            let body = windows_terminal::input_not_written(record_id, reason, detail);
            return Ok((
                windows_terminal::terminal_record(&host, &self.fence, body),
                false,
            ));
        }
        let transaction = match self.apply_pty_input_transaction(
            &mut host,
            crate::input_transaction::PtyInput::Structured(intent),
            input_effect,
            admission,
        )? {
            Ok(transaction) => transaction,
            Err(failure) => {
                let body = match failure.outcome() {
                    crate::input_transaction::InputTransactionOutcome::NotWritten(reason) => {
                        windows_terminal::input_not_written(record_id, reason, failure.detail())
                    }
                    crate::input_transaction::InputTransactionOutcome::Failed(reason) => {
                        windows_terminal::input_failed(record_id, reason, failure.detail())
                    }
                    crate::input_transaction::InputTransactionOutcome::Written => {
                        unreachable!("a transaction failure cannot report a completed write")
                    }
                };
                return Ok((
                    windows_terminal::terminal_record(&host, &self.fence, body),
                    false,
                ));
            }
        };
        let body = match transaction.outcome {
            crate::input_transaction::InputTransactionOutcome::Written => {
                windows_terminal::input_written(
                    record_id,
                    host.current_output_seq(),
                    transaction.admitted_agent_runtime_revision,
                )
            }
            crate::input_transaction::InputTransactionOutcome::NotWritten(reason) => {
                windows_terminal::input_not_written(record_id, reason, None)
            }
            crate::input_transaction::InputTransactionOutcome::Failed(reason) => {
                windows_terminal::input_failed(record_id, reason, None)
            }
        };
        let receipt = windows_terminal::terminal_record(&host, &self.fence, body);
        drop(host);
        if let Some(runtime_state) = transaction.runtime_state {
            self.broadcast_control(FrameBody::AgentRuntimeState(runtime_state));
        }
        Ok((receipt, false))
    }

    #[cfg(feature = "terminal-state-stream")]
    fn apply_structured_viewport(
        &self,
        client_id: u64,
        surface: &Arc<Mutex<WindowsTerminalSurface>>,
        record: &terminal_state_protocol::DecodedRecord,
    ) -> Result<Option<terminal_state_protocol::TerminalStateRecord>> {
        use hmux_host::terminal_replay::WheelIntentRoute;

        let mut host = lock(&self.host)?;
        if self.stopping.load(Ordering::Acquire) {
            let Some(_) = windows_terminal::wheel_intent_seq(record) else {
                return Ok(None);
            };
            return Ok(Some(windows_terminal::terminal_record(
                &host,
                &self.fence,
                windows_terminal::wheel_refused(record.metadata.record_id),
            )));
        }
        let application = lock(surface)?.apply_viewport(&mut host, &self.fence, record)?;
        if let Some(colors) = windows_terminal::terminal_default_colors(record)? {
            let selected = {
                let surfaces = lock(&self.terminal_surfaces)?;
                surfaces
                    .iter()
                    .filter_map(|(candidate_id, state)| {
                        if *candidate_id == client_id {
                            Some((*candidate_id, colors))
                        } else {
                            state
                                .default_colors
                                .map(|colors| (*candidate_id, colors))
                        }
                    })
                    .max_by_key(|(candidate_id, _)| *candidate_id)
                    .map(|(_, colors)| colors)
                    .unwrap_or(colors)
            };
            host.set_terminal_default_colors(&self.fence, selected)?;
            lock(&self.terminal_surfaces)?
                .get_mut(&client_id)
                .ok_or("structured terminal surface is no longer attached")?
                .default_colors = Some(colors);
        }
        let Some(intent_seq) = windows_terminal::wheel_intent_seq(record) else {
            return Ok(None);
        };
        let route = application
            .wheel_route
            .ok_or("structured wheel intent did not select a terminal sink")?;
        let pty_written = match route {
            WheelIntentRoute::Viewport => true,
            WheelIntentRoute::Pty => {
                let generation = host.controller_generation();
                if host.admit_mutation(&self.fence, generation).is_err() {
                    false
                } else {
                    match self.apply_pty_input_transaction(
                        &mut host,
                        crate::input_transaction::PtyInput::Bytes(&application.pty_bytes),
                        ControllerInputEffect::ControlOnly,
                        crate::input_transaction::InputAdmission::Ordinary,
                    )? {
                        Ok(transaction) => transaction.outcome.is_written(),
                        Err(_) => false,
                    }
                }
            }
        };
        Ok(Some(windows_terminal::terminal_record(
            &host,
            &self.fence,
            windows_terminal::wheel_receipt(
                record.metadata.record_id,
                intent_seq,
                route,
                pty_written,
            ),
        )))
    }

    #[cfg(feature = "terminal-state-stream")]
    fn enqueue_terminal_record(
        &self,
        client_id: u64,
        record: terminal_state_protocol::TerminalStateRecord,
    ) -> Result<()> {
        let subscriber = lock(&self.subscribers)?
            .get(&client_id)
            .and_then(|subscriber| subscriber.surface.as_ref())
            .cloned()
            .ok_or("structured terminal surface is no longer attached")?;
        let mut records = lock(&subscriber)?.prepare_record(record)?;
        windows_terminal_encoding::sequence_prepared_structured_record(
            &self.next_terminal_state_record,
            &mut records,
        )?;
        self.enqueue(
            client_id,
            WindowsOutboundRecord::TerminalStateBatch(records),
        )
    }

    #[cfg(feature = "terminal-state-stream")]
    fn publish_structured_viewports_locked(&self) -> Result<()> {
        let subscribers = lock(&self.subscribers)?
            .iter()
            .filter_map(|(client_id, subscriber)| {
                subscriber
                    .surface
                    .as_ref()
                    .map(|surface| (*client_id, Arc::clone(surface)))
            })
            .collect::<Vec<_>>();
        let mut deliveries = Vec::new();
        let mut failed = Vec::new();
        {
            let mut host = lock(&self.host)?;
            for (client_id, surface) in subscribers {
                let captured = lock(&surface)
                    .and_then(|mut surface| surface.capture(&mut host, &self.fence));
                match captured {
                    Ok(Some(mut records)) => {
                        if windows_terminal_encoding::sequence_prepared_structured_record(
                            &self.next_terminal_state_record,
                            &mut records,
                        )
                        .is_ok()
                        {
                            deliveries.push((client_id, records));
                        } else {
                            failed.push(client_id);
                        }
                    }
                    Ok(None) => {}
                    Err(_) => failed.push(client_id),
                }
            }
        }
        for (client_id, records) in deliveries {
            if self
                .enqueue(
                    client_id,
                    WindowsOutboundRecord::TerminalStateBatch(records),
                )
                .is_err()
            {
                failed.push(client_id);
            }
        }
        for client_id in failed {
            if let Some(subscriber) = lock(&self.subscribers)?.get(&client_id) {
                subscriber.interrupt.interrupt();
            }
        }
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn detach_terminal_surface(
        &self,
        client_id: u64,
        surface: Arc<Mutex<WindowsTerminalSurface>>,
    ) {
        let Ok(_publication) = self.structured_publication.lock() else {
            return;
        };
        let removed = self
            .terminal_surfaces
            .lock()
            .ok()
            .and_then(|mut surfaces| surfaces.remove(&client_id));
        if let Ok(mut host) = self.host.lock() {
            if let Ok(mut surface) = surface.lock() {
                let _ = surface.detach(&mut host, &self.fence);
            }
        }
        let Some(removed) = removed else {
            return;
        };
        if removed.default_colors.is_some() {
            let selected = self.terminal_surfaces.lock().ok().and_then(|surfaces| {
                surfaces
                    .iter()
                    .filter_map(|(candidate_id, state)| {
                        state
                            .default_colors
                            .map(|colors| (*candidate_id, colors))
                    })
                    .max_by_key(|(candidate_id, _)| *candidate_id)
                    .map(|(_, colors)| colors)
            });
            if let Some(colors) = selected {
                if let Ok(mut host) = self.host.lock() {
                    let _ = host.set_terminal_default_colors(&self.fence, colors);
                }
            }
        }
        let selected_geometry = self.terminal_surfaces.lock().ok().and_then(|surfaces| {
            surfaces
                .values()
                .filter_map(|surface| surface.geometry)
                .reduce(TerminalSurfaceGeometry::fit_surfaces)
        });
        if let Some(TerminalSurfaceGeometry { rows, columns }) = selected_geometry {
            if let Ok(mut host) = self.host.lock() {
                if host.current_dimensions() != (rows, columns) {
                    let generation = host.controller_generation();
                    if let Ok(prepared) =
                        host.prepare_resize(&self.fence, generation, rows, columns)
                    {
                        if self.provider.resize(rows, columns).is_ok() {
                            let _ = prepared.commit();
                        }
                    }
                }
            }
        }
        let _ = self.publish_structured_viewports_locked();
    }
}

fn accept_loop(
    mut listener: WindowsNamedPipeListener,
    state: Arc<WindowsServerState>,
    token: String,
) {
    while !state.stopping.load(Ordering::Acquire) {
        let accepted = match listener.accept_before(Some(Instant::now() + Duration::from_millis(250))) {
            Ok(accepted) => accepted,
            Err(TransportError::FirstByteTimeout) => continue,
            Err(TransportError::Interrupted) => break,
            Err(_) if state.stopping.load(Ordering::Acquire) => break,
            Err(_) => continue,
        };
        let codec = FrameCodec::new(FrameLimits::default());
        let (first, attestable) = match accepted.read_first_frame_before(
            &codec,
            Instant::now() + CLIENT_ADMISSION_TIMEOUT,
            FRAME_COMPLETION_TIMEOUT,
        ) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let scope = SessionScope::new(
            state.fence.workspace_id.clone(),
            state.fence.session_id.clone(),
            state.fence.host_instance_id.clone(),
        );
        let verified = match attestable.verify_same_user(scope) {
            Ok(verified) => verified,
            Err(_) => continue,
        };
        let (reader, writer, interrupt, _peer) = verified.into_parts();
        let interrupt: Arc<dyn TransportInterrupt> = interrupt;
        let transport = ClientTransport::new(reader, writer, interrupt);
        let client_state = Arc::clone(&state);
        let client_token = token.clone();
        thread::spawn(move || {
            let _ = serve_client(first, transport, client_state, &client_token);
        });
    }
}

fn serve_client(
    first: hmux_host::local_protocol::DecodedFrame,
    mut transport: ClientTransport,
    state: Arc<WindowsServerState>,
    token: &str,
) -> Result<()> {
    let frame = first.into_valid()?;
    let FrameBody::Hello(hello) = frame.body else {
        return Err("first Hmux frame must be hello".into());
    };
    let writer = transport.writer();
    let codec = FrameCodec::new(FrameLimits::default());
    if hello.capability_token != token || hello.expected_fence != state.fence {
        send_body(
            &codec,
            &writer,
            1,
            error_body(
                ErrorCode::AuthorizationDenied,
                "Hmux attach authorization was denied",
                RetryPosture::Never,
            ),
        )?;
        return Ok(());
    }
    let Some(selected_version) = state
        .common
        .supported_protocol
        .select_highest(hello.supported_versions)
    else {
        send_body(
            &codec,
            &writer,
            1,
            error_body(
                ErrorCode::UnsupportedProtocolVersion,
                "No supported Hmux protocol version",
                RetryPosture::Never,
            ),
        )?;
        return Ok(());
    };
    if state.stopping.load(Ordering::Acquire) {
        send_body(
            &codec,
            &writer,
            1,
            error_body(
                ErrorCode::SessionExited,
                "Hmux Host is terminating",
                RetryPosture::Never,
            ),
        )?;
        return Ok(());
    }
    #[cfg(feature = "terminal-state-stream")]
    if !terminal_capability_request_is_consistent(&hello.requested_capabilities) {
        send_body(
            &codec,
            &writer,
            1,
            error_body(
                ErrorCode::UnsupportedCapability,
                "structured terminal capabilities require terminal_state_binary_v1 and terminal_viewport_projection_v1",
                RetryPosture::Never,
            ),
        )?;
        return Ok(());
    }

    let client_id = state.next_client.fetch_add(1, Ordering::Relaxed);
    let mut owns_control = false;
    let managed = state.common.session_class == SessionClass::Managed;
    let managed_stop_requested = hello
        .requested_capabilities
        .iter()
        .any(|capability| capability == MANAGED_PROVIDER_STOP_CAPABILITY);
    let agent_state_report_requested = hello
        .requested_capabilities
        .iter()
        .any(|capability| capability == AGENT_STATE_REPORT_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let managed_agent_prompt_selection = select_managed_agent_prompt_capability(
        hello.requested_mode,
        managed,
        &state.common.capabilities,
        &hello.requested_capabilities,
    );
    #[cfg(not(feature = "terminal-state-stream"))]
    let managed_agent_prompt_selection = None;
    let managed_agent_prompt = managed_agent_prompt_selection.is_some();
    let generation = if hello.requested_mode == AttachMode::Controller {
        if managed {
            if hello.authorization_proof_reference.as_deref() != Some(token) {
                send_body(
                    &codec,
                    &writer,
                    1,
                    error_body(
                        ErrorCode::AuthorizationDenied,
                        "Managed Hmux attach authorization was denied",
                        RetryPosture::Never,
                    ),
                )?;
                return Ok(());
            }
        } else if let Some(proof) = hello.authorization_proof_reference.as_deref() {
            let mut launch_owner = lock(&state.launch_owner_proof)?;
            if launch_owner.as_deref() != Some(proof) {
                send_body(
                    &codec,
                    &writer,
                    1,
                    error_body(
                        ErrorCode::AuthorizationDenied,
                        "Hmux launch-owner proof was denied",
                        RetryPosture::Never,
                    ),
                )?;
                return Ok(());
            }
            *launch_owner = None;
        }
        let mut controller = lock(&state.controller)?;
        if controller.is_some() {
            send_body(
                &codec,
                &writer,
                1,
                error_body(
                    ErrorCode::ControllerConflict,
                    "Another client controls this Hmux session",
                    RetryPosture::Reconnect,
                ),
            )?;
            return Ok(());
        }
        let mut host = lock(&state.host)?;
        let expected = host.controller_generation();
        let (_, generation) = host.grant_control(&state.fence, expected)?;
        *controller = Some(client_id);
        lock(&state.controller_submit)?.reset();
        owns_control = true;
        generation
    } else {
        if managed
            && (managed_stop_requested
                || agent_state_report_requested
                || managed_agent_prompt)
        {
            if hello.authorization_proof_reference.as_deref() != Some(token) {
                send_body(
                    &codec,
                    &writer,
                    1,
                    error_body(
                        ErrorCode::AuthorizationDenied,
                        "Managed Hmux operation authorization was denied",
                        RetryPosture::Never,
                    ),
                )?;
                return Ok(());
            }
        } else if hello.authorization_proof_reference.is_some() {
            send_body(
                &codec,
                &writer,
                1,
                error_body(
                    ErrorCode::AuthorizationDenied,
                    "Observer attach proof was denied",
                    RetryPosture::Never,
                ),
            )?;
            return Ok(());
        }
        lock(&state.host)?.controller_generation()
    };
    let selected_capabilities = hello
        .requested_capabilities
        .iter()
        .filter(|requested| {
            state.common.capabilities.contains(requested)
                && terminal_capability_permitted_for_agent_prompt(
                    managed_agent_prompt_selection,
                    requested,
                )
                && (requested.as_str() != TERMINAL_DEFAULT_COLORS_CAPABILITY
                    || hello
                        .requested_capabilities
                        .iter()
                        .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY))
        })
        .cloned()
        .collect::<Vec<_>>();
    let shared_writer = hello.requested_mode == AttachMode::Observer
        && selected_capabilities
            .iter()
            .any(|capability| capability == SHARED_TERMINAL_INPUT_CAPABILITY);
    let termination = selected_capabilities
        .iter()
        .any(|capability| capability == STANDALONE_TERMINATION_CAPABILITY);
    let managed_stop = hello.requested_mode == AttachMode::Observer
        && selected_capabilities
            .iter()
            .any(|capability| capability == MANAGED_PROVIDER_STOP_CAPABILITY);
    let managed_quiescent_stop = managed_stop
        && selected_capabilities
            .iter()
            .any(|capability| capability == MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY);
    let managed_conversation_stop = managed_stop
        && selected_capabilities
            .iter()
            .any(|capability| capability == MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY);
    let agent_state_report = hello.requested_mode == AttachMode::Observer
        && selected_capabilities
            .iter()
            .any(|capability| capability == AGENT_STATE_REPORT_CAPABILITY);
    let agent_state_report_completion_id = agent_state_report
        && selected_capabilities
            .iter()
            .any(|capability| capability == AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY);
    let agent_state_report_causality = agent_state_report
        && selected_capabilities.iter().any(|capability| {
            capability == hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY
        });
    let agent_state_report_observation_fence = agent_state_report
        && selected_capabilities
            .iter()
            .any(|capability| capability == AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY);
    let provider_conversation_identity = selected_capabilities
        .iter()
        .any(|capability| capability == PROVIDER_CONVERSATION_IDENTITY_CAPABILITY);
    let fenced_provider_conversation_identity_report = agent_state_report
        && selected_capabilities.iter().any(|capability| {
            capability == FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY
        });
    let provider_conversation_identity_only_report = agent_state_report
        && selected_capabilities.iter().any(|capability| {
            capability == PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY
        });
    let profiles = selected_capabilities
        .iter()
        .any(|capability| capability == SCREEN_SNAPSHOT_PROFILE_CAPABILITY);
    let reconnect = selected_capabilities
        .iter()
        .any(|capability| capability == RECONNECT_RESUME_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let structured = selected_capabilities
        .iter()
        .any(|capability| capability == TERMINAL_VIEWPORT_PROJECTION_CAPABILITY);
    #[cfg(not(feature = "terminal-state-stream"))]
    let structured = false;
    let profile = if profiles {
        hello
            .initial_snapshot_profile
            .unwrap_or(ScreenSnapshotProfile::Full)
    } else {
        ScreenSnapshotProfile::Full
    };
    let (sender, receiver) = mpsc::sync_channel(CLIENT_QUEUE_CAPACITY);
    let writer_interrupt = transport.interrupt_handle();
    {
        #[cfg(feature = "terminal-state-stream")]
        let _publication = lock(&state.structured_publication)?;
        #[cfg(feature = "terminal-state-stream")]
        let mut host = lock(&state.host)?;
        #[cfg(not(feature = "terminal-state-stream"))]
        let host = lock(&state.host)?;
        #[cfg(feature = "terminal-state-stream")]
        let (surface, mut terminal_seed) = if structured {
            let (surface, records) = WindowsTerminalSurface::attach(
                &mut host,
                &state.fence,
                &selected_capabilities,
                managed_agent_prompt_selection,
            )?;
            (Some(Arc::new(Mutex::new(surface))), Some(records))
        } else {
            (None, None)
        };
        let ack = HelloAck {
            selected_version,
            selected_capabilities,
            actual_fence: state.fence.clone(),
            host_build_version: HOST_BUILD_ID.to_string(),
            lifecycle: if owns_control {
                LifecycleState::Controlling
            } else {
                LifecycleState::Observing
            },
            host_process: state.host_process.clone(),
            provider_process: host.provider_process().cloned(),
            earliest_retained_output_seq: host.earliest_retained_output_seq(),
            current_output_seq: host.current_output_seq(),
            controller_generation: generation,
            authorization_posture: if managed {
                AuthorizationPosture::DaemonAuthorized
            } else {
                AuthorizationPosture::StandaloneLocalOwner
            },
        };
        sender.send(WindowsOutboundRecord::Control(Box::new(
            FrameBody::HelloAck(ack),
        )))?;
        #[cfg(feature = "terminal-state-stream")]
        if let Some(mut records) = terminal_seed.take() {
            windows_terminal_encoding::sequence_prepared_structured_record(
                &state.next_terminal_state_record,
                &mut records,
            )?;
            sender.send(WindowsOutboundRecord::TerminalStateBatch(records))?;
        }
        if !structured {
            for body in attach_seed(
                &host,
                &state.fence,
                reconnect.then_some(hello.reconnect_cursor.as_ref()).flatten(),
                profile,
            )? {
                sender.send(WindowsOutboundRecord::Control(Box::new(body)))?;
            }
        }
        #[cfg(feature = "terminal-state-stream")]
        if structured {
            lock(&state.terminal_surfaces)?.insert(
                client_id,
                WindowsTerminalSurfaceState {
                    geometry: None,
                    geometry_generation: 0,
                    default_colors: None,
                },
            );
        }
        lock(&state.subscribers)?.insert(
            client_id,
            WindowsSubscriber {
                sender: sender.clone(),
                interrupt: Arc::clone(&writer_interrupt),
                #[cfg(feature = "terminal-state-stream")]
                surface,
            },
        );
    }
    let writer_thread = thread::spawn(move || {
        let codec = FrameCodec::new(FrameLimits::default());
        let mut frame_id = 1_u64;
        while let Ok(record) = receiver.recv() {
            let (sent, count) = match record {
                WindowsOutboundRecord::Control(body) => {
                    (send_body(&codec, &writer, frame_id, *body), 1)
                }
                #[cfg(feature = "terminal-state-stream")]
                WindowsOutboundRecord::TerminalStateBatch(records) => (
                    send_terminal_state_batch(&writer, &records),
                    u64::try_from(records.len()).unwrap_or(u64::MAX),
                ),
            };
            if sent.is_err() {
                writer_interrupt.interrupt();
                break;
            }
            frame_id = frame_id.saturating_add(count);
        }
    });
    transport
        .reader()
        .set_completion_timeout(Some(FRAME_COMPLETION_TIMEOUT));
    let client_result = (|| -> Result<()> {
        loop {
            let payload = match transport.reader().read_payload(&codec) {
                Ok(Some(payload)) => payload,
                Ok(None) | Err(TransportError::Interrupted) => break,
                Err(error) => return Err(error.into()),
            };
            #[cfg(feature = "terminal-state-stream")]
            if payload.starts_with(&terminal_state_protocol::ENVELOPE_MAGIC) {
                state.apply_structured_upstream(client_id, &payload)?;
                continue;
            }
            let decoded = codec.decode_payload_for_dispatch(&payload)?.into_valid()?;
            match decoded.body {
                FrameBody::Input(input) => {
                    let receipt = apply_input(&state, owns_control || shared_writer, input);
                    state.enqueue(
                        client_id,
                        WindowsOutboundRecord::Control(Box::new(FrameBody::InputReceipt(receipt))),
                    )?;
                }
                FrameBody::Resize(resize) => {
                    let receipt = apply_resize(&state, owns_control || shared_writer, resize);
                    state.enqueue(
                        client_id,
                        WindowsOutboundRecord::Control(Box::new(FrameBody::ResizeReceipt(receipt))),
                    )?;
                }
                FrameBody::ScreenSnapshotRequest(request) => {
                    let profile = if profiles {
                        request.profile.unwrap_or(ScreenSnapshotProfile::Full)
                    } else {
                        ScreenSnapshotProfile::Full
                    };
                    let mut snapshot = lock(&state.host)?.current_snapshot(profile)?;
                    snapshot.in_reply_to_request_id = Some(request.request_id);
                    state.enqueue(
                        client_id,
                        WindowsOutboundRecord::Control(Box::new(FrameBody::ScreenSnapshot(
                            snapshot,
                        ))),
                    )?;
                }
                FrameBody::StandaloneTerminate(request) => {
                    let receipt = if termination {
                        StandaloneTerminateReceipt {
                            request_id: request.request_id,
                            state: StandaloneTerminateReceiptState::Accepted,
                            reason: None,
                        }
                    } else {
                        StandaloneTerminateReceipt {
                            request_id: request.request_id,
                            state: StandaloneTerminateReceiptState::Refused,
                            reason: Some(OperationReceiptReason::AuthorizationDenied),
                        }
                    };
                    state.enqueue(
                        client_id,
                        WindowsOutboundRecord::Control(Box::new(
                            FrameBody::StandaloneTerminateReceipt(receipt),
                        )),
                    )?;
                    if termination {
                        state.stopping.store(true, Ordering::Release);
                        #[cfg(feature = "terminal-state-stream")]
                        state.agent_prompt_admission.notify();
                        let _ = state.termination_tx.try_send(());
                        break;
                    }
                }
                FrameBody::ManagedProviderStop(request) => {
                    let request_id = request.request_id.clone();
                    let outcome = windows_managed_stop::admit(
                        &state,
                        managed_stop,
                        managed_quiescent_stop,
                        managed_conversation_stop,
                        &request,
                    );
                    let receipt = match outcome {
                        Ok(()) => ManagedProviderStopReceipt {
                            request_id,
                            state: ManagedProviderStopReceiptState::Accepted,
                            reason: None,
                        },
                        Err(reason @ OperationReceiptReason::AgentRuntimeChanged)
                        | Err(reason @ OperationReceiptReason::AuthorizationDenied) => {
                            ManagedProviderStopReceipt {
                                request_id,
                                state: ManagedProviderStopReceiptState::Refused,
                                reason: Some(reason),
                            }
                        }
                        Err(reason) => ManagedProviderStopReceipt {
                            request_id,
                            state: ManagedProviderStopReceiptState::Failed,
                            reason: Some(reason),
                        },
                    };
                    state.enqueue(
                        client_id,
                        WindowsOutboundRecord::Control(Box::new(
                            FrameBody::ManagedProviderStopReceipt(receipt),
                        )),
                    )?;
                    if outcome.is_ok() {
                        break;
                    }
                }
                FrameBody::AgentStateReport(report) => {
                    #[cfg(feature = "terminal-state-stream")]
                    let _publication = lock(&state.structured_publication)?;
                    let mut host = lock(&state.host)?;
                    let application = agent_state_report::apply(
                        &mut host,
                        &state.fence,
                        &state.common.provider_id,
                        agent_state_report::Permissions {
                            report: agent_state_report,
                            completion_id: agent_state_report_completion_id,
                            causality: agent_state_report_causality,
                            observation_fence: agent_state_report_observation_fence,
                            conversation_identity: provider_conversation_identity,
                            fenced_conversation_identity:
                                fenced_provider_conversation_identity_report,
                            identity_only_conversation:
                                provider_conversation_identity_only_report,
                        },
                        report,
                    );
                    drop(host);
                    for body in application.broadcasts {
                        state.broadcast_control(body);
                    }
                    #[cfg(feature = "terminal-state-stream")]
                    state.agent_prompt_admission.notify();
                    state.enqueue(
                        client_id,
                        WindowsOutboundRecord::Control(Box::new(application.response)),
                    )?;
                }
                FrameBody::Detach(_) => break,
                _ => {
                    state.enqueue(
                        client_id,
                        WindowsOutboundRecord::Control(Box::new(error_body(
                            ErrorCode::UnsupportedCapability,
                            "Hmux client sent an unsupported frame",
                            RetryPosture::Never,
                        ))),
                    )?;
                }
            }
        }
        Ok(())
    })();
    let subscriber = lock(&state.subscribers)?.remove(&client_id);
    #[cfg(feature = "terminal-state-stream")]
    if let Some(surface) = subscriber.and_then(|subscriber| subscriber.surface) {
        state.detach_terminal_surface(client_id, surface);
    }
    #[cfg(not(feature = "terminal-state-stream"))]
    let _ = subscriber;
    if owns_control {
        let mut controller = lock(&state.controller)?;
        if *controller == Some(client_id) {
            let mut host = lock(&state.host)?;
            let generation = host.controller_generation();
            let _ = host.release_control(&state.fence, generation);
            *controller = None;
            lock(&state.controller_submit)?.reset();
        }
    }
    drop(sender);
    let _ = writer_thread.join();
    transport.interrupt();
    client_result
}

fn apply_input(
    state: &WindowsServerState,
    writable: bool,
    input: hmux_host::local_protocol::Input,
) -> InputReceipt {
    if !writable {
        return InputReceipt {
            request_id: input.request_id,
            controller_generation: input.controller_generation,
            state: InputReceiptState::Refused,
            reason: Some(OperationReceiptReason::AuthorizationDenied),
            detail: None,
        };
    }
    let result = (|| -> std::result::Result<_, crate::input_transaction::InputTransactionOutcome> {
        let mut host = lock(&state.host).map_err(|_| {
            crate::input_transaction::InputTransactionOutcome::NotWritten(
                OperationReceiptReason::ResourceLimit,
            )
        })?;
        if state.stopping.load(Ordering::Acquire) {
            return Err(crate::input_transaction::InputTransactionOutcome::NotWritten(
                OperationReceiptReason::HostExiting,
            ));
        }
        host.admit_mutation(&state.fence, input.controller_generation)
            .map_err(|error| {
                crate::input_transaction::InputTransactionOutcome::NotWritten(
                    crate::input_transaction::input_operation_reason(&error),
                )
            })?;
        state
            .apply_pty_input_transaction(
                &mut host,
                crate::input_transaction::PtyInput::Bytes(&input.bytes),
                ControllerInputEffect::DraftCapable,
                crate::input_transaction::InputAdmission::Ordinary,
            )
            .map_err(|_| {
                crate::input_transaction::InputTransactionOutcome::NotWritten(
                    OperationReceiptReason::ResourceLimit,
                )
            })?
            .map_err(|failure| failure.outcome())
    })();
    let outcome = match &result {
        Ok(transaction) => transaction.outcome,
        Err(outcome) => *outcome,
    };
    let (receipt_state, reason) = crate::input_receipt::classic_outcome(outcome);
    if let Ok(transaction) = result {
        if let Some(runtime_state) = transaction.runtime_state {
            state.broadcast_control(FrameBody::AgentRuntimeState(runtime_state));
        }
    }
    InputReceipt {
        request_id: input.request_id,
        controller_generation: input.controller_generation,
        state: receipt_state,
        reason,
        detail: None,
    }
}

fn apply_resize(
    state: &WindowsServerState,
    writable: bool,
    resize: hmux_host::local_protocol::Resize,
) -> ResizeReceipt {
    if !writable {
        return ResizeReceipt {
            request_id: resize.request_id,
            controller_generation: resize.controller_generation,
            rows: None,
            columns: None,
            state: ResizeReceiptState::Refused,
            reason: Some(OperationReceiptReason::AuthorizationDenied),
        };
    }
    let result = (|| -> Result<()> {
        let mut host = lock(&state.host)?;
        if state.stopping.load(Ordering::Acquire) {
            return Err(SessionHostError::SessionExited.into());
        }
        let prepared = host.prepare_resize(
            &state.fence,
            resize.controller_generation,
            resize.rows,
            resize.columns,
        )?;
        state.provider.resize(resize.rows, resize.columns)?;
        prepared.commit()?;
        Ok(())
    })();
    let (receipt_state, reason) = match result {
        Ok(()) => (ResizeReceiptState::AppliedToTerminal, None),
        Err(error) => match error.downcast_ref::<SessionHostError>() {
            Some(SessionHostError::StaleControllerGeneration) => (
                ResizeReceiptState::Revoked,
                Some(OperationReceiptReason::StaleControllerGeneration),
            ),
            Some(SessionHostError::TerminalReplay(_)) => (
                ResizeReceiptState::Refused,
                Some(OperationReceiptReason::InvalidTerminalDimensions),
            ),
            Some(SessionHostError::SessionExited) => (
                ResizeReceiptState::Refused,
                Some(OperationReceiptReason::HostExiting),
            ),
            _ => (
                ResizeReceiptState::Failed,
                Some(OperationReceiptReason::PlatformResizeFailed),
            ),
        },
    };
    ResizeReceipt {
        request_id: resize.request_id,
        controller_generation: resize.controller_generation,
        rows: (receipt_state == ResizeReceiptState::AppliedToTerminal).then_some(resize.rows),
        columns: (receipt_state == ResizeReceiptState::AppliedToTerminal)
            .then_some(resize.columns),
        state: receipt_state,
        reason,
    }
}

fn attach_seed(
    host: &SessionHost,
    fence: &SessionFence,
    cursor: Option<&hmux_host::local_protocol::ReconnectCursor>,
    profile: ScreenSnapshotProfile,
) -> Result<Vec<FrameBody>> {
    let Some(cursor) = cursor else {
        return Ok(vec![FrameBody::ScreenSnapshot(
            host.current_snapshot(profile)?,
        )]);
    };
    if cursor.terminal_epoch == fence.terminal_epoch
        && cursor.after_output_seq == host.current_output_seq()
    {
        return Ok(Vec::new());
    }
    match host.replay_after(fence, cursor) {
        Ok(ReplayResult::Deltas(deltas)) => Ok(deltas
            .into_iter()
            .map(FrameBody::OutputDelta)
            .collect()),
        Ok(ReplayResult::Gap(gap)) => Ok(vec![
            FrameBody::ReplayGap(gap),
            FrameBody::ScreenSnapshot(host.current_snapshot(profile)?),
        ]),
        Err(_) => Ok(vec![FrameBody::ScreenSnapshot(
            host.current_snapshot(profile)?,
        )]),
    }
}

fn output_loop(mut output: std::fs::File, state: Arc<WindowsServerState>) -> Result<()> {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = match output.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        #[cfg(feature = "terminal-state-stream")]
        let _publication = lock(&state.structured_publication)?;
        let ingested = lock(&state.host)?.ingest_output(&state.fence, &buffer[..read])?;
        state.broadcast_classic_output(FrameBody::OutputDelta(ingested.delta));
        #[cfg(feature = "terminal-state-stream")]
        state.publish_structured_viewports_locked()?;
        if !ingested.pty_replies.is_empty() {
            state.provider.write_all(&ingested.pty_replies)?;
        }
    }
}

fn send_body(
    codec: &FrameCodec,
    writer: &SharedFrameWriter,
    frame_id: u64,
    body: FrameBody,
) -> Result<()> {
    let encoded = codec.encode(&WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id,
        body,
    })?;
    lock(writer)?.write_frame(&encoded)?;
    Ok(())
}

#[cfg(feature = "terminal-state-stream")]
fn send_terminal_state_batch(
    writer: &SharedFrameWriter,
    records: &[Vec<u8>],
) -> Result<()> {
    let mut writer = lock(writer)?;
    for record in records {
        if record.len() > terminal_state_protocol::MAX_ENVELOPE_BYTES {
            return Err("structured terminal record exceeds its bounded envelope".into());
        }
        let length = u32::try_from(record.len())
            .map_err(|_| "structured terminal record length exceeds u32")?;
        let mut framed = Vec::with_capacity(4 + record.len());
        framed.extend_from_slice(&length.to_be_bytes());
        framed.extend_from_slice(record);
        writer.write_frame(&framed)?;
    }
    Ok(())
}

fn error_body(code: ErrorCode, message: &str, retry: RetryPosture) -> FrameBody {
    FrameBody::Error(ErrorFrame {
        origin_code: None,
        code,
        message: message.to_string(),
        retry,
        required_capability: None,
        supported_versions: None,
        in_reply_to_request_id: None,
    })
}

fn process_proof(process_id: u32) -> Result<ProcessProof> {
    let process = WindowsProcessHandle::open(process_id)?;
    let creation_filetime = process_creation_filetime(&process)?;
    Ok(ProcessProof {
        process_id,
        start_marker: format!("windows-proc-start-v1:{creation_filetime}"),
    })
}

fn process_creation_filetime(process: &WindowsProcessHandle) -> Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            process.raw(),
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let creation_filetime =
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if creation_filetime == 0 {
        return Err("Windows process creation time is unavailable".into());
    }
    Ok(creation_filetime)
}

struct WindowsProcessHandle(HANDLE);

impl WindowsProcessHandle {
    fn open(process_id: u32) -> io::Result<Self> {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        (!raw.is_null())
            .then_some(Self(raw))
            .ok_or_else(io::Error::last_os_error)
    }

    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for WindowsProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn resolve_command(command: &[String]) -> (PathBuf, Vec<String>) {
    if let Some((program, arguments)) = command.split_first() {
        return (PathBuf::from(program), arguments.to_vec());
    }
    (
        env::var_os("COMSPEC")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe")),
        vec!["/D".into(), "/Q".into(), "/K".into()],
    )
}

#[cfg(feature = "terminal-state-stream")]
fn direct_launch_agent(provider_id: &str, provider_program: &Path) -> Option<AgentProvider> {
    let provider = AgentProvider::from_id(provider_id)?;
    provider_program
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| stem.eq_ignore_ascii_case(provider.as_str()))
        .map(|_| provider)
}

fn terminal_replay_limits() -> TerminalReplayLimits {
    TerminalReplayLimits {
        max_snapshot_bytes: FrameLimits::default().max_snapshot_bytes,
        ..TerminalReplayLimits::default()
    }
}

fn windows_host_name() -> String {
    env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "windows".to_string())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn host_stderr() -> Stdio {
    let Some(path) = env::var_os("HMUX_RUNTIME_LOG").filter(|value| !value.is_empty()) else {
        return Stdio::null();
    };
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| "hmux runtime lock was poisoned".into())
}
