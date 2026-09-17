// Included at the crate root only on Unix; `main.rs` owns crate attributes and
// target selection.

mod agent_state_report;
mod broker;
mod connection_accept;
mod connection_shutdown;
mod discovery_root_lifetime;
mod host;
mod host_resource_budget;
mod idle_retirement;
mod managed_abandonment;
mod managed_agent_state_report;
mod managed_authorization;
mod managed_create_failure;
mod managed_create_advance;
mod managed_create_chain_stop;
mod managed_create_intent;
mod managed_create_reconcile;
mod managed_provider_launch_gate;
mod managed_rehost;
mod managed_starting_generation;
mod managed_stop_fence;
mod managed_stop_intent;
mod managed_stop_reconcile;
mod presentation_checkpoint_writer;
mod process_session;
mod pty_input;
mod pty_io;
mod pty_output;
mod recovery;
mod retirement_timer;
mod runtime_diagnostics;
mod runtime_identity;
mod server;
mod subscriber_delivery;
mod subscriber_queue;
#[cfg(feature = "terminal-state-stream")]
mod terminal_surface;
#[cfg(feature = "terminal-state-stream")]
mod viewport_projection_cutover;

use connection_accept::{accept_loop, configure_accept_listener};
use connection_shutdown::{finish_host_connections, finish_subscriber_outbound};
use discovery_root_lifetime::{
    DiscoveryRootGeneration, DiscoveryRootLifetime, RootLifetimeDecision,
};
use hebbian_process_sampler::{SharedProcessSampler, process_start_time};
use hmux_client::default_discovery_root;
use hmux_client::recovery_journal::{
    SAVED_RECIPE_RECOVERY_NAMESPACE, lock_source, managed_create_ledger,
    managed_create_ledger::{
        ManagedStartingGeneration, ManagedStartingProviderContainment,
    },
};
use hmux_client::{
    EXACT_DISCOVERY_WORKER_SUBCOMMAND, LocalProcessGenerationStatus, LocalSession,
    LocalSessionCatalog, ProcessDescriptor, SessionSelector, prepare_managed_attach_receipt,
    probe_local_process_generation, serve_catalog_census, serve_exact_discovery_lookup,
};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ExitedManifest,
    HostLifetimeIdentity, LifetimeLock, LocalEndpoint, LocalEndpointKind, ManifestCommon,
    ManifestGeneration, PresentationCheckpoint, PresentationCheckpointHandoff,
    PresentationCheckpointSource, ReadyManifest, SessionClass, SessionDiscovery,
    SessionRetirementPolicy, StaleDiscoveryReason, StartingManifest, launch_program_label,
};
use hmux_local_platform::local_peer_identity::verify_pathname_socket_same_user;
#[cfg(test)]
use hmux_host::local_protocol::ScreenSnapshot;
use hmux_host::local_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_RUNTIME_STATE_CAPABILITY,
    AGENT_STATE_REPORT_CAPABILITY, AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
    AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY, AttachMode, AuthorizationPosture,
    ControlReceipt, ControlReceiptState,
    EXECUTION_LOCATION_PROJECTION_CAPABILITY, ErrorCode, ErrorFrame,
    FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY, FrameBody, FrameCodec, FrameLimits,
    HelloAck, InputReceipt, LifecycleState,
    MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
    MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY,
    MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY, MANAGED_PROVIDER_STOP_CAPABILITY,
    ManagedAuthorizationGrantReceipt, ManagedProviderStopConversationFence,
    ManagedProviderStopQuiescenceFence, ManagedProviderStopReceipt, ManagedProviderStopReceiptState,
    ORDERED_SNAPSHOT_REFRESH_CAPABILITY, OperationReceiptReason,
    PROTOCOL_V1, PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY, ProcessProof,
    RECONNECT_RESUME_CAPABILITY, RECOVERED_PRESENTATION_CAPABILITY, ResizeReceipt,
    ResizeReceiptState, RetryPosture, RuntimeContext, SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
    SESSION_RETIREMENT_ADMIN_CAPABILITY, SESSION_RETIREMENT_CAPABILITY,
    SHARED_TERMINAL_INPUT_CAPABILITY, STANDALONE_TERMINATION_CAPABILITY, ScreenSnapshotProfile,
    SessionFence, SessionRetirementAction, SessionRetirementReceipt,
    SessionRetirementReceiptReason, SessionRetirementReceiptState, SessionRetirementRequest,
    StandaloneTerminateReceipt, StandaloneTerminateReceiptState,
    UNPRESENTED_CREATION_ABANDON_CAPABILITY, VersionRange, WORKING_DIRECTORY_FRAME_CAPABILITY,
    WORKING_DIRECTORY_PROJECTION_CAPABILITY,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::local_protocol::{
    AGENT_PROMPT_CAPABILITY, AgentPromptCapabilitySelection,
    LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    select_managed_agent_prompt_capability,
};
use hmux_host::local_transport::{FrameReader, TransportError};
#[cfg(test)]
use hmux_host::local_transport::TransportInterrupt;
use hmux_host::provider_epoch::{
    ProviderExitKind, ProviderExitStatus, SessionFailureCapsule, SessionFailurePhase,
    SessionFailureRetryPosture, process_session_cleanup_is_incomplete,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::session_host::DurableTerminalHistory;
use hmux_host::session_host::{SessionHost, SessionHostError};
use hmux_host::terminal_replay::{
    AgentIdentityObservation, AgentRuntimeObservation, ExecutionLocationObservation,
    ProviderConversationIdentityObservation, TerminalCheckpoint, TerminalReplayError,
    TerminalReplayLimits, WorkingDirectoryObservation,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_host::terminal_replay::{TerminalPresentationDegradation, WheelPtySink};
use hmux_runtime_contract::{
    HMUX_CHANNEL_EPOCH_ENV, HMUX_ENV, HMUX_HOST_INSTANCE_ID_ENV, HMUX_RUNNER_INSTANCE_ENV,
    HMUX_RUNNER_PRINCIPAL_ENV, HMUX_SESSION_ID_ENV, HMUX_SESSION_NAME_ENV, HMUX_TERMINAL_EPOCH_ENV,
    HMUX_WORKSPACE_ID_ENV, HOST_REGISTRATION_CAPACITY_EXIT_CODE,
    MANAGED_AGENT_STATE_REPORT_BROKER_SUBCOMMAND, MANAGED_ATTACH_BROKER_SUBCOMMAND,
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, MANAGED_CREATE_ADVANCE_CAPABILITY,
    MANAGED_CREATE_BROKER_SUBCOMMAND, MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND,
    MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2, MANAGED_CREATE_CHAIN_STOP_CAPABILITY,
    MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2, MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND,
    MANAGED_REHOST_BROKER_SUBCOMMAND, MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedAttachBrokerResponse, ManagedAttachReceipt, ManagedCreateBrokerResponse,
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt,
    ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedRehostBrokerResponse,
    ManagedStopBrokerResponse, ManagedStopOutcome, ManagedStopReceipt, ManagedStopReconcileRequest,
    ManagedStopRequest, PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
    PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY, ProviderConversationIdentitySeed,
    ProviderStateEnvironment, STANDALONE_CREATE_BROKER_SUBCOMMAND, StandaloneResurrectionRecipe,
    TERMINAL_DEFAULT_COLORS_CAPABILITY, TERMINAL_INPUT_INTENT_CAPABILITY, TerminalEnvironment,
    interactive_terminal_environment_policy, launching_client_session_env_keys, read_json_frame,
    read_managed_attach_finalization, read_managed_attach_request, read_managed_create_request,
    read_managed_rehost_reconcile_request, read_managed_rehost_request,
    read_managed_stop_reconcile_request, read_managed_stop_request,
    terminal_capability_permitted_for_agent_prompt, write_managed_attach_response,
    write_managed_create_response, write_managed_rehost_response, write_managed_stop_response,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_runtime_contract::{
    TERMINAL_STATE_BASE_PROTOCOL_MINOR, TERMINAL_STATE_BINARY_CAPABILITY,
    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, selected_terminal_base_protocol_minor,
    terminal_capability_request_is_consistent,
    terminal_default_colors_permitted, terminal_viewport_multipart_permitted,
    terminal_viewport_wheel_permitted,
};
use host::{
    HOST_PACKET_SCHEMA, HostLaunchPacket, HostSpawnFailure,
    INTERNAL_HOST_SUBCOMMAND, READY_POLL, READY_TIMEOUT, fault_inject_host_spawn_before_start_for_test,
    inject_managed_create_fault, spawn_host_after_preflight,
};
use host_resource_budget::{
    ConnectionClass, ConnectionPermit, ConnectionRejection, HostResourceBudget, HostResourceLimits,
};
use idle_retirement::{IdleRetirementDecision, IdleRetirementInput, evaluate_idle_retirement};
use managed_authorization::ManagedAuthorizationGrants;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use presentation_checkpoint_writer::{
    CheckpointFailureCode, CheckpointVersion, FinalFlushOutcome, PresentationCheckpointWriter,
    PresentationSnapshotSource, RootRetired, SessionCheckpointSink,
};
use process_session::OwnedProcessSession;
use pty_input::{InputAdmission, PtyInput, apply_pty_input};
use pty_output::output_loop;
use crate::controller_input_effect::ControllerInputEffect;
use recovery::{
    RecipePublicationFailureStage, prepare_resurrection_recipe, read_resurrection_recipe,
    rebuild_resurrection_recipe_with_policy, save_resurrection_recipe,
};
use retirement_timer::{RetirementSchedule, RetirementTimer};
use runtime_diagnostics::{
    RuntimeDiagnosticContext, RuntimeDiagnosticEvent, RuntimeDiagnosticFields, RuntimeDiagnostics,
};
use serde::{Deserialize, Serialize};
use server::{
    AttachReply, ClientTransport, FIRST_OUTBOUND_FRAME_ID, ProviderProcessControl,
    ProviderTermination, attach_reply, cleanup_unproven_provider_child,
    expected_provider_identity_program, process_proof, provider_exit_status, resolve_command,
    run_subscriber_outbound, send_body, wait_for_provider, write_error, write_error_before,
};
#[cfg(feature = "terminal-state-stream")]
use server::{prepare_terminal_viewport, refuse_terminal_viewport_attach, seed_terminal_delivery};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::HashMap;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::RawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(feature = "terminal-state-stream")]
use subscriber_delivery::StructuredStateBatch;
#[cfg(test)]
use subscriber_delivery::accounted_bytes as subscriber_queue_accounted_bytes;
use subscriber_delivery::{
    PreparedFrame, QUEUE_MAX_ACCOUNTED_BYTES as SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES,
    QUEUE_MAX_RECORDS as SUBSCRIBER_QUEUE_MAX_RECORDS, SnapshotProjection, SubscriberDelivery,
    SubscriberRegistry,
};
use subscriber_queue::BoundedQueue;
#[cfg(feature = "terminal-state-stream")]
use terminal_surface::{
    IngressPermissions, StructuredUpstream, TerminalSurfaceActor, TerminalSurfaceMutation,
    ViewportCaptureBudget, ViewportProjectionPublication, ViewportRetirement,
    apply_input as apply_structured_terminal_input,
    apply_viewport as apply_structured_terminal_viewport, decode_upstream,
    prepare_structured_record, sequence_prepared_structured_record,
};
use uuid::Uuid;
const IDLE_RETIREMENT_GUARDIAN_SUBCOMMAND: &str = "internal-idle-retirement-guardian";
const IDLE_RETIREMENT_GUARDIAN_READY_ACK: u8 = 0x47;
const IDLE_RETIREMENT_GUARDIAN_READY_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(debug_assertions)]
const IDLE_RETIREMENT_FROZEN_TEST_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_IDLE_RETIREMENT_FROZEN_MARKER";
#[cfg(debug_assertions)]
const IDLE_RETIREMENT_GUARDIAN_READY_FAULT_ENV: &str =
    "HMUX_RUNTIME_TEST_IDLE_RETIREMENT_GUARDIAN_READY_FAULT";
#[cfg(debug_assertions)]
const IDLE_RETIREMENT_GUARDIAN_READY_FAULT_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_IDLE_RETIREMENT_GUARDIAN_READY_FAULT_MARKER";
#[cfg(debug_assertions)]
const RETIREMENT_POLICY_RECIPE_PUBLISHED_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_RETIREMENT_POLICY_RECIPE_PUBLISHED_MARKER";
#[cfg(debug_assertions)]
const RETIREMENT_DEPARTURE_BEFORE_TRANSITION_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_RETIREMENT_DEPARTURE_BEFORE_TRANSITION_MARKER";
#[cfg(debug_assertions)]
const PTY_READ_BEFORE_INGEST_PAUSE_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_PTY_READ_BEFORE_INGEST_PAUSE_MARKER";
#[cfg(debug_assertions)]
const PTY_RESIZE_LIVENESS_FAULT_MARKER_ENV: &str =
    "HMUX_RUNTIME_TEST_PTY_RESIZE_LIVENESS_FAULT_MARKER";
#[cfg(debug_assertions)]
const TERMINAL_MUTATION_FAULT_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_TERMINAL_MUTATION_FAULT_MARKER";
#[cfg(all(debug_assertions, feature = "terminal-state-stream"))]
const MAX_PENDING_HISTORY_TRANSFER_BYTES_TEST_ENV: &str =
    "HMUX_RUNTIME_TEST_MAX_PENDING_HISTORY_TRANSFER_BYTES";
const TEST_GUARDIAN_CUT_PHASE_ENV: &str = "HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE";
const TEST_GUARDIAN_CUT_MARKER_ENV: &str = "HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER";
const BUILD_INFO_SUBCOMMAND: &str = "hmux-build-info";
const HOST_BUILD_ID: &str = env!("HMUX_BUILD_ID");
#[cfg(feature = "terminal-state-stream")]
const RUNTIME_PRODUCT_PROFILE: &str = "structured-terminal-v1";
#[cfg(not(feature = "terminal-state-stream"))]
const RUNTIME_PRODUCT_PROFILE: &str = "runtime-core-v1";
#[cfg(feature = "terminal-state-stream")]
const PRODUCT_PROFILE_MARKER_TEXT: &str = "hmux-product-profile=structured-terminal-v1";
#[cfg(not(feature = "terminal-state-stream"))]
const PRODUCT_PROFILE_MARKER_TEXT: &str = "hmux-product-profile=runtime-core-v1";
const BUILD_PROVENANCE_TEXT: &str = concat!(
    "{\"schemaVersion\":1,\"product\":\"hmux\",\"binary\":\"hmux-runtime\",\"buildId\":\"",
    env!("HMUX_BUILD_ID"),
    "\",\"sourceCommit\":\"",
    env!("HMUX_SOURCE_COMMIT"),
    "\",\"targetTriple\":\"",
    env!("HMUX_TARGET_TRIPLE"),
    "\"}"
);
#[used]
#[cfg_attr(target_os = "linux", unsafe(link_section = ".hmux.build"))]
static BUILD_PROVENANCE: [u8; BUILD_PROVENANCE_TEXT.len()] =
    string_bytes::<{ BUILD_PROVENANCE_TEXT.len() }>(BUILD_PROVENANCE_TEXT);
#[used]
#[cfg_attr(target_os = "linux", unsafe(link_section = ".hmux.profile"))]
static PRODUCT_PROFILE_MARKER: [u8; PRODUCT_PROFILE_MARKER_TEXT.len()] =
    string_bytes::<{ PRODUCT_PROFILE_MARKER_TEXT.len() }>(PRODUCT_PROFILE_MARKER_TEXT);

const fn string_bytes<const LENGTH: usize>(value: &str) -> [u8; LENGTH] {
    let source = value.as_bytes();
    let mut result = [0_u8; LENGTH];
    let mut index = 0;
    while index < LENGTH {
        result[index] = source[index];
        index += 1;
    }
    result
}
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const RETIREMENT_PROCESS_SNAPSHOT_MAX_AGE: Duration = Duration::from_millis(250);
const RETIREMENT_PROCESS_SNAPSHOT_ATTEMPTS: usize = 2;
const RETIREMENT_OBSERVATION_RETRY_BASE: Duration = Duration::from_millis(250);
const RETIREMENT_OBSERVATION_MAX_RETRIES: u32 = 3;
const DISCOVERY_ROOT_POLL_INTERVAL: Duration = Duration::from_secs(1);
const DISCOVERY_ROOT_REAP_GRACE: Duration = Duration::from_secs(2);
const MANAGED_AUTHORIZATION_GRANT_TTL: Duration = Duration::from_secs(15);
const MAX_MANAGED_AUTHORIZATION_GRANTS: usize = 64;
const PROVIDER_RUNTIME_ENVIRONMENT_CAPABILITY: &str = "provider_runtime_environment_v1";
const HOST_CAPABILITIES: &[&str] = &[
    hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
    "screen_snapshot",
    "live_output",
    "terminal_input",
    "terminal_resize",
    "terminal_control",
    SHARED_TERMINAL_INPUT_CAPABILITY,
    WORKING_DIRECTORY_PROJECTION_CAPABILITY,
    WORKING_DIRECTORY_FRAME_CAPABILITY,
    EXECUTION_LOCATION_PROJECTION_CAPABILITY,
    AGENT_IDENTITY_PROJECTION_CAPABILITY,
    AGENT_RUNTIME_STATE_CAPABILITY,
    ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
    SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
    AGENT_STATE_REPORT_CAPABILITY,
    AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
    AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
    "provider_exit_inspection",
    RECOVERED_PRESENTATION_CAPABILITY,
    RECONNECT_RESUME_CAPABILITY,
];

fn advertised_base_capabilities() -> Vec<String> {
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
    capabilities.push(TERMINAL_STATE_BINARY_CAPABILITY.to_string());
    #[cfg(feature = "terminal-state-stream")]
    capabilities.extend(viewport_projection_cutover::capabilities_when_ready().map(str::to_string));
    capabilities
}

fn managed_host_capabilities() -> Vec<String> {
    let capabilities = [
        managed_starting_generation::PROVIDER_RELEASE_BARRIER_CAPABILITY,
        PROVIDER_RUNTIME_ENVIRONMENT_CAPABILITY,
        PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
        PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY,
        MANAGED_PROVIDER_STOP_CAPABILITY,
        MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY,
        MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY,
        hmux_host::local_protocol::SEMANTIC_IDLE_OBSERVATION_CAPABILITY,
        MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
        MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
    ]
    .map(str::to_string)
    .to_vec();
    #[cfg(feature = "terminal-state-stream")]
    let mut capabilities = capabilities;
    #[cfg(feature = "terminal-state-stream")]
    capabilities.extend(
        [
            AGENT_PROMPT_CAPABILITY,
            PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
            LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
        ]
        .map(str::to_string),
    );
    capabilities
}

fn effective_managed_host_capabilities() -> Vec<String> {
    managed_create_failure::effective_host_capabilities(managed_host_capabilities())
}

const SUBSCRIBER_QUEUE_MAX_AGE: Duration = Duration::from_secs(5);
const HOST_MAX_PENDING_CONNECTIONS: usize = 16;
const HOST_MAX_ACTIVE_CONNECTIONS: usize = 64;
const HOST_RESERVED_PRIORITY_CONNECTIONS: usize = 8;
const HOST_MAX_SUBSCRIBER_QUEUED_BYTES: usize = 16 * 1024 * 1024;
const HOST_OVERLOAD_WRITE_TIMEOUT: Duration = Duration::from_millis(50);
const SUBSCRIBER_OUTBOUND_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

type DynError = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, DynError>;

fn main() {
    std::hint::black_box(&BUILD_PROVENANCE);
    std::hint::black_box(&PRODUCT_PROFILE_MARKER);
    if let Err(error) = run() {
        eprintln!("hmux-runtime: {error}");
        let exit_code = if matches!(
            error.downcast_ref::<hmux_host::local_discovery::DiscoveryError>(),
            Some(hmux_host::local_discovery::DiscoveryError::RegistrationCapacityExceeded { .. })
        ) {
            HOST_REGISTRATION_CAPACITY_EXIT_CODE
        } else {
            1
        };
        std::process::exit(exit_code);
    }
}

fn run() -> Result<()> {
    let arguments = runtime_arguments(env::args().skip(1));
    if let [command] = arguments.as_slice() {
        if let Some(result) = broker::run(command) {
            return result;
        }
    }
    match arguments.as_slice() {
        [command, root] if command == capacity_maintenance::SUBCOMMAND => {
            capacity_maintenance::run(Path::new(root))
        }
        [command] if command == BUILD_INFO_SUBCOMMAND => {
            serde_json::to_writer(
                io::stdout(),
                &serde_json::json!({
                    "schemaVersion": 1,
                    "buildId": HOST_BUILD_ID,
                    "source": "hmux_runtime",
                    "sourceCommit": env!("HMUX_SOURCE_COMMIT"),
                    "targetTriple": env!("HMUX_TARGET_TRIPLE"),
                    "productProfile": RUNTIME_PRODUCT_PROFILE,
                    "protocol": {
                        "minimum": "1.0",
                        "maximum": "1.0",
                    },
                    "capabilities": [
                        hmux_runtime_contract::MANAGED_CREATE_CAPABILITY,
                        hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
                        hmux_runtime_contract::STANDALONE_REQUEST_BOUND_CREATE_CAPABILITY,
                        hmux_runtime_contract::STANDALONE_OPERATION_BOUND_CREATE_CAPABILITY,
                        hmux_runtime_contract::STANDALONE_LOCATED_OPERATION_CREATE_CAPABILITY,
                        MANAGED_CREATE_ADVANCE_CAPABILITY,
                        MANAGED_CREATE_CHAIN_STOP_CAPABILITY,
                        MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2,
                    ],
                }),
            )?;
            Ok(())
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
            serve_exact_discovery_lookup(
                &catalog,
                io::stdin().lock(),
                io::stdout().lock(),
            )?;
            Ok(())
        }
        [command] if command == INTERNAL_HOST_SUBCOMMAND => host(),
        [command, gate_arguments @ ..]
            if command == managed_provider_launch_gate::SUBCOMMAND =>
        {
            managed_provider_launch_gate::run(gate_arguments).map_err(Into::into)
        }
        [command, host_pid, host_start_time, provider_pid, provider_start_time]
            if command == IDLE_RETIREMENT_GUARDIAN_SUBCOMMAND =>
        {
            idle_retirement_guardian(
                host_pid.parse()?,
                host_start_time.parse()?,
                provider_pid.parse()?,
                provider_start_time.parse()?,
            )
        }
        _ => Err(format!(
            "usage: hmux-runtime --no-autostart <{STANDALONE_CREATE_BROKER_SUBCOMMAND}|{MANAGED_CREATE_BROKER_SUBCOMMAND}|{MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND}|{MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}|{MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND}|{MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2}|{MANAGED_ATTACH_BROKER_SUBCOMMAND}|{MANAGED_AGENT_STATE_REPORT_BROKER_SUBCOMMAND}|{MANAGED_STOP_BROKER_SUBCOMMAND}|{MANAGED_REHOST_BROKER_SUBCOMMAND}|{MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND}|{MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}|{BUILD_INFO_SUBCOMMAND}>"
        )
        .into()),
    }
}

fn managed_create_broker() -> Result<()> {
    let response = match read_managed_create_request(&mut io::stdin()) {
        Ok(request) => match launch_managed(request) {
            Ok(receipt) => {
                capacity_maintenance::schedule(receipt.discovery_root());
                ManagedCreateBrokerResponse::Completed(Box::new(receipt))
            }
            Err(error) => {
                if let Some(code) = managed_create_failure::failure_code(error.as_ref()) {
                    ManagedCreateBrokerResponse::refused(code, error.to_string())
                } else {
                    let code = error
                        .downcast_ref::<HostSpawnFailure>()
                        .map(HostSpawnFailure::code)
                        .unwrap_or("hmux_managed_launch_failed");
                    ManagedCreateBrokerResponse::retryable(code, error.to_string())
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
    launch_managed_with_handoff_and_lineage(
        request,
        None,
        managed_create_intent::ManagedCreateIntentLineage::Root,
    )
}

fn launch_managed_successor(request: ManagedCreateRequest) -> Result<ManagedCreateReceipt> {
    launch_managed_with_handoff_and_lineage(
        request,
        None,
        managed_create_intent::ManagedCreateIntentLineage::Successor,
    )
}

fn launch_managed_with_handoff(
    request: ManagedCreateRequest,
    presentation_handoff: Option<PresentationCheckpointHandoff>,
) -> Result<ManagedCreateReceipt> {
    launch_managed_with_handoff_and_lineage(
        request,
        presentation_handoff,
        managed_create_intent::ManagedCreateIntentLineage::Root,
    )
}

fn launch_managed_with_handoff_and_lineage(
    request: ManagedCreateRequest,
    presentation_handoff: Option<PresentationCheckpointHandoff>,
    lineage: managed_create_intent::ManagedCreateIntentLineage,
) -> Result<ManagedCreateReceipt> {
    request.validate()?;
    managed_create_failure::ensure_required_capabilities(
        &request,
        &effective_managed_host_capabilities(),
    )?;
    let discovery_catalog = LocalSessionCatalog::from_environment()?;
    let discovery_root = discovery_catalog.discovery_root().to_path_buf();
    let discovery = DiscoveryRoot::create(&discovery_root)?;
    if let Ok(existing) =
        discovery.find_manifest_by_session(request.workspace_id(), request.session_id())
    {
        managed_abandonment::maintain_completed_create_lifecycle(
            &discovery_root,
            &existing.manifest,
        );
    }
    {
        let _phase = runtime_diagnostics::broker_timing::phase(
            runtime_diagnostics::broker_timing::Phase::LaunchCapacity,
        );
        prepare_host_admission_capacity(&discovery_root);
    }
    // GC takes this lock exclusively before consulting the create ledger.
    // Holding it through intent reconciliation makes a missing manifest and
    // exact Host absence one coherent proof before the ledger is reopened.
    let create_maintenance = discovery.acquire_maintenance_shared()?;
    {
        let _phase = runtime_diagnostics::broker_timing::phase(
            runtime_diagnostics::broker_timing::Phase::LaunchCompatibility,
        );
        let identity = hmux_client::SessionCatalogIdentity::new(
            request.workspace_id(),
            request.session_id(),
        )?;
        if discovery_catalog.has_read_only_migration_session(&identity)? {
            return Err(
                "managed session identity remains reserved by read-only legacy discovery".into(),
            );
        }
    }
    let intent = {
        let _phase = runtime_diagnostics::broker_timing::phase(
            runtime_diagnostics::broker_timing::Phase::LaunchAdmission,
        );
        managed_create_intent::acquire_with_lineage(&discovery_root, &request, lineage)?
    };
    let (mut create_intent, terminal_default_colors) = match intent {
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
                    if !reusable_managed_session(
                        &discovery_root,
                        &request,
                        Some(host_process),
                        ManagedReadyWait::Immediate,
                    )
                    .map_err(|error| error.to_string())?
                    {
                        return Ok(None);
                    }
                    managed_receipt(
                        &request,
                        discovery_root.clone(),
                        ManagedCreateOutcome::Reused,
                        Some(host_process),
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
                    launch_managed_with_handoff_and_lineage(
                        request,
                        presentation_handoff,
                        lineage,
                    )
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
            inject_managed_create_fault("after_create_reservation_before_absence_checkpoint");
            ensure_pre_spawn_discovery_absent(&discovery, &request)?;
            intent.checkpoint_pre_spawn_absence()?;
            let terminal_default_colors =
                intent.resolve_terminal_default_colors(request.terminal_default_colors())?;
            (intent, terminal_default_colors)
        }
    };
    drop(create_maintenance);
    // Mutable launch preconditions are evaluated only for a genuinely
    // prepared spawn. Completed and post-release retries above must be able to
    // recover their durable receipt/fence after a worktree is renamed,
    // unmounted, or removed.
    let provider_cwd = fs::canonicalize(request.provider_cwd())?;
    if !provider_cwd.is_dir() {
        return Err("provider cwd is not a directory".into());
    }
    let (provider_program, provider_args) = resolve_command(request.command());
    let presentation_source = request
        .presentation_predecessor()
        .map(|predecessor| {
            PresentationCheckpointSource::new(
                request.workspace_id(),
                predecessor.session_id(),
                predecessor.runner_principal(),
                predecessor.runner_instance(),
                predecessor.channel_epoch(),
                predecessor.host_instance_id(),
                predecessor.terminal_epoch(),
            )
        })
        .transpose()?;
    let packet = HostLaunchPacket {
        schema: HOST_PACKET_SCHEMA.to_string(),
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
        launch_owner_proof: None,
        retirement_policy: None,
        resurrection_recipe: None,
        presentation_source,
        presentation_handoff,
        conversation_identity: request.conversation_identity().cloned(),
    };
    // Run the injectable/fallible pre-spawn check while the durable state is
    // still `prepared`: a definite failure here can be retried immediately.
    fault_inject_host_spawn_before_start_for_test()?;
    let mut launch_released = false;
    let mut launched_host_process = None;
    if let Err(launch_error) = spawn_host_after_preflight(&packet, |host_process| {
        create_intent.mark_spawn_reserved(host_process.clone())?;
        inject_managed_create_fault("after_spawn_reserved_before_host_release");
        create_intent.release_with_barrier_proof()?;
        launch_released = true;
        launched_host_process = Some(host_process);
        inject_managed_create_fault("after_launch_released_before_packet_write");
        Ok(())
    }) {
        runtime_log(&format!(
            "managed create host wait failed before idempotent reconciliation: {launch_error}"
        ));
        // A concurrent identical broker may have won the logical lifetime lock.
        // Converge on that ready lifetime instead of creating another provider.
        if reusable_managed_session(
            &discovery_root,
            &request,
            launched_host_process.as_ref(),
            ManagedReadyWait::UntilTimeout,
        )? {
            let receipt = managed_receipt(
                &request,
                discovery_root,
                ManagedCreateOutcome::Reused,
                launched_host_process.as_ref(),
            )?;
            return Ok(create_intent.complete(&receipt)?);
        }
        if launch_released && !launch_error.is_uncertain() {
            create_intent.reset_after_definite_pre_ready_failure()?;
        }
        return Err(Box::new(launch_error));
    }
    let receipt = managed_receipt(
        &request,
        discovery_root,
        ManagedCreateOutcome::Created,
        launched_host_process.as_ref(),
    )?;
    let completed = create_intent.complete(&receipt)?;
    inject_managed_create_fault("after_create_ledger_completed_before_broker_receipt");
    Ok(completed)
}

fn managed_receipt(
    request: &ManagedCreateRequest,
    discovery_root: PathBuf,
    outcome: ManagedCreateOutcome,
    expected_host_process: Option<&ProcessDescriptor>,
) -> Result<ManagedCreateReceipt> {
    let root = DiscoveryRoot::open(&discovery_root)?;
    let found = root.find_manifest_by_session(request.workspace_id(), request.session_id())?;
    let ready = match found.manifest {
        DiscoveryManifest::Ready(ready) => ready,
        DiscoveryManifest::Starting(_) => {
            return Err(
                "managed create receipt cannot fence a session that is still starting".into(),
            );
        }
        DiscoveryManifest::Exited(_) => {
            return Err("managed create receipt cannot fence an exited session".into());
        }
    };
    let common = &ready.common;
    if common.session_class != SessionClass::Managed
        || common.provider_id != request.provider_id()
        || common.claim_linkage.kickoff_action_id.as_deref() != Some(request.idempotency_key())
        || expected_host_process
            .is_some_and(|expected| !host_process_proof_matches(&common.host_process, expected))
    {
        return Err(
            "managed create receipt resolved a different managed session generation".into(),
        );
    }
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

#[derive(Clone, Copy)]
enum ManagedReadyWait {
    Immediate,
    UntilTimeout,
}

fn reusable_managed_session(
    discovery_root: &Path,
    request: &ManagedCreateRequest,
    expected_host_process: Option<&ProcessDescriptor>,
    wait: ManagedReadyWait,
) -> Result<bool> {
    if !discovery_root.try_exists()? {
        return Ok(false);
    }
    let root = DiscoveryRoot::open(discovery_root)?;
    let found = match root
        .find_current_manifest_by_session(request.workspace_id(), request.session_id())
    {
        Ok(found) => found,
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound) => return Ok(false),
        Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::MissingManifest,
            ..
        }) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let common = found.manifest.common();
    if common.session_class != SessionClass::Managed
        || common.provider_id != request.provider_id()
        || common.claim_linkage.kickoff_action_id.as_deref() != Some(request.idempotency_key())
        || expected_host_process
            .is_some_and(|expected| !host_process_proof_matches(&common.host_process, expected))
    {
        return Err("managed session identity already belongs to a different spawn request".into());
    }
    match found.manifest {
        DiscoveryManifest::Ready(ref ready)
            if ready.endpoint.kind == LocalEndpointKind::UnixSocket
                && UnixStream::connect(&ready.endpoint.address).is_ok() =>
        {
            Ok(true)
        }
        DiscoveryManifest::Starting(_) => {
            if matches!(wait, ManagedReadyWait::Immediate) {
                return Ok(false);
            }
            let deadline = Instant::now() + READY_TIMEOUT;
            while Instant::now() < deadline {
                thread::sleep(READY_POLL);
                if let Ok(found) =
                    root.find_current_manifest_by_session(
                        request.workspace_id(),
                        request.session_id(),
                    )
                {
                    if let DiscoveryManifest::Ready(ready) = found.manifest {
                        return Ok(ready.common.session_class == SessionClass::Managed
                            && ready.common.provider_id == request.provider_id()
                            && ready.common.claim_linkage.kickoff_action_id.as_deref()
                                == Some(request.idempotency_key())
                            && expected_host_process.is_none_or(|expected| {
                                host_process_proof_matches(&ready.common.host_process, expected)
                            })
                            && UnixStream::connect(&ready.endpoint.address).is_ok());
                    }
                }
            }
            Err("managed session did not become ready in time".into())
        }
        DiscoveryManifest::Exited(_) => {
            Err("managed provider exited; explicit Resume in Hmux is required".into())
        }
        DiscoveryManifest::Ready(_) => Err("managed session endpoint is unavailable".into()),
    }
}

/// Proves only the discovery half of the pre-spawn boundary while shared
/// maintenance excludes discovery GC. A stale or incomplete entry is not
/// absence: unlike a post-reservation launch, a plain Prepared record has no
/// exact process descriptor with which to prove the other half.
fn ensure_pre_spawn_discovery_absent(
    discovery: &DiscoveryRoot,
    request: &ManagedCreateRequest,
) -> Result<()> {
    match discovery.find_manifest_by_session(request.workspace_id(), request.session_id()) {
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound) => Ok(()),
        Ok(_) => Err(
            "managed session predates its durable create ledger; automatic adoption could bind changed launch inputs, so explicit recovery is required"
                .into(),
        ),
        Err(error) => Err(format!(
            "managed pre-spawn discovery absence is not authoritative: {error}"
        )
        .into()),
    }
}

fn host_process_proof_matches(
    actual: &hmux_host::local_protocol::ProcessProof,
    expected: &ProcessDescriptor,
) -> bool {
    actual.process_id == expected.process_id && actual.start_marker == expected.start_marker
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestGuardianCutPhase {
    HostStartingPublished,
    BeforeProviderSpawn,
    ProviderSpawnedBeforeCheckpoint,
    ProviderSpawned,
    HostReadyPublished,
}

impl TestGuardianCutPhase {
    const fn as_str(self) -> &'static str {
        match self {
            Self::HostStartingPublished => "host_starting_published",
            Self::BeforeProviderSpawn => "before_provider_spawn",
            Self::ProviderSpawnedBeforeCheckpoint => "provider_spawned_before_checkpoint",
            Self::ProviderSpawned => "provider_spawned",
            Self::HostReadyPublished => "host_ready_published",
        }
    }
}

#[cfg(debug_assertions)]
fn pause_at_guardian_cut_for_test(phase: TestGuardianCutPhase) -> io::Result<()> {
    if env::var_os(TEST_GUARDIAN_CUT_PHASE_ENV).as_deref()
        != Some(std::ffi::OsStr::new(phase.as_str()))
    {
        return Ok(());
    }
    let marker = env::var_os(TEST_GUARDIAN_CUT_MARKER_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("guardian cut marker is required"))?;
    if !marker.is_absolute() {
        return Err(io::Error::other("guardian cut marker must be absolute"));
    }
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(marker)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    file.write_all(phase.as_str().as_bytes())?;
    file.sync_all()?;
    // SAFETY: SIGSTOP has no handler and stops only this debug-test Host.
    if unsafe { libc::raise(libc::SIGSTOP) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn pause_at_guardian_cut_for_test(_phase: TestGuardianCutPhase) -> io::Result<()> {
    Ok(())
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
        let _ = read_managed_attach_finalization(&mut io::stdin(), &transaction_id)?;
    }
    Ok(())
}

fn prepare_managed_attach(
    request: &hmux_runtime_contract::ManagedAttachRequest,
) -> ManagedAttachBrokerResponse {
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

fn managed_rehost_broker() -> Result<()> {
    let response = match read_managed_rehost_request(&mut io::stdin()) {
        Ok(request) => match managed_rehost::execute(request) {
            Ok(receipt) => ManagedRehostBrokerResponse::Completed(Box::new(receipt)),
            Err(error) => ManagedRehostBrokerResponse::refused(error.code(), error.to_string()),
        },
        Err(error) => ManagedRehostBrokerResponse::refused(
            "hmux_managed_rehost_request_invalid",
            error.to_string(),
        ),
    };
    write_managed_rehost_response(&mut io::stdout(), &response)?;
    Ok(())
}

fn managed_rehost_reconcile_broker() -> Result<()> {
    let response = match read_managed_rehost_reconcile_request(&mut io::stdin()) {
        Ok(request) => match managed_rehost::reconcile(request) {
            Ok(receipt) => ManagedRehostBrokerResponse::Completed(Box::new(receipt)),
            Err(error) => ManagedRehostBrokerResponse::refused(error.code(), error.to_string()),
        },
        Err(error) => ManagedRehostBrokerResponse::refused(
            "hmux_managed_rehost_reconcile_request_invalid",
            error.to_string(),
        ),
    };
    write_managed_rehost_response(&mut io::stdout(), &response)?;
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
enum ManagedStopProviderError {
    Refused(String),
    OutcomeUnknown(String),
    IntentNotFound(String),
    Capacity(String),
}

fn reconcile_managed_stop(
    request: &ManagedStopReconcileRequest,
) -> std::result::Result<ManagedStopReceipt, ManagedStopProviderError> {
    let roots = LocalSessionCatalog::from_environment()
        .map_err(managed_stop_refused)?
        .managed_stop_reconcile_roots()
        .map_err(managed_stop_refused)?;
    let mut matches = Vec::new();
    for discovery_root in roots {
        match managed_stop_intent::reconciliation_exists(&discovery_root, request) {
            Ok(false) => {}
            result => matches.push((discovery_root, result)),
        }
    }
    if matches.len() > 1 {
        return Err(managed_stop_outcome_unknown(
            "managed stop reconciliation is ambiguous across discovery roots",
        ));
    }
    let Some((discovery_root, exists)) = matches.pop() else {
        return Err(ManagedStopProviderError::IntentNotFound(
            "managed stop intent was not found in any configured discovery root".to_string(),
        ));
    };
    exists.map_err(managed_stop_intent_error)?;
    managed_stop_reconcile::reconcile_at(&discovery_root, request)
}

fn managed_stop_intent_error(
    error: managed_stop_intent::ManagedStopIntentError,
) -> ManagedStopProviderError {
    if error.outcome_unknown() {
        managed_stop_outcome_unknown(error)
    } else if error.not_found() {
        ManagedStopProviderError::IntentNotFound(error.to_string())
    } else if error.capacity() {
        ManagedStopProviderError::Capacity(error.to_string())
    } else {
        managed_stop_refused(error)
    }
}

impl ManagedStopProviderError {
    fn code(&self) -> &'static str {
        match self {
            Self::Refused(_) => "hmux_managed_stop_unavailable",
            Self::OutcomeUnknown(_) => "hmux_managed_stop_outcome_unknown",
            Self::IntentNotFound(_) => "hmux_managed_stop_intent_not_found",
            Self::Capacity(_) => "hmux_managed_stop_capacity_exceeded",
        }
    }
}

impl std::fmt::Display for ManagedStopProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(message)
            | Self::OutcomeUnknown(message)
            | Self::IntentNotFound(message)
            | Self::Capacity(message) => formatter.write_str(message),
        }
    }
}

fn managed_stop_refused(error: impl std::fmt::Display) -> ManagedStopProviderError {
    ManagedStopProviderError::Refused(error.to_string())
}

fn managed_stop_outcome_unknown(error: impl std::fmt::Display) -> ManagedStopProviderError {
    ManagedStopProviderError::OutcomeUnknown(error.to_string())
}

fn resolve_managed_stop_discovery_root(
    request: &ManagedStopRequest,
) -> std::result::Result<PathBuf, ManagedStopProviderError> {
    request
        .validate_complete_fence()
        .map_err(managed_stop_refused)?;
    let expected = SessionFence {
        workspace_id: request.workspace_id().to_string(),
        session_id: request.session_id().to_string(),
        runner_principal: request
            .expected_runner_principal()
            .expect("validated managed stop request has a runner principal")
            .to_string(),
        runner_instance: request
            .expected_runner_instance()
            .expect("validated managed stop request has a runner instance")
            .to_string(),
        channel_epoch: request
            .expected_channel_epoch()
            .expect("validated managed stop request has a channel epoch"),
        host_instance_id: request
            .expected_host_instance_id()
            .expect("validated managed stop request has a Host instance")
            .to_string(),
        terminal_epoch: request
            .expected_terminal_epoch()
            .expect("validated managed stop request has a terminal epoch")
            .to_string(),
    };
    let selector = SessionSelector::new(&expected.session_id, Some(expected.workspace_id.clone()));
    LocalSessionCatalog::from_environment()
        .map_err(managed_stop_refused)?
        .resolve_managed_stop_discovery_root(&selector, &expected)
        .map_err(managed_stop_refused)
}

fn refuse_managed_stop_intent(
    intent: &mut managed_stop_intent::ManagedStopIntentGuard,
    request: &ManagedStopRequest,
    error: impl std::fmt::Display,
) -> ManagedStopProviderError {
    let message = error.to_string();
    match intent.refuse(request) {
        Ok(()) => managed_stop_refused(message),
        Err(journal_error) => managed_stop_outcome_unknown(format!(
            "{message}; persist managed stop refusal failed: {journal_error}"
        )),
    }
}

fn stop_managed_provider(
    request: &ManagedStopRequest,
) -> std::result::Result<ManagedStopReceipt, ManagedStopProviderError> {
    let discovery_root = resolve_managed_stop_discovery_root(request)?;
    stop_managed_provider_at(&discovery_root, request)
}

fn stop_managed_provider_at(
    discovery_root: &Path,
    request: &ManagedStopRequest,
) -> std::result::Result<ManagedStopReceipt, ManagedStopProviderError> {
    request
        .validate_complete_fence()
        .map_err(managed_stop_refused)?;
    let reconciliation =
        ManagedStopReconcileRequest::from_stop_request(request).map_err(managed_stop_refused)?;
    match managed_stop_intent::reconcile(discovery_root, &reconciliation) {
        Ok(managed_stop_intent::ManagedStopIntent::Completed(receipt)) => {
            finalize_completed_managed_stop(discovery_root, &receipt)?;
            return Ok(receipt);
        }
        Ok(managed_stop_intent::ManagedStopIntent::Checkpointed { receipt, intent }) => {
            return finalize_checkpointed_managed_stop(discovery_root, receipt, intent);
        }
        Ok(managed_stop_intent::ManagedStopIntent::Refused) => {
            return Err(managed_stop_refused(
                "managed stop was previously refused before provider termination",
            ));
        }
        Ok(managed_stop_intent::ManagedStopIntent::Resume { request, intent }) => {
            return continue_reserved_managed_stop(discovery_root, &request, intent, false);
        }
        Ok(managed_stop_intent::ManagedStopIntent::Pending(_)) => {
            return Err(managed_stop_outcome_unknown(
                "managed stop lookup unexpectedly created a fresh intent",
            ));
        }
        Err(error) if error.not_found() => {}
        Err(error) => return Err(managed_stop_intent_error(error)),
    }
    let root = DiscoveryRoot::open(discovery_root).map_err(managed_stop_refused)?;
    let initial = root
        .find_manifest_by_session(request.workspace_id(), request.session_id())
        .map_err(managed_stop_refused)?;
    validate_managed_stop_fence(request, &initial.manifest).map_err(managed_stop_refused)?;
    if matches!(initial.manifest, DiscoveryManifest::Starting(_)) {
        return Err(managed_stop_refused("managed session is still starting"));
    }
    let intent =
        managed_stop_intent::acquire(discovery_root, request).map_err(managed_stop_intent_error)?;
    match intent {
        managed_stop_intent::ManagedStopIntent::Pending(intent) => {
            continue_reserved_managed_stop(discovery_root, request, intent, true)
        }
        managed_stop_intent::ManagedStopIntent::Resume { request, intent } => {
            continue_reserved_managed_stop(discovery_root, &request, intent, false)
        }
        managed_stop_intent::ManagedStopIntent::Completed(receipt) => {
            finalize_completed_managed_stop(discovery_root, &receipt)?;
            Ok(receipt)
        }
        managed_stop_intent::ManagedStopIntent::Checkpointed { receipt, intent } => {
            finalize_checkpointed_managed_stop(discovery_root, receipt, intent)
        }
        managed_stop_intent::ManagedStopIntent::Refused => Err(managed_stop_refused(
            "managed stop was previously refused before provider termination",
        )),
    }
}

fn continue_reserved_managed_stop(
    discovery_root: &Path,
    request: &ManagedStopRequest,
    mut intent: managed_stop_intent::ManagedStopIntentGuard,
    fresh_admission: bool,
) -> std::result::Result<ManagedStopReceipt, ManagedStopProviderError> {
    if fresh_admission {
        inject_managed_stop_fault("after_reserve");
    }
    let root = DiscoveryRoot::open(discovery_root).map_err(managed_stop_outcome_unknown)?;
    let found = root
        .find_manifest_by_session(request.workspace_id(), request.session_id())
        .map_err(managed_stop_outcome_unknown)?;
    if let Err(error) = validate_managed_stop_fence(request, &found.manifest) {
        return Err(if fresh_admission {
            refuse_managed_stop_intent(&mut intent, request, error)
        } else {
            managed_stop_outcome_unknown(error)
        });
    }
    let target_lifetime = found.manifest.common().lifetime.clone();
    let target_generation = found.manifest.generation();
    let catalog = LocalSessionCatalog::new(discovery_root);
    let (requested_outcome, stop_error) = match &found.manifest {
        DiscoveryManifest::Ready(_) => {
            let session = LocalSession::from_manifest(found.manifest.clone())
                .map_err(managed_stop_outcome_unknown)?;
            let stop_error = match session.managed_attach_authorization_proof() {
                Ok(proof) => match request.expected_conversation() {
                    Some(expected_conversation) => session
                        .stop_managed_fenced_with_proof(
                            &catalog,
                            proof,
                            Duration::from_secs(5),
                            expected_conversation,
                            request.expected_quiescence(),
                        )
                        .err(),
                    None => match request.expected_quiescence() {
                        Some(expected) => session
                            .stop_managed_quiescent_with_proof(
                                &catalog,
                                proof,
                                Duration::from_secs(5),
                                expected,
                            )
                            .err(),
                        None => session
                            .stop_managed_with_proof(&catalog, proof, Duration::from_secs(5))
                            .err(),
                    },
                },
                Err(error) => Some(error),
            };
            if let Some(error) = stop_error
                .as_ref()
                .filter(|_| {
                    request.expected_quiescence().is_some()
                        || request.expected_conversation().is_some()
                })
            {
                return Err(if error.is_definitive_managed_stop_refusal() {
                    refuse_managed_stop_intent(&mut intent, request, error)
                } else {
                    managed_stop_outcome_unknown(error)
                });
            }
            (ManagedStopOutcome::Stopped, stop_error)
        }
        DiscoveryManifest::Exited(_) => (ManagedStopOutcome::AlreadyExited, None),
        DiscoveryManifest::Starting(_) => {
            return Err(managed_stop_outcome_unknown(
                "managed session became starting after stop admission",
            ));
        }
    };
    if let (DiscoveryManifest::Ready(ready), Some(_)) = (&found.manifest, stop_error.as_ref()) {
        let mut acquisition = managed_abandonment::acquire(discovery_root, request, ready)
            .map_err(managed_stop_outcome_unknown)?;
        if matches!(
            acquisition,
            managed_abandonment::AbandonedReadyAcquisition::HostLifetimeOwned
        ) {
            // Conversation/quiescence-fenced requests returned above. Explicit
            // stop must also retire a Host that no longer answers its protocol.
            LocalSession::from_manifest(found.manifest.clone())
                .map_err(managed_stop_outcome_unknown)?
                .terminate_unresponsive_managed(&catalog, Duration::from_secs(1))
                .map_err(managed_stop_outcome_unknown)?;
            acquisition = managed_abandonment::acquire_until(
                discovery_root,
                request,
                ready,
                Instant::now() + Duration::from_secs(1),
            )
            .map_err(managed_stop_outcome_unknown)?;
        }
        if let managed_abandonment::AbandonedReadyAcquisition::Acquired(abandoned) = acquisition {
            (*abandoned)
                .publish_exited()
                .map_err(managed_stop_outcome_unknown)?;
        }
    }
    if requested_outcome == ManagedStopOutcome::Stopped {
        inject_managed_stop_fault("after_provider_stop");
    }
    let descriptor = catalog.find(&SessionSelector::new(
        request.session_id(),
        Some(request.workspace_id().to_string()),
    ));
    let descriptor = descriptor.map_err(managed_stop_outcome_unknown)?;
    if descriptor.runner_principal != target_lifetime.runner_principal
        || descriptor.runner_instance != target_lifetime.runner_instance
        || descriptor.channel_epoch != target_lifetime.channel_epoch.to_string()
        || descriptor.host_instance_id != target_generation.host_instance_id
        || target_generation.terminal_epoch.as_deref() != Some(descriptor.terminal_epoch.as_str())
    {
        return Err(managed_stop_outcome_unknown(
            "managed session identity changed during provider stop",
        ));
    }
    if descriptor.session_class != hmux_client::SessionClass::Managed
        || descriptor.lifecycle != hmux_client::SessionLifecycle::Exited
    {
        if let Some(error) = stop_error {
            return Err(managed_stop_outcome_unknown(error));
        }
        return Err(managed_stop_outcome_unknown(
            "managed session did not publish an exited tombstone",
        ));
    }
    let exit_reason = descriptor
        .exit
        .as_ref()
        .map(|exit| exit.reason.clone())
        .ok_or_else(|| {
            managed_stop_outcome_unknown("managed exited session is missing its exit reason")
        })?;
    if process_session_cleanup_is_incomplete(&exit_reason) {
        if let Some(error) = stop_error {
            return Err(managed_stop_outcome_unknown(error));
        }
        return Err(managed_stop_outcome_unknown(
            "managed provider process-session cleanup is incomplete",
        ));
    }
    let outcome = if stop_error.is_some() {
        // The provider may cross Ready -> Exited between discovery and the
        // stop frame. Exact generation equality above makes that race an
        // idempotent already-exited success, never a different lifetime.
        ManagedStopOutcome::AlreadyExited
    } else {
        requested_outcome
    };
    let receipt = ManagedStopReceipt::from_request(request, outcome, exit_reason)
        .map_err(managed_stop_outcome_unknown)?;
    intent
        .checkpoint_receipt(request, &receipt)
        .map_err(managed_stop_outcome_unknown)?;
    inject_managed_stop_fault("after_stop_receipt_checkpoint");
    finalize_checkpointed_managed_stop(discovery_root, receipt, intent)
}

fn finalize_checkpointed_managed_stop(
    discovery_root: &Path,
    receipt: ManagedStopReceipt,
    mut intent: managed_stop_intent::ManagedStopIntentGuard,
) -> std::result::Result<ManagedStopReceipt, ManagedStopProviderError> {
    hmux_client::recovery_journal::managed_create_ledger::checkpoint_retirement_exact(
        discovery_root,
        &receipt,
    )
    .map_err(managed_stop_outcome_unknown)?;
    inject_managed_stop_fault("after_create_ledger_retirement_checkpoint");
    finalize_completed_managed_stop(discovery_root, &receipt)?;
    inject_managed_stop_fault("after_create_ledger_retirement");
    intent
        .finish_checkpointed(&receipt)
        .map_err(managed_stop_intent_error)?;
    inject_managed_stop_fault("after_stop_intent_completion");
    Ok(receipt)
}

fn finalize_completed_managed_stop(
    discovery_root: &Path,
    receipt: &ManagedStopReceipt,
) -> std::result::Result<(), ManagedStopProviderError> {
    hmux_client::recovery_journal::managed_create_ledger::finalize_retirement_exact(
        discovery_root,
        receipt,
    )
    .map_err(managed_stop_outcome_unknown)?;
    Ok(())
}

#[cfg(debug_assertions)]
fn inject_managed_stop_fault(point: &str) {
    if std::env::var("HMUX_TEST_MANAGED_STOP_FAULT").as_deref() == Ok(point) {
        std::process::exit(86);
    }
}

#[cfg(not(debug_assertions))]
fn inject_managed_stop_fault(_point: &str) {}

fn validate_managed_stop_fence(
    request: &ManagedStopRequest,
    manifest: &DiscoveryManifest,
) -> Result<()> {
    request.validate_complete_fence()?;
    if manifest.common().session_class != SessionClass::Managed {
        return Err("requested session is not managed".into());
    }
    let lifetime = &manifest.common().lifetime;
    let generation = manifest.generation();
    if request
        .expected_runner_principal()
        .is_some_and(|expected| expected != lifetime.runner_principal)
        || request
            .expected_runner_instance()
            .is_some_and(|expected| expected != lifetime.runner_instance)
        || request
            .expected_channel_epoch()
            .is_some_and(|expected| expected != lifetime.channel_epoch)
        || request
            .expected_host_instance_id()
            .is_some_and(|expected| expected != generation.host_instance_id)
        || request
            .expected_terminal_epoch()
            .is_some_and(|expected| generation.terminal_epoch.as_deref() != Some(expected))
    {
        return Err("managed session generation changed before provider stop".into());
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn pause_after_retirement_policy_recipe_publish_for_test() -> io::Result<()> {
    let Some(marker) = env::var_os(RETIREMENT_POLICY_RECIPE_PUBLISHED_MARKER_ENV) else {
        return Ok(());
    };
    let marker = PathBuf::from(marker);
    if !marker.is_absolute() {
        return Err(io::Error::other(
            "retirement policy recipe marker must be absolute",
        ));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(marker)?;
    file.write_all(b"recipe_published")?;
    file.sync_all()?;
    loop {
        thread::park_timeout(Duration::from_secs(60));
    }
}

#[cfg(not(debug_assertions))]
fn pause_after_retirement_policy_recipe_publish_for_test() -> io::Result<()> {
    Ok(())
}

#[cfg(debug_assertions)]
fn pause_after_pty_read_before_ingest_for_test() -> io::Result<()> {
    let Some(marker) = env::var_os(PTY_READ_BEFORE_INGEST_PAUSE_MARKER_ENV) else {
        return Ok(());
    };
    let marker = PathBuf::from(marker);
    if !marker.is_absolute() {
        return Err(io::Error::other(
            "PTY read-before-ingest pause marker must be absolute",
        ));
    }
    let arm = marker.with_extension("arm");
    if !arm.try_exists()? {
        return Ok(());
    }
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&marker)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    file.write_all(b"read_sampled")?;
    file.sync_all()?;
    let release = marker.with_extension("release");
    while !release.try_exists()? {
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn pause_after_pty_read_before_ingest_for_test() -> io::Result<()> {
    Ok(())
}

#[cfg(debug_assertions)]
fn wait_for_managed_stop_cleanup_lock_for_test() {
    let Some(marker) = env::var_os("HMUX_RUNTIME_TEST_MANAGED_STOP_CLEANUP_MARKER") else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while !Path::new(&marker).exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(debug_assertions))]
fn wait_for_managed_stop_cleanup_lock_for_test() {}

#[cfg(debug_assertions)]
fn use_legacy_fenced_stop_barrier_for_test() -> bool {
    env::var_os("HMUX_RUNTIME_TEST_MANAGED_STOP_CLEANUP_MARKER")
        .map(PathBuf::from)
        .is_some_and(|marker| marker.with_extension("legacy").exists())
}

#[cfg(not(debug_assertions))]
fn use_legacy_fenced_stop_barrier_for_test() -> bool {
    false
}

#[cfg(debug_assertions)]
fn fail_terminal_mutation_for_test() -> io::Result<bool> {
    let Some(marker) = env::var_os(TERMINAL_MUTATION_FAULT_MARKER_ENV) else {
        return Ok(false);
    };
    let marker = PathBuf::from(marker);
    if !marker.is_absolute() {
        return Err(io::Error::other(
            "terminal mutation fault marker must be absolute",
        ));
    }
    match fs::remove_file(marker) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(not(debug_assertions))]
fn fail_terminal_mutation_for_test() -> io::Result<bool> {
    Ok(false)
}

#[cfg(debug_assertions)]
fn poison_pty_resize_lock_for_test(writer: &Mutex<pty_io::PtyIo>) -> io::Result<()> {
    let Some(marker) = env::var_os(PTY_RESIZE_LIVENESS_FAULT_MARKER_ENV) else {
        return Ok(());
    };
    let marker = PathBuf::from(marker);
    if !marker.is_absolute() {
        return Err(io::Error::other(
            "PTY resize liveness fault marker must be absolute",
        ));
    }
    let arm = marker.with_extension("arm");
    if !arm.try_exists()? {
        return Ok(());
    }
    let mut observed = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&marker)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    observed.write_all(b"resize_lock_poisoned")?;
    observed.sync_all()?;
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _writer = writer
            .lock()
            .expect("the isolated resize liveness fixture owns a fresh PTY writer lock");
        panic!("fault-injected PTY resize serialization failure");
    }));
    debug_assert!(poisoned.is_err());
    Ok(())
}

#[cfg(not(debug_assertions))]
fn poison_pty_resize_lock_for_test(_: &Mutex<pty_io::PtyIo>) -> io::Result<()> {
    Ok(())
}

#[cfg(debug_assertions)]
fn pause_before_retirement_departure_transition_for_test() -> io::Result<()> {
    let Some(marker) = env::var_os(RETIREMENT_DEPARTURE_BEFORE_TRANSITION_MARKER_ENV) else {
        return Ok(());
    };
    let marker = PathBuf::from(marker);
    if !marker.is_absolute() {
        return Err(io::Error::other(
            "retirement departure transition marker must be absolute",
        ));
    }
    let release = marker.with_extension("release");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&marker)?;
    file.write_all(b"before_transition")?;
    file.sync_all()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !release.is_file() {
        if Instant::now() >= deadline {
            return Err(io::Error::other(
                "retirement departure transition pause timed out",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn pause_before_retirement_departure_transition_for_test() -> io::Result<()> {
    Ok(())
}

struct IdleRetirementGuardian {
    child: Option<std::process::Child>,
}

impl IdleRetirementGuardian {
    fn spawn(provider_pid: u32, provider_start_time: u64) -> io::Result<Self> {
        let host_pid = std::process::id();
        let host_start_time = process_start_time(host_pid)
            .ok_or_else(|| io::Error::other("Host process identity is unavailable"))?;
        let mut command = Command::new(env::current_exe()?);
        command
            .arg(IDLE_RETIREMENT_GUARDIAN_SUBCOMMAND)
            .arg(host_pid.to_string())
            .arg(host_start_time.to_string())
            .arg(provider_pid.to_string())
            .arg(provider_start_time.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: setsid has no pointer arguments and is called in the
        // post-fork, pre-exec child. The guardian must not inherit the Host
        // process group: group-scoped Host cleanup must leave a helper alive
        // to resume the frozen provider session.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        if let Err(error) = wait_for_idle_retirement_guardian_ready(&mut child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(Self { child: Some(child) })
    }

    fn process_id(&self) -> u32 {
        self.child
            .as_ref()
            .expect("uncommitted idle-retirement guardian must own its child")
            .id()
    }

    /// The helper remains detached after the in-process termination worker has
    /// accepted responsibility. It exits when the provider exits, or resumes
    /// the stopped provider group if this Host process generation disappears.
    fn commit(mut self) {
        self.child.take();
    }
}

impl Drop for IdleRetirementGuardian {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn wait_for_idle_retirement_guardian_ready(child: &mut std::process::Child) -> io::Result<()> {
    let mut readiness = child.stdout.take().ok_or_else(|| {
        io::Error::other("idle-retirement guardian readiness pipe is unavailable")
    })?;
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut ack = [0_u8; 1];
        let result = readiness.read_exact(&mut ack).and_then(|()| {
            if ack[0] == IDLE_RETIREMENT_GUARDIAN_READY_ACK {
                Ok(())
            } else {
                Err(io::Error::other(
                    "idle-retirement guardian returned an invalid readiness acknowledgement",
                ))
            }
        });
        let _ = result_tx.send(result);
    });
    let result = match result_rx.recv_timeout(IDLE_RETIREMENT_GUARDIAN_READY_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "idle-retirement guardian did not become ready before the deadline",
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::other(
            "idle-retirement guardian readiness channel disconnected",
        )),
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = reader.join();
    result?;
    if let Some(status) = child.try_wait()? {
        return Err(io::Error::other(format!(
            "idle-retirement guardian exited after readiness acknowledgement: {status}"
        )));
    }
    Ok(())
}

fn idle_retirement_guardian(
    host_pid: u32,
    host_start_time: u64,
    provider_pid: u32,
    provider_start_time: u64,
) -> Result<()> {
    let provider_group =
        libc::pid_t::try_from(provider_pid).map_err(|_| "provider process id is out of range")?;
    if provider_group <= 1 {
        return Err("provider process id is invalid".into());
    }
    pause_or_exit_before_idle_retirement_guardian_ready_for_test()?;
    require_exact_process_generation(host_pid, host_start_time, "Host")?;
    require_exact_process_generation(provider_pid, provider_start_time, "provider")?;
    if !provider_session_leader_matches(provider_group)? {
        return Err("provider no longer owns its POSIX session and process group".into());
    }
    io::stdout().write_all(&[IDLE_RETIREMENT_GUARDIAN_READY_ACK])?;
    io::stdout().flush()?;

    loop {
        match observe_process_generation(provider_pid) {
            Ok(Some(observed)) if observed == provider_start_time => {}
            Ok(Some(_)) | Ok(None) => return Ok(()),
            Err(_) => {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        }
        match observe_process_generation(host_pid) {
            Ok(Some(observed)) if observed == host_start_time => {}
            Ok(Some(_)) | Ok(None) => match observe_process_generation(provider_pid) {
                Ok(Some(observed)) if observed == provider_start_time => {
                    match provider_session_leader_matches(provider_group) {
                        Ok(true) => {}
                        Ok(false) => return Ok(()),
                        Err(_) => {
                            thread::sleep(Duration::from_millis(20));
                            continue;
                        }
                    }
                    // SAFETY: the exact provider start identity, POSIX session,
                    // and process-group ownership were revalidated immediately
                    // above. A negative id targets only that provider group.
                    let result = unsafe { libc::kill(-provider_group, libc::SIGCONT) };
                    if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                    {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Ok(Some(_)) | Ok(None) => return Ok(()),
                Err(_) => {}
            },
            Err(_) => {}
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn observe_process_generation(process_id: u32) -> io::Result<Option<u64>> {
    if let Some(start_time) = process_start_time(process_id) {
        return Ok(Some(start_time));
    }
    let process_id = libc::pid_t::try_from(process_id)
        .map_err(|_| io::Error::other("process id is out of range"))?;
    if process_id <= 1 {
        return Err(io::Error::other("process id is invalid"));
    }
    // SAFETY: signal zero performs no mutation and checks only whether this
    // exact numeric process id currently denotes a process.
    if unsafe { libc::kill(process_id, 0) } == 0 {
        return Err(io::Error::other(
            "process exists but its start identity is unavailable",
        ));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(None)
    } else {
        Err(error)
    }
}

fn require_exact_process_generation(
    process_id: u32,
    expected_start_time: u64,
    label: &str,
) -> io::Result<()> {
    match observe_process_generation(process_id)? {
        Some(observed) if observed == expected_start_time => Ok(()),
        Some(_) => Err(io::Error::other(format!(
            "{label} process generation changed before guardian readiness"
        ))),
        None => Err(io::Error::other(format!(
            "{label} process disappeared before guardian readiness"
        ))),
    }
}

fn provider_session_leader_matches(provider: libc::pid_t) -> io::Result<bool> {
    // SAFETY: getsid/getpgid read kernel process metadata for the exact
    // start-identity-validated provider and dereference no pointers.
    let session = unsafe { libc::getsid(provider) };
    if session == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: see the getsid call above.
    let group = unsafe { libc::getpgid(provider) };
    if group == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(session == provider && group == provider)
}

#[cfg(debug_assertions)]
fn pause_or_exit_before_idle_retirement_guardian_ready_for_test() -> io::Result<()> {
    let Some(fault) = env::var_os(IDLE_RETIREMENT_GUARDIAN_READY_FAULT_ENV) else {
        return Ok(());
    };
    let fault = fault
        .to_str()
        .ok_or_else(|| io::Error::other("guardian readiness fault mode is not UTF-8"))?;
    if let Some(marker_path) =
        env::var_os(IDLE_RETIREMENT_GUARDIAN_READY_FAULT_MARKER_ENV).map(PathBuf::from)
    {
        if !marker_path.is_absolute() {
            return Err(io::Error::other(
                "guardian readiness fault marker must be absolute",
            ));
        }
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(marker_path)?;
        marker.write_all(fault.as_bytes())?;
        marker.sync_all()?;
    }
    match fault {
        "exit" => Err(io::Error::other(
            "fault-injected guardian exit before readiness",
        )),
        "timeout" => loop {
            thread::park_timeout(Duration::from_secs(60));
        },
        _ => Err(io::Error::other("guardian readiness fault mode is invalid")),
    }
}

#[cfg(not(debug_assertions))]
fn pause_or_exit_before_idle_retirement_guardian_ready_for_test() -> io::Result<()> {
    Ok(())
}

#[cfg(debug_assertions)]
fn pause_after_idle_retirement_freeze_for_test(guardian_pid: u32) -> io::Result<()> {
    let Some(marker_path) = env::var_os(IDLE_RETIREMENT_FROZEN_TEST_MARKER_ENV) else {
        return Ok(());
    };
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(marker_path)?;
    writeln!(marker, "{guardian_pid}")?;
    marker.sync_all()?;
    loop {
        thread::park_timeout(Duration::from_secs(60));
    }
}

#[cfg(not(debug_assertions))]
fn pause_after_idle_retirement_freeze_for_test(_guardian_pid: u32) -> io::Result<()> {
    Ok(())
}

fn host() -> Result<()> {
    let packet: HostLaunchPacket = read_json_frame(&mut io::stdin())?;
    validate_packet(&packet)?;
    run_host(packet)
}

fn validate_packet(packet: &HostLaunchPacket) -> Result<()> {
    if packet.schema != HOST_PACKET_SCHEMA
        || !packet.provider_cwd.is_absolute()
        || !packet.discovery_root.is_absolute()
        || packet.provider_program.as_os_str().is_empty()
        || packet.workspace_id.is_empty()
        || packet.session_id.is_empty()
        || packet.provider_id.is_empty()
        || packet.initial_rows == 0
        || packet.initial_columns == 0
        || packet.terminal_default_colors.validate().is_err()
    {
        return Err("Hmux host launch packet is invalid".into());
    }
    match packet.session_class {
        SessionClass::Standalone
            if packet.session_name.as_deref().is_none_or(str::is_empty)
                || packet
                    .launch_owner_proof
                    .as_deref()
                    .is_none_or(str::is_empty)
                || packet.idempotency_key.as_deref().is_some_and(str::is_empty)
                || packet.resurrection_recipe.as_ref().is_some_and(|recipe| {
                    recipe.session_name() != packet.session_name.as_deref().unwrap_or_default()
                        || recipe.provider_cwd() != packet.provider_cwd
                        || recipe.retirement_policy() != packet.retirement_policy
                        || recipe.validate().is_err()
                }) =>
        {
            return Err("standalone Hmux host launch authority is invalid".into());
        }
        SessionClass::Managed
            if packet.session_name.is_some()
                || packet.launch_owner_proof.is_some()
                || packet.retirement_policy.is_some()
                || packet.resurrection_recipe.is_some()
                || packet.idempotency_key.as_deref().is_none_or(str::is_empty) =>
        {
            return Err("managed Hmux host launch authority is invalid".into());
        }
        _ => {}
    }
    if packet
        .retirement_policy
        .is_some_and(|policy| !policy.is_valid())
    {
        return Err("standalone Hmux retirement policy is invalid".into());
    }
    packet.terminal_environment.validate()?;
    packet.provider_state_environment.validate()?;
    if let Some(source) = &packet.presentation_source {
        source.validate()?;
        if source.workspace_id() != packet.workspace_id
            || source.session_id() == packet.session_id
            || source.runner_principal() != "local-user"
        {
            return Err("Hmux presentation predecessor is invalid".into());
        }
    }
    if let Some(handoff) = &packet.presentation_handoff {
        handoff.validate()?;
        if packet.presentation_source.is_none() {
            return Err("Hmux presentation handoff has no predecessor identity".into());
        }
    }
    if let Some(seed) = &packet.conversation_identity {
        seed.validate()?;
        if packet.session_class != SessionClass::Managed || seed.provider_id() != packet.provider_id
        {
            return Err("Hmux conversation identity seed is invalid".into());
        }
    }
    Ok(())
}

fn apply_provider_state_environment(
    command: &mut CommandBuilder,
    environment: &ProviderStateEnvironment,
) {
    for key in environment.removals() {
        command.env_remove(key);
    }
    for (key, value) in environment.values() {
        command.env(key, value);
    }
}

fn run_host(packet: HostLaunchPacket) -> Result<()> {
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
    let mut capabilities = advertised_base_capabilities();
    if packet.session_class == SessionClass::Standalone {
        capabilities.push(STANDALONE_TERMINATION_CAPABILITY.to_string());
        capabilities.push(SESSION_RETIREMENT_CAPABILITY.to_string());
        capabilities.push(SESSION_RETIREMENT_ADMIN_CAPABILITY.to_string());
        capabilities.push(UNPRESENTED_CREATION_ABANDON_CAPABILITY.to_string());
    } else {
        capabilities.extend(managed_host_capabilities());
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
        host_instance_id: host_instance_id.clone(),
        provider_id: packet.provider_id.clone(),
        runtime_context: RuntimeContext {
            runtime_host: Some(hostname()),
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
        // Resolved through the launcher, not read off argv[0]. The desktop
        // starts sessions with `/usr/bin/env NAME=VALUE <program>`, so the raw
        // program name is `env` for every session it creates — a label that is
        // true and useless. `expected_provider_identity_program` is the same
        // resolution the provider-identity check already uses, and it preserves
        // `env` when it cannot see through the options rather than guessing.
        launch_program: launch_program_label(&expected_provider_identity_program(
            &packet.provider_program,
            &packet.provider_args,
        )),
    };
    let root = DiscoveryRoot::create(&packet.discovery_root)?;
    let diagnostics = RuntimeDiagnostics::open(
        &packet.discovery_root,
        RuntimeDiagnosticContext::new(HOST_BUILD_ID, &fence),
    );
    diagnostics.install_panic_hook();
    diagnostics.record(
        RuntimeDiagnosticEvent::HostStarting,
        RuntimeDiagnosticFields::transport("initializing"),
    );
    let discovery_root_generation =
        Arc::new(DiscoveryRootGeneration::capture(&packet.discovery_root)?);
    let discovery_root_lifetime = DiscoveryRootLifetime::new(
        Arc::clone(&discovery_root_generation),
        DISCOVERY_ROOT_REAP_GRACE,
    );
    let recovered_presentation = match (
        packet.presentation_source.as_ref(),
        packet.presentation_handoff.as_ref(),
    ) {
        (Some(source), Some(handoff)) => load_presentation_handoff(&root, source, handoff).ok(),
        (Some(source), None) => load_presentation_checkpoint(&root, source).ok(),
        (None, None) => None,
        (None, Some(_)) => return Err("presentation handoff has no source".into()),
    };
    let (initial_rows, initial_columns) = recovered_presentation
        .as_ref()
        .map(|checkpoint| (checkpoint.rows(), checkpoint.columns()))
        .unwrap_or((packet.initial_rows, packet.initial_columns));
    let discovery = root.session(DiscoveryKey::new(
        packet.workspace_id.clone(),
        packet.session_id.clone(),
        runner_instance.clone(),
        1,
    )?)?;
    let lifetime_lock = Arc::new(discovery.acquire_lifetime_lock()?);
    discovery.publish_starting(
        &lifetime_lock,
        StartingManifest {
            common: common.clone(),
            starting_unix_ms: unix_time_ms(),
        },
    )?;
    pause_at_guardian_cut_for_test(TestGuardianCutPhase::HostStartingPublished)?;

    let runtime_directory = runtime_directory()?;
    // Discovery is scoped by the complete Host generation, so its transport
    // endpoint must be as well. A session id can legitimately recur in another
    // workspace, discovery root, or replacement generation; reusing
    // `<session_id>.sock` let either Host unlink the other's live endpoint.
    // Keep 96 random bits while leaving headroom below macOS `sun_path`.
    let socket_path = runtime_directory.join(format!("{}.sock", &host_nonce[..24]));
    let listener = UnixListener::bind(&socket_path)?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
    let endpoint = LocalEndpoint {
        kind: LocalEndpointKind::UnixSocket,
        address: socket_path.to_string_lossy().into_owned(),
    };
    let capability_token = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: initial_rows,
        cols: initial_columns,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    pause_at_guardian_cut_for_test(TestGuardianCutPhase::BeforeProviderSpawn)?;
    let host_process_descriptor = ProcessDescriptor {
        process_id: host_process.process_id,
        start_marker: host_process.start_marker.clone(),
    };
    let mut provider_gate = if packet.session_class == SessionClass::Managed {
        Some(managed_provider_launch_gate::ManagedProviderLaunchGate::prepare(
            &runtime_directory,
        ))
    } else {
        None
    };
    let mut command = match provider_gate.as_ref() {
        Some(gate) => gate.command(
            &host_process_descriptor,
            &packet.provider_program,
            &packet.provider_args,
        )?,
        None => {
            let mut command = CommandBuilder::new(&packet.provider_program);
            command.args(packet.provider_args.iter());
            command
        }
    };
    command.cwd(&packet.provider_cwd);
    for key in launching_client_session_env_keys(
        std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()),
    ) {
        command.env_remove(key);
    }
    let terminal_policy = interactive_terminal_environment_policy(&packet.terminal_environment);
    for key in terminal_policy.remove() {
        command.env_remove(key);
    }
    for (key, value) in terminal_policy.set() {
        command.env(key, value);
    }
    apply_provider_state_environment(&mut command, &packet.provider_state_environment);
    command.env(HMUX_ENV, "1");
    command.env(HMUX_SESSION_ID_ENV, &packet.session_id);
    command.env(
        HMUX_SESSION_NAME_ENV,
        packet.session_name.as_deref().unwrap_or(&packet.session_id),
    );
    command.env(HMUX_WORKSPACE_ID_ENV, &packet.workspace_id);
    command.env(HMUX_RUNNER_PRINCIPAL_ENV, "local-user");
    command.env(HMUX_RUNNER_INSTANCE_ENV, &runner_instance);
    command.env(HMUX_CHANNEL_EPOCH_ENV, "1");
    command.env(HMUX_HOST_INSTANCE_ID_ENV, &host_instance_id);
    command.env(HMUX_TERMINAL_EPOCH_ENV, &terminal_epoch);
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    if let Some(gate) = provider_gate.as_mut() {
        if let Err(error) = gate.wait_until_armed(&mut *child, READY_TIMEOUT) {
            let process_id = child.process_id();
            cleanup_unproven_provider_child(&mut *child, process_id);
            return Err(error.into());
        }
    }
    let provider_process = match child.process_id() {
        Some(process_id) => match process_proof(process_id) {
            Ok(proof) => proof,
            Err(error) => {
                cleanup_unproven_provider_child(&mut *child, Some(process_id));
                return Err(error);
            }
        },
        None => {
            cleanup_unproven_provider_child(&mut *child, None);
            return Err("provider process id is unavailable".into());
        }
    };
    let provider_pid = provider_process.process_id;
    let provider_process_session = match OwnedProcessSession::new(provider_pid) {
        Ok(session) => session,
        Err(error) => {
            cleanup_unproven_provider_child(&mut *child, Some(provider_pid));
            return Err(error.into());
        }
    };
    pause_at_guardian_cut_for_test(TestGuardianCutPhase::ProviderSpawnedBeforeCheckpoint)?;
    // OwnedProcessSession proves provider_pid is the POSIX session leader.
    // Publish the managed Starting checkpoint only after that typed proof, so
    // recovery can use its durable provider PID as the exact numeric SID for
    // a later complete-session absence census.
    if packet.session_class == SessionClass::Managed {
        let idempotency_key = packet
            .idempotency_key
            .as_deref()
            .ok_or("managed Host lost its create idempotency key")?;
        let generation = ManagedStartingGeneration::new(
            idempotency_key,
            host_process_descriptor,
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
        .with_provider_containment(ManagedStartingProviderContainment::PosixSessionV1)?;
        if let Err(error) = managed_create_ledger::checkpoint_starting_generation_exact(
            &packet.discovery_root,
            &packet.workspace_id,
            &packet.session_id,
            idempotency_key,
            generation,
        ) {
            cleanup_unproven_provider_child(&mut *child, Some(provider_pid));
            return Err(error.into());
        }
    }
    if let Some(gate) = provider_gate.as_mut() {
        if let Err(error) = gate.release_after_checkpoint(READY_TIMEOUT) {
            cleanup_unproven_provider_child(&mut *child, Some(provider_pid));
            return Err(error.into());
        }
    }
    drop(provider_gate);
    pause_at_guardian_cut_for_test(TestGuardianCutPhase::ProviderSpawned)?;
    let provider_start_time = process_start_time(provider_pid);
    let provider_identity_program =
        expected_provider_identity_program(&packet.provider_program, &packet.provider_args);
    let pty_fd = pair
        .master
        .as_raw_fd()
        .ok_or("native PTY master does not expose its file descriptor")?;
    set_nonblocking(pty_fd)?;
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let master = pair.master;

    #[cfg(feature = "terminal-state-stream")]
    let recovered_terminal_checkpoint = recovered_presentation
        .as_ref()
        .map(PresentationCheckpoint::terminal_checkpoint);
    #[cfg(feature = "terminal-state-stream")]
    let mut session_host = match SessionHost::new_with_durable_terminal_history(
        fence.clone(),
        provider_process.clone(),
        initial_rows,
        initial_columns,
        terminal_replay_limits()?,
        1,
        DurableTerminalHistory::new(
            &discovery,
            Arc::clone(&lifetime_lock),
            recovered_terminal_checkpoint.as_ref(),
        )
        .with_terminal_default_colors(packet.terminal_default_colors),
    ) {
        Ok(host) => host,
        Err(error) => {
            cleanup_unproven_provider_child(&mut *child, Some(provider_pid));
            return Err(error.into());
        }
    };
    #[cfg(not(feature = "terminal-state-stream"))]
    let mut session_host = SessionHost::new_with_default_colors(
        fence.clone(),
        provider_process.clone(),
        initial_rows,
        initial_columns,
        terminal_replay_limits()?,
        1,
        packet.terminal_default_colors,
    )?;
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
    if let Some(checkpoint) = recovered_presentation {
        #[cfg(feature = "terminal-state-stream")]
        let terminal_checkpoint = recovered_terminal_checkpoint
            .clone()
            .unwrap_or_else(|| checkpoint.terminal_checkpoint());
        #[cfg(not(feature = "terminal-state-stream"))]
        let terminal_checkpoint = checkpoint.terminal_checkpoint();
        if let Err(error) = session_host.restore_checkpoint(
            &fence,
            checkpoint.recovered_presentation(),
            terminal_checkpoint,
        ) {
            runtime_log(&format!(
                "optional presentation restore was skipped: {error}"
            ));
        }
    }
    session_host.observe_working_directory(
        &fence,
        WorkingDirectoryObservation::new(
            packet.provider_cwd.to_string_lossy(),
            hmux_host::local_protocol::WorkingDirectorySource::LaunchFallback,
        ),
    )?;
    session_host.observe_execution_location(&fence, ExecutionLocationObservation::local())?;
    session_host
        .observe_agent_identity(&fence, AgentIdentityObservation::process_inspection(None))?;

    let (termination_tx, termination_rx) = mpsc::sync_channel(1);
    let resources = HostResourceBudget::new(HostResourceLimits {
        max_pending_connections: HOST_MAX_PENDING_CONNECTIONS,
        max_active_connections: HOST_MAX_ACTIVE_CONNECTIONS,
        reserved_priority_connections: HOST_RESERVED_PRIORITY_CONNECTIONS,
        max_queued_bytes: HOST_MAX_SUBSCRIBER_QUEUED_BYTES,
    });
    let state = Arc::new(ServerState {
        common: common.clone(),
        discovery: discovery.clone(),
        discovery_root: packet.discovery_root.clone(),
        lifetime_lock: Arc::clone(&lifetime_lock),
        fence: fence.clone(),
        diagnostics,
        resources,
        host_process,
        host: Mutex::new(session_host),
        #[cfg(feature = "terminal-state-stream")]
        agent_prompt_admission:
            agent_prompt_admission::AgentPromptAdmissionSignal::default(),
        pty_fd,
        pty_writer: Mutex::new(pty_io::PtyIo::new(writer)),
        pty_input_serial: Mutex::new(()),
        controller_submit: Mutex::new(controller_input::SubmitScanner::default()),
        pty_master: Mutex::new(master),
        controller: Mutex::new(None),
        launch_owner_proof: Mutex::new(packet.launch_owner_proof),
        managed_authorization_grants: Mutex::new(ManagedAuthorizationGrants::new(
            MANAGED_AUTHORIZATION_GRANT_TTL,
            MAX_MANAGED_AUTHORIZATION_GRANTS,
        )),
        subscribers: SubscriberRegistry::new(),
        publish_order: Mutex::new(()),
        attachments: Mutex::new(HashSet::new()),
        next_client: AtomicU64::new(1),
        #[cfg(feature = "terminal-state-stream")]
        next_terminal_state_record: AtomicU64::new(1),
        #[cfg(feature = "terminal-state-stream")]
        terminal_surfaces: Mutex::new(TerminalSurfaceActor::default()),
        #[cfg(feature = "terminal-state-stream")]
        viewport_publication: ViewportProjectionPublication::new(),
        #[cfg(feature = "terminal-state-stream")]
        viewport_capture_budget: ViewportCaptureBudget::new(),
        retirement_policy: Mutex::new(packet.retirement_policy),
        resurrection_recipe: Mutex::new(packet.resurrection_recipe.clone()),
        retirement_timer: RetirementTimer::default(),
        provider_pid,
        provider_start_time,
        provider_program: provider_identity_program,
        termination_tx,
        termination_transition: Mutex::new(()),
        termination_barrier: Mutex::new(()),
        termination_barrier_complete: AtomicBool::new(false),
        termination_requested: AtomicBool::new(false),
        provider_exit_observed: AtomicBool::new(false),
        discovery_root_retired: AtomicBool::new(false),
        attach_gate: Mutex::new(()),
        stopped: Mutex::new(false),
    });
    if packet.session_class == SessionClass::Standalone {
        let retirement_state = Arc::downgrade(&state);
        state.retirement_timer.start(move |generation| {
            if let Some(state) = retirement_state.upgrade() {
                state.finish_armed_idle_retirement(generation);
            }
        })?;
    }
    let ready = ReadyManifest {
        common: common.clone(),
        provider_process,
        terminal_epoch,
        ready_output_seq: 0,
        endpoint: endpoint.clone(),
        capability_token: capability_token.clone(),
        ready_unix_ms: unix_time_ms(),
    };
    let checkpoint_writer = PresentationCheckpointWriter::spawn(
        Arc::new(ServerCheckpointSource {
            state: Arc::clone(&state),
        }),
        Box::new(SessionCheckpointSink::new(
            discovery.clone(),
            Arc::clone(&lifetime_lock),
        )),
        state.diagnostics.clone(),
    )?;
    #[cfg(feature = "terminal-state-stream")]
    lock(&state.host)?.activate_durable_terminal_history(&fence)?;
    discovery.publish_ready(&lifetime_lock, ready)?;
    pause_at_guardian_cut_for_test(TestGuardianCutPhase::HostReadyPublished)?;
    state.diagnostics.record(
        RuntimeDiagnosticEvent::HostReady,
        RuntimeDiagnosticFields::transport("listening").with_resources(state.resources.snapshot()),
    );

    configure_accept_listener(&listener)?;
    let accept_state = Arc::clone(&state);
    let accept_token = capability_token.clone();
    let accept_thread = thread::spawn(move || accept_loop(listener, accept_state, accept_token));
    let output_state = Arc::clone(&state);
    let (output_done_tx, output_done_rx) = mpsc::sync_channel(1);
    let output_thread = thread::spawn(move || {
        output_loop(reader, pty_fd, output_state);
        let _ = output_done_tx.send(());
    });
    #[cfg(feature = "terminal-state-stream")]
    let viewport_state = Arc::clone(&state);
    #[cfg(feature = "terminal-state-stream")]
    let viewport_thread = thread::spawn(move || viewport_projection_loop(viewport_state));
    let identity_state = Arc::clone(&state);
    let identity_thread =
        thread::spawn(move || runtime_identity_loop(provider_pid, identity_state));
    let discovery_root_path = packet.discovery_root.clone();
    let discovery_root_state = Arc::clone(&state);
    let discovery_root_thread = thread::spawn(move || {
        discovery_root_lifetime_loop(
            &discovery_root_path,
            discovery_root_lifetime,
            discovery_root_state,
        )
    });

    let provider_process_control = ProviderProcessControl::new(
        &state.termination_transition,
        &state.provider_exit_observed,
        &state.pty_master,
    );
    let completion = wait_for_provider(
        &mut child,
        &termination_rx,
        provider_process_session,
        provider_process_control,
    )?;
    #[cfg(feature = "terminal-state-stream")]
    state.agent_prompt_admission.notify();
    state.retirement_timer.shutdown()?;
    if completion.terminated {
        *lock(&state.stopped)? = true;
    }
    let output_drained = output_done_rx.recv_timeout(OUTPUT_DRAIN_TIMEOUT).is_ok();
    if output_drained {
        let _ = output_thread.join();
    }
    #[cfg(feature = "terminal-state-stream")]
    if output_drained {
        let deadline = Instant::now() + OUTPUT_DRAIN_TIMEOUT;
        loop {
            if lock(&state.host)?.reconcile_terminal_history(&fence)? {
                break;
            }
            if Instant::now() >= deadline {
                return Err("terminal history did not publish before provider completion".into());
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
    #[cfg(feature = "terminal-state-stream")]
    {
        // `provider_exit_observed` is already published. Crossing the attach
        // gate now lets any earlier registration finish; `serve_client`'s
        // guarded admission check refuses every later one before final seal.
        {
            let _attach_admission = lock_attach_gate(&state.attach_gate);
        }
        let has_view_projections = lock(&state.terminal_surfaces)?
            .surfaces
            .values()
            .any(|surface| surface.projection.is_some());
        if has_view_projections && !output_drained {
            return Err("terminal output did not drain before viewport completion".into());
        }
        if state.close_terminal_viewport_publication().is_none() {
            return Err("terminal viewport projector did not close at its final generation".into());
        }
    }
    let provider_termination_requested = completion.terminated;
    let mut exit_status = provider_exit_status(
        &completion.status,
        provider_termination_requested,
        output_drained,
    );
    let (completed, final_checkpoint) = {
        let mut host = lock(&state.host)?;
        let final_checkpoint = host.current_checkpoint()?;
        let conversation_identity_present = host
            .current_snapshot(ScreenSnapshotProfile::ViewportOnly)?
            .provider_conversation_identity
            .is_some();
        exit_status.failure = managed_session_failure(
            packet.session_class,
            &fence,
            &exit_status,
            completion.terminated,
            conversation_identity_present,
        );
        let completed = host.complete_provider(&fence, exit_status)?;
        let broadcasts = completed
            .final_snapshot
            .agent_runtime_state
            .clone()
            .map(FrameBody::AgentRuntimeState)
            .into_iter()
            .collect();
        state.broadcast_after_host(host, broadcasts);
        #[cfg(feature = "terminal-state-stream")]
        state.agent_prompt_admission.notify();
        (completed, final_checkpoint)
    };
    state.diagnostics.record(
        RuntimeDiagnosticEvent::ProviderExit,
        RuntimeDiagnosticFields::provider_exit(
            completed.tombstone.exit_kind.as_str(),
            completed.tombstone.exit.exit_code,
            completed.tombstone.exit.final_output_seq,
        ),
    );
    if completed.final_snapshot.sequence_through != completed.tombstone.exit.final_output_seq {
        return Err("provider completion output fence mismatch".into());
    }
    let discovery_root_retired = state.discovery_root_retired.load(Ordering::Acquire)
        || discovery_root_generation.is_retired(&packet.discovery_root);
    if discovery_root_retired {
        state.discovery_root_retired.store(true, Ordering::Release);
    }
    if discovery_root_retired {
        if !checkpoint_writer.shutdown(RootRetired) {
            return Err("presentation checkpoint writer shutdown timed out".into());
        }
    } else {
        match checkpoint_writer.finalize(final_checkpoint) {
            FinalFlushOutcome::Durable { .. } => {}
            FinalFlushOutcome::Degraded {
                failure_code: CheckpointFailureCode::StaleSnapshot,
                ..
            } => return Err("final presentation checkpoint sequence regressed".into()),
            FinalFlushOutcome::Degraded {
                failure_code: CheckpointFailureCode::WorkerUnavailable,
                ..
            } => return Err("final presentation checkpoint writer timed out".into()),
            FinalFlushOutcome::Degraded { .. } => {
                runtime_log(
                    "final presentation checkpoint durability is degraded; inspect typed runtime diagnostics",
                );
            }
        }
    }
    #[cfg(feature = "terminal-state-stream")]
    state
        .agent_prompt_admission
        .seal_and_wait_for_publications()?;
    state.broadcast(FrameBody::Exit(completed.tombstone.exit.clone()));
    let conversation_writer_owner = (common.session_class == SessionClass::Managed).then(|| {
        (
            common.lifetime.workspace_id.clone(),
            common.lifetime.session_id.clone(),
        )
    });
    let publish_error = if discovery_root_retired {
        None
    } else {
        let mut exited_common = common;
        exited_common.retirement_policy = *lock(&state.retirement_policy)?;
        discovery
            .publish_exited(
                &lifetime_lock,
                ExitedManifest {
                    common: exited_common,
                    tombstone: Box::new(completed.tombstone),
                    endpoint,
                    capability_token,
                    exited_unix_ms: unix_time_ms(),
                },
            )
            .err()
    };
    if !discovery_root_retired {
        if let Some((workspace_id, session_id)) = conversation_writer_owner {
            if let Err(error) = managed_create_ledger::release_exited_conversation_writer(
                &packet.discovery_root,
                &workspace_id,
                &session_id,
            ) {
                runtime_log(&format!(
                    "managed conversation writer exit checkpoint is degraded: {error}"
                ));
            }
        }
    }
    *lock(&state.stopped)? = true;
    #[cfg(feature = "terminal-state-stream")]
    state.viewport_publication.close();
    #[cfg(feature = "terminal-state-stream")]
    state.close_attachment_viewport_workers();
    #[cfg(feature = "terminal-state-stream")]
    let _ = viewport_thread.join();
    let _ = identity_thread.join();
    let _ = discovery_root_thread.join();
    finish_host_connections(&state, accept_thread, &socket_path, provider_termination_requested)?;
    if publish_error.is_none()
        && !discovery_root_retired
        && packet.session_class == SessionClass::Standalone
        && provider_termination_requested
    {
        let generation = discovery.read_manifest()?.generation();
        let _ = discovery.retire_exited_current(&lifetime_lock, &generation);
    }
    let _ = fs::remove_file(&socket_path);
    if let Some(error) = publish_error {
        return Err(error.into());
    }
    Ok(())
}

fn managed_session_failure(
    session_class: SessionClass,
    fence: &SessionFence,
    status: &ProviderExitStatus,
    terminated: bool,
    conversation_identity_present: bool,
) -> Option<SessionFailureCapsule> {
    if session_class != SessionClass::Managed || terminated {
        return None;
    }
    let (code, phase, summary) = if !conversation_identity_present {
        let summary = match status.exit_code {
            Some(exit_code) => format!(
                "Managed provider exited with status {exit_code} before conversation identity was established."
            ),
            None => {
                "Managed provider exited before conversation identity was established.".to_string()
            }
        };
        (
            "provider_exited_before_conversation_identity",
            SessionFailurePhase::ConversationIdentity,
            summary,
        )
    } else if status.kind != ProviderExitKind::Normal {
        let summary = match status.exit_code {
            Some(exit_code) => format!("Managed provider exited with status {exit_code}."),
            None => "Managed provider exited unexpectedly.".to_string(),
        };
        (
            "provider_exited",
            SessionFailurePhase::ProviderRuntime,
            summary,
        )
    } else {
        return None;
    };
    Some(SessionFailureCapsule {
        correlation_id: format!("failure_{}", Uuid::new_v4().simple()),
        session_id: fence.session_id.clone(),
        workspace_id: fence.workspace_id.clone(),
        terminal_epoch: fence.terminal_epoch.clone(),
        code: code.to_string(),
        phase,
        summary,
        exit_kind: status.kind,
        exit_code: status.exit_code,
        occurred_unix_ms: status.created_unix_ms,
        retry_posture: SessionFailureRetryPosture::Never,
    })
}

fn terminal_replay_limits() -> Result<TerminalReplayLimits> {
    let limits = TerminalReplayLimits {
        max_snapshot_bytes: FrameLimits::default().max_snapshot_bytes,
        ..TerminalReplayLimits::default()
    };
    #[cfg(all(debug_assertions, feature = "terminal-state-stream"))]
    let limits = {
        let mut limits = limits;
        if let Some(value) = env::var_os(MAX_PENDING_HISTORY_TRANSFER_BYTES_TEST_ENV) {
            let value = value
                .to_str()
                .ok_or("history transfer byte test limit must be UTF-8")?
                .parse::<usize>()
                .map_err(|_| "history transfer byte test limit must be an integer")?;
            if value == 0 {
                return Err("history transfer byte test limit must be non-zero".into());
            }
            limits.max_pending_history_transfer_bytes = value;
        }
        limits
    };
    Ok(limits)
}

fn discovery_root_lifetime_loop(
    discovery_root: &Path,
    mut lifetime: DiscoveryRootLifetime,
    state: Arc<ServerState>,
) {
    loop {
        thread::sleep(DISCOVERY_ROOT_POLL_INTERVAL);
        if state.stopped.lock().map_or(true, |stopped| *stopped) {
            return;
        }
        if lifetime.inspect(discovery_root, Instant::now()) == RootLifetimeDecision::Retire {
            runtime_log("discovery root generation disappeared; retiring owned provider session");
            state.discovery_root_retired.store(true, Ordering::Release);
            let _ = state.request_provider_termination(ProviderTermination::DiscoveryRootRetired);
            return;
        }
    }
}

fn load_presentation_checkpoint(
    root: &DiscoveryRoot,
    source: &PresentationCheckpointSource,
) -> Result<PresentationCheckpoint> {
    let key = source.discovery_key()?;
    let discovery = root.open_session(key)?;
    discovery
        .read_presentation_checkpoint(source)?
        .ok_or_else(|| "required presentation checkpoint is missing".into())
}

fn load_presentation_handoff(
    root: &DiscoveryRoot,
    source: &PresentationCheckpointSource,
    handoff: &PresentationCheckpointHandoff,
) -> Result<PresentationCheckpoint> {
    let discovery = root.open_session(source.discovery_key()?)?;
    Ok(discovery.read_presentation_handoff(source, handoff)?)
}

struct ServerState {
    common: ManifestCommon,
    discovery: SessionDiscovery,
    discovery_root: PathBuf,
    lifetime_lock: Arc<LifetimeLock>,
    fence: SessionFence,
    diagnostics: RuntimeDiagnostics,
    resources: Arc<HostResourceBudget>,
    host_process: ProcessProof,
    host: Mutex<SessionHost>,
    #[cfg(feature = "terminal-state-stream")]
    agent_prompt_admission: agent_prompt_admission::AgentPromptAdmissionSignal,
    pty_fd: RawFd,
    /// Serializes terminal I/O transactions. In addition to writes, a PTY read
    /// stays under this lock until the Host ingests it, and resize holds it
    /// across both the kernel and Host geometry mutations.
    pty_writer: Mutex<pty_io::PtyIo>,
    pty_input_serial: Mutex<()>,
    /// Tracks accepted controller input for submit keystrokes: only a submit
    /// asserts working(ControllerInput). A typed-but-unsubmitted draft used to
    /// pin activity=working with no TTL and no demotion path (the same-seq
    /// guard drops inference on a quiet screen), showing an idle agent as
    /// busy indefinitely.
    controller_submit: Mutex<controller_input::SubmitScanner>,
    pty_master: Mutex<Box<dyn MasterPty + Send>>,
    controller: Mutex<Option<u64>>,
    launch_owner_proof: Mutex<Option<String>>,
    managed_authorization_grants: Mutex<ManagedAuthorizationGrants>,
    subscribers: SubscriberRegistry,
    /// Serializes the order in which Host mutations enter client FIFOs without
    /// keeping the terminal state lock across payload projection or queues.
    publish_order: Mutex<()>,
    /// Every committed protocol attachment, independent of delivery
    /// backpressure. Subscriber eviction must never manufacture "last client".
    attachments: Mutex<HashSet<u64>>,
    next_client: AtomicU64,
    #[cfg(feature = "terminal-state-stream")]
    next_terminal_state_record: AtomicU64,
    #[cfg(feature = "terminal-state-stream")]
    terminal_surfaces: Mutex<TerminalSurfaceActor>,
    #[cfg(feature = "terminal-state-stream")]
    viewport_publication: ViewportProjectionPublication,
    #[cfg(feature = "terminal-state-stream")]
    viewport_capture_budget: Arc<ViewportCaptureBudget>,
    retirement_policy: Mutex<Option<SessionRetirementPolicy>>,
    resurrection_recipe: Mutex<Option<StandaloneResurrectionRecipe>>,
    retirement_timer: RetirementTimer,
    provider_pid: u32,
    provider_start_time: Option<u64>,
    provider_program: PathBuf,
    termination_tx: mpsc::SyncSender<ProviderTermination>,
    termination_transition: Mutex<()>,
    termination_barrier: Mutex<()>,
    termination_barrier_complete: AtomicBool,
    termination_requested: AtomicBool,
    provider_exit_observed: AtomicBool,
    discovery_root_retired: AtomicBool,
    attach_gate: Mutex<()>,
    stopped: Mutex<bool>,
}

struct RetirementHandling {
    receipt: Option<SessionRetirementReceipt>,
    close_after_receipt: bool,
}

impl RetirementHandling {
    fn preserved(
        request_id: String,
        policy: Option<SessionRetirementPolicy>,
        reason: SessionRetirementReceiptReason,
        close_after_receipt: bool,
    ) -> Self {
        Self {
            receipt: Some(SessionRetirementReceipt {
                request_id,
                state: SessionRetirementReceiptState::SessionPreserved,
                reason: Some(reason),
                policy,
            }),
            close_after_receipt,
        }
    }

    fn refused(
        request_id: String,
        policy: Option<SessionRetirementPolicy>,
        reason: SessionRetirementReceiptReason,
        close_after_receipt: bool,
    ) -> Self {
        Self {
            receipt: Some(SessionRetirementReceipt {
                request_id,
                state: SessionRetirementReceiptState::Refused,
                reason: Some(reason),
                policy,
            }),
            close_after_receipt,
        }
    }

    fn receipt_unsafe() -> Self {
        Self {
            receipt: None,
            close_after_receipt: true,
        }
    }
}

enum ConfigureRetirementPolicyError {
    ReceiptSafe(SessionRetirementReceiptReason),
    ReceiptUnsafe,
}

fn quarantine_uncertain_retirement_policy(
    discovery_root: &Path,
    session_name: &str,
    current_policy: &mut Option<SessionRetirementPolicy>,
    current_recipe: &mut Option<StandaloneResurrectionRecipe>,
    retirement_timer: &RetirementTimer,
    schedule: &mut RetirementSchedule,
) {
    if let Ok(observed) = read_resurrection_recipe(discovery_root, session_name) {
        *current_recipe = Some(observed);
    }
    // Cross-file durability is no longer provable. Keep the provider alive and
    // disable automatic retirement in this Host generation. The connection is
    // closed without a receipt, so the caller cannot mistake this quarantine
    // for either a committed update or a proven rollback.
    *current_policy = None;
    schedule.cancel_and_advance();
    retirement_timer.notify_changed();
}

struct ServerCheckpointSource {
    state: Arc<ServerState>,
}

impl PresentationSnapshotSource for ServerCheckpointSource {
    fn current_version(&self) -> Option<CheckpointVersion> {
        self.state.host.lock().ok().map(|host| {
            let (rows, columns) = host.current_dimensions();
            CheckpointVersion {
                sequence_through: host.current_output_seq(),
                rows,
                columns,
            }
        })
    }

    fn current_checkpoint(&self) -> Option<TerminalCheckpoint> {
        self.state
            .host
            .lock()
            .ok()
            .and_then(|mut host| host.current_checkpoint().ok())
    }
}

impl ServerState {
    fn issue_managed_authorization_grant(&self) -> Result<String> {
        lock(&self.managed_authorization_grants)?
            .issue(Instant::now())
            .ok_or_else(|| "managed authorization grant capacity is exhausted".into())
    }

    fn authorize_managed_connection(
        &self,
        proof: Option<&str>,
        scoped_grant_required: bool,
        legacy_proof: &str,
    ) -> Result<bool> {
        Ok(lock(&self.managed_authorization_grants)?.authorize(
            proof,
            Instant::now(),
            scoped_grant_required,
            legacy_proof,
        ))
    }

    fn request_provider_termination(&self, request: ProviderTermination) -> bool {
        let Ok(_transition) = self.termination_transition.lock() else {
            return false;
        };
        if self.provider_exit_observed.load(Ordering::Acquire) {
            return false;
        }
        // Attach holds this gate only through snapshot/subscriber registration,
        // never through socket I/O. Taking it before the state transition makes
        // attach admission and termination one linearizable boundary.
        let _attach = lock_attach_gate(&self.attach_gate);
        if self.termination_requested.load(Ordering::Acquire) {
            drop(_attach);
            drop(_transition);
            let _barrier = self.termination_barrier.lock();
            return self.termination_barrier_complete.load(Ordering::Acquire);
        }
        if !self.enqueue_provider_termination_locked(request) {
            return false;
        }
        drop(_attach);
        drop(_transition);

        self.complete_termination_barrier();
        true
    }

    fn request_managed_provider_termination(&self) -> bool {
        self.request_provider_termination(ProviderTermination::ManagedClientRequest)
    }

    fn request_managed_provider_termination_at(
        &self,
        expected_quiescence: Option<&ManagedProviderStopQuiescenceFence>,
        expected_conversation: Option<&ManagedProviderStopConversationFence>,
    ) -> std::result::Result<(), OperationReceiptReason> {
        let transition = self
            .termination_transition
            .lock()
            .map_err(|_| OperationReceiptReason::ResourceLimit)?;
        if self.provider_exit_observed.load(Ordering::Acquire) {
            return Err(OperationReceiptReason::HostExiting);
        }
        let attach = lock_attach_gate(&self.attach_gate);
        if self.termination_requested.load(Ordering::Acquire) {
            drop(attach);
            drop(transition);
            let _barrier = self
                .termination_barrier
                .lock()
                .map_err(|_| OperationReceiptReason::ResourceLimit)?;
            return self
                .termination_barrier_complete
                .load(Ordering::Acquire)
                .then_some(())
                .ok_or(OperationReceiptReason::HostExiting);
        }

        // A pending compound input is not a quiescent boundary. Refuse the
        // quiescence-fenced stop instead of waiting behind a full PTY. A plain
        // or conversation-fenced stop can cancel that input at its next step.
        let input = if expected_quiescence.is_some() {
            Some(
                pty_io::try_lock_input(&self.pty_input_serial)
                    .ok_or(OperationReceiptReason::AgentRuntimeChanged)?,
            )
        } else {
            None
        };
        // Accepted input takes the PTY writer before publishing its semantic
        // runtime change under the Host lock. Matching that lock order makes
        // the quiescence compare and termination CAS one linearizable cut.
        let writer = lock_pty_writer_preserving_liveness(&self.pty_writer, "quiescent stop");
        let host = lock(&self.host).map_err(|_| OperationReceiptReason::ResourceLimit)?;
        if let Some(expected) = expected_quiescence {
            if !host
                .matches_agent_runtime_quiescence(&self.fence, expected)
                .map_err(|_| OperationReceiptReason::AgentRuntimeChanged)?
            {
                return Err(OperationReceiptReason::AgentRuntimeChanged);
            }
        }
        if let Some(expected) = expected_conversation {
            let snapshot = host
                .current_snapshot(ScreenSnapshotProfile::ViewportOnly)
                .map_err(|_| OperationReceiptReason::AgentRuntimeChanged)?;
            let actual = snapshot.provider_conversation_identity.as_deref();
            if !managed_stop_fence::matches_provider_conversation(
                &self.common.provider_id,
                expected,
                actual,
            ) {
                return Err(OperationReceiptReason::AgentRuntimeChanged);
            }
        }
        if !self.enqueue_provider_termination_locked(ProviderTermination::ManagedClientRequest) {
            return Err(OperationReceiptReason::HostExiting);
        }
        let legacy_barrier = use_legacy_fenced_stop_barrier_for_test();
        drop(host);
        drop(writer);
        drop(input);
        if legacy_barrier {
            drop(attach);
            drop(transition);
            wait_for_managed_stop_cleanup_lock_for_test();
            self.complete_termination_barrier();
        } else {
            // Provider cleanup takes termination_transition before the PTY
            // master. Complete the mutation barrier while that cleanup is
            // still excluded, then acknowledge admission independently of it.
            self.complete_termination_barrier();
            drop(attach);
            drop(transition);
        }
        Ok(())
    }

    /// Called while `attach_gate` is held at the attach commit point.
    fn register_attachment_locked(&self, client_id: u64) -> Result<usize> {
        let count = {
            let mut attachments = lock(&self.attachments)?;
            attachments.insert(client_id);
            attachments.len()
        };
        let mut schedule = self
            .retirement_timer
            .lock_schedule()
            .map_err(|_| "retirement timer schedule lock is poisoned")?;
        schedule.cancel_and_advance();
        drop(schedule);
        self.retirement_timer.notify_changed();
        Ok(count)
    }

    /// Removes one protocol attachment from lifecycle accounting. Delivery
    /// subscriber eviction and repeated cleanup are intentionally independent
    /// and idempotent.
    fn remove_attachment_locked(&self, client_id: u64) -> Result<usize> {
        let mut attachments = lock(&self.attachments)?;
        attachments.remove(&client_id);
        Ok(attachments.len())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn retire_attachment(&self, client_id: u64) {
        let attach = lock_attach_gate(&self.attach_gate);
        if let Ok(mut attachments) = self.attachments.lock() {
            attachments.remove(&client_id);
        }
        let _ = self.subscribers.remove(client_id);
        drop(attach);
        release_client_control(self, client_id);
        #[cfg(feature = "terminal-state-stream")]
        self.remove_terminal_surface(client_id);
    }

    fn current_retirement_policy(&self) -> Result<Option<SessionRetirementPolicy>> {
        Ok(*lock(&self.retirement_policy)?)
    }

    fn idle_retirement_decision_locked(
        &self,
        other_attachments: usize,
        authorized: bool,
    ) -> IdleRetirementDecision {
        let provider_identity_matches = self.provider_start_time.is_some()
            && process_start_time(self.provider_pid) == self.provider_start_time;
        let snapshot = complete_process_snapshot_for_retirement(self.provider_pid);
        evaluate_idle_retirement(IdleRetirementInput {
            authorized,
            other_attachments,
            provider_exited: self.provider_exit_observed.load(Ordering::Acquire),
            provider_pid: self.provider_pid,
            provider_identity_matches,
            expected_program: self.provider_program.to_string_lossy().as_ref(),
            snapshot: snapshot.as_ref(),
        })
    }

    fn read_ready_retirement_policy_exact(
        &self,
        expected: &ManifestGeneration,
    ) -> std::result::Result<Option<SessionRetirementPolicy>, SessionRetirementReceiptReason> {
        let manifest = self
            .discovery
            .read_manifest()
            .map_err(|_| SessionRetirementReceiptReason::PersistenceUnavailable)?;
        if manifest.generation() != *expected {
            return Err(SessionRetirementReceiptReason::GenerationChanged);
        }
        let DiscoveryManifest::Ready(ready) = manifest else {
            return Err(SessionRetirementReceiptReason::GenerationChanged);
        };
        Ok(ready.common.retirement_policy)
    }

    /// Publish one exact manifest policy and close an uncertain post-rename
    /// directory-sync result by readback plus one identical retry.
    fn persist_ready_retirement_policy_exact(
        &self,
        expected: &ManifestGeneration,
        policy: Option<SessionRetirementPolicy>,
    ) -> std::result::Result<(), SessionRetirementReceiptReason> {
        let first =
            self.discovery
                .update_ready_retirement_policy(&self.lifetime_lock, expected, policy);
        let observed = self.read_ready_retirement_policy_exact(expected)?;
        if observed != policy {
            return Err(if first.is_err() {
                SessionRetirementReceiptReason::PersistenceUnavailable
            } else {
                SessionRetirementReceiptReason::GenerationChanged
            });
        }
        if first.is_ok() {
            return Ok(());
        }

        self.discovery
            .update_ready_retirement_policy(&self.lifetime_lock, expected, policy)
            .map_err(|_| SessionRetirementReceiptReason::PersistenceUnavailable)?;
        if self.read_ready_retirement_policy_exact(expected)? != policy {
            return Err(SessionRetirementReceiptReason::GenerationChanged);
        }
        Ok(())
    }

    /// Persist a policy update to both the exact live manifest generation and
    /// its standalone resurrection recipe.
    ///
    /// The canonical resurrection recipe is the reboot authority, so publish
    /// and verify it before changing the live Ready manifest. A Host crash
    /// before that rename recovers the previous policy; a crash after it
    /// recovers the next policy and the replacement Host republishes one
    /// matching Ready manifest. A receipt is emitted only after both resources
    /// and in-memory state match exactly.
    fn configure_retirement_policy_locked(
        &self,
        policy: Option<SessionRetirementPolicy>,
    ) -> std::result::Result<(), ConfigureRetirementPolicyError> {
        use ConfigureRetirementPolicyError::{ReceiptSafe, ReceiptUnsafe};

        if self.common.session_class != SessionClass::Standalone
            || policy.is_some_and(|policy| !policy.is_valid())
        {
            return Err(ReceiptSafe(SessionRetirementReceiptReason::ManagedSession));
        }
        let current = self
            .discovery
            .read_manifest()
            .map_err(|_| ReceiptSafe(SessionRetirementReceiptReason::PersistenceUnavailable))?;
        let expected = current.generation();
        if expected.host_instance_id != self.fence.host_instance_id
            || expected.terminal_epoch.as_deref() != Some(self.fence.terminal_epoch.as_str())
        {
            return Err(ReceiptSafe(
                SessionRetirementReceiptReason::GenerationChanged,
            ));
        }
        // Acquire every in-memory destination before crossing either durable
        // write. A poisoned lock must not leave the manifest updated without
        // a recipe rollback path or return a receipt for state this Host
        // cannot project consistently.
        let mut current_policy = lock(&self.retirement_policy)
            .map_err(|_| ReceiptSafe(SessionRetirementReceiptReason::HostExiting))?;
        let previous_policy = *current_policy;
        let mut current_recipe = lock(&self.resurrection_recipe)
            .map_err(|_| ReceiptSafe(SessionRetirementReceiptReason::HostExiting))?;
        let updated_recipe = {
            let recipe = current_recipe.as_ref().ok_or(ReceiptSafe(
                SessionRetirementReceiptReason::PersistenceUnavailable,
            ))?;
            rebuild_resurrection_recipe_with_policy(recipe, policy)
                .map_err(|_| ReceiptSafe(SessionRetirementReceiptReason::PersistenceUnavailable))?
        };
        let mut schedule = self
            .retirement_timer
            .lock_schedule()
            .map_err(|_| ReceiptSafe(SessionRetirementReceiptReason::HostExiting))?;

        let recipe = current_recipe.as_ref().cloned().ok_or(ReceiptSafe(
            SessionRetirementReceiptReason::PersistenceUnavailable,
        ))?;
        let recipe_name = recipe.session_name().to_string();
        let _recipe_lock = lock_source(
            &self.discovery_root,
            SAVED_RECIPE_RECOVERY_NAMESPACE,
            &recipe_name,
        )
        .map_err(|_| ReceiptSafe(SessionRetirementReceiptReason::PersistenceUnavailable))?;
        if !read_resurrection_recipe(&self.discovery_root, &recipe_name)
            .is_ok_and(|durable| durable == recipe)
        {
            return Err(ReceiptSafe(
                SessionRetirementReceiptReason::PersistenceUnavailable,
            ));
        }
        let prepared = prepare_resurrection_recipe(&self.discovery_root, &updated_recipe)
            .map_err(|_| ReceiptSafe(SessionRetirementReceiptReason::PersistenceUnavailable))?;

        let recipe_published = match prepared.commit() {
            Ok(()) => true,
            Err(error)
                if error.stage() == RecipePublicationFailureStage::PublishedDurableReadback =>
            {
                read_resurrection_recipe(&self.discovery_root, &recipe_name)
                    .is_ok_and(|durable| durable == updated_recipe)
            }
            Err(error) if error.stage() == RecipePublicationFailureStage::Unpublished => {
                let previous_is_exact =
                    read_resurrection_recipe(&self.discovery_root, &recipe_name)
                        .is_ok_and(|durable| durable == recipe)
                        && self.read_ready_retirement_policy_exact(&expected).ok()
                            == Some(previous_policy);
                if previous_is_exact {
                    return Err(ReceiptSafe(
                        SessionRetirementReceiptReason::PersistenceUnavailable,
                    ));
                }
                false
            }
            Err(_) => {
                let rolled_back = save_resurrection_recipe(&self.discovery_root, &recipe).is_ok()
                    && read_resurrection_recipe(&self.discovery_root, &recipe_name)
                        .is_ok_and(|durable| durable == recipe)
                    && self.read_ready_retirement_policy_exact(&expected).ok()
                        == Some(previous_policy);
                if rolled_back {
                    return Err(ReceiptSafe(
                        SessionRetirementReceiptReason::PersistenceUnavailable,
                    ));
                }
                save_resurrection_recipe(&self.discovery_root, &updated_recipe).is_ok()
                    && read_resurrection_recipe(&self.discovery_root, &recipe_name)
                        .is_ok_and(|durable| durable == updated_recipe)
            }
        };
        if !recipe_published {
            quarantine_uncertain_retirement_policy(
                &self.discovery_root,
                &recipe_name,
                &mut current_policy,
                &mut current_recipe,
                &self.retirement_timer,
                &mut schedule,
            );
            return Err(ReceiptUnsafe);
        }

        if pause_after_retirement_policy_recipe_publish_for_test().is_err() {
            quarantine_uncertain_retirement_policy(
                &self.discovery_root,
                &recipe_name,
                &mut current_policy,
                &mut current_recipe,
                &self.retirement_timer,
                &mut schedule,
            );
            return Err(ReceiptUnsafe);
        }

        if let Err(reason) = self.persist_ready_retirement_policy_exact(&expected, policy) {
            let rolled_back = save_resurrection_recipe(&self.discovery_root, &recipe).is_ok()
                && read_resurrection_recipe(&self.discovery_root, &recipe_name)
                    .is_ok_and(|durable| durable == recipe)
                && self
                    .persist_ready_retirement_policy_exact(&expected, previous_policy)
                    .is_ok();
            if rolled_back {
                return Err(ReceiptSafe(reason));
            }

            // An uncertain manifest write may already have published the next
            // value. Prefer completing the canonical recipe's next value over
            // returning a refusal whose reboot result would contradict it.
            let forward_completed = save_resurrection_recipe(&self.discovery_root, &updated_recipe)
                .is_ok()
                && read_resurrection_recipe(&self.discovery_root, &recipe_name)
                    .is_ok_and(|durable| durable == updated_recipe)
                && self
                    .persist_ready_retirement_policy_exact(&expected, policy)
                    .is_ok();
            if !forward_completed {
                quarantine_uncertain_retirement_policy(
                    &self.discovery_root,
                    &recipe_name,
                    &mut current_policy,
                    &mut current_recipe,
                    &self.retirement_timer,
                    &mut schedule,
                );
                return Err(ReceiptUnsafe);
            }
        }
        if self.read_ready_retirement_policy_exact(&expected).ok() != Some(policy) {
            quarantine_uncertain_retirement_policy(
                &self.discovery_root,
                &recipe_name,
                &mut current_policy,
                &mut current_recipe,
                &self.retirement_timer,
                &mut schedule,
            );
            return Err(ReceiptUnsafe);
        }
        *current_recipe = Some(updated_recipe);
        *current_policy = policy;
        schedule.cancel_and_advance();
        drop(schedule);
        self.retirement_timer.notify_changed();
        Ok(())
    }

    /// Freeze the exact provider POSIX session, verify a final stable empty
    /// census, then make termination visible to the provider worker before
    /// transferring the stopped session out of the rollback guard.
    ///
    /// The external guardian survives a Host crash during the stopped window
    /// and resumes the provider group unless the provider exits first.
    fn enqueue_idle_retirement_locked(
        &self,
    ) -> std::result::Result<bool, SessionRetirementReceiptReason> {
        let expected_start = self
            .provider_start_time
            .ok_or(SessionRetirementReceiptReason::ProviderIdentityChanged)?;
        if process_start_time(self.provider_pid) != Some(expected_start) {
            return Err(SessionRetirementReceiptReason::ProviderIdentityChanged);
        }
        let owned = OwnedProcessSession::new(self.provider_pid)
            .map_err(|_| SessionRetirementReceiptReason::ProcessObservationUnavailable)?;
        let guardian = IdleRetirementGuardian::spawn(self.provider_pid, expected_start)
            .map_err(|_| SessionRetirementReceiptReason::ProcessObservationUnavailable)?;
        let guardian_pid = guardian.process_id();
        let Some(frozen) = owned
            .freeze_for_idle_retirement(expected_start, process_start_time)
            .map_err(|_| SessionRetirementReceiptReason::ProcessObservationUnavailable)?
        else {
            return Err(SessionRetirementReceiptReason::ProviderBusy);
        };
        pause_after_idle_retirement_freeze_for_test(guardian_pid)
            .map_err(|_| SessionRetirementReceiptReason::ProcessObservationUnavailable)?;
        if !self.enqueue_provider_termination_locked(ProviderTermination::IdleRetirement) {
            return Ok(false);
        }
        frozen.commit();
        guardian.commit();
        Ok(true)
    }

    fn arm_idle_retirement_locked(&self, grace_period_ms: u64) -> Result<()> {
        {
            let mut schedule = self
                .retirement_timer
                .lock_schedule()
                .map_err(|_| "retirement timer schedule lock is poisoned")?;
            schedule.arm_after(Duration::from_millis(grace_period_ms));
        }
        self.retirement_timer.notify_changed();
        Ok(())
    }

    fn finish_armed_idle_retirement(&self, generation: u64) {
        let Ok(transition) = self.termination_transition.lock() else {
            return;
        };
        let attach = lock_attach_gate(&self.attach_gate);
        let armed = self
            .retirement_timer
            .lock_schedule()
            .is_ok_and(|schedule| schedule.is_armed(generation));
        if !armed || self.termination_requested.load(Ordering::Acquire) {
            return;
        }
        let attachment_count = match self.attachments.lock() {
            Ok(attachments) => attachments.len(),
            Err(_) => return,
        };
        let policy_configured = self
            .retirement_policy
            .lock()
            .is_ok_and(|policy| policy.is_some());
        let decision = self.idle_retirement_decision_locked(attachment_count, policy_configured);
        let mut complete_barrier = false;
        let mut retry_observation = match decision {
            IdleRetirementDecision::Preserve(reason) => retryable_idle_retirement_reason(reason),
            IdleRetirementDecision::Eligible => false,
        };
        if decision == IdleRetirementDecision::Eligible {
            match self.enqueue_idle_retirement_locked() {
                Ok(complete) => complete_barrier = complete,
                Err(reason) => retry_observation = retryable_idle_retirement_reason(reason),
            }
        }
        if let Ok(mut schedule) = self.retirement_timer.lock_schedule() {
            let retried = retry_observation
                && schedule.retry_after_if_armed(
                    generation,
                    RETIREMENT_OBSERVATION_RETRY_BASE,
                    RETIREMENT_OBSERVATION_MAX_RETRIES,
                );
            if !retried {
                schedule.clear_if_armed(generation);
            }
        }
        self.retirement_timer.notify_changed();
        drop(attach);
        drop(transition);
        if complete_barrier {
            self.complete_termination_barrier();
        }
    }

    fn handle_session_retirement(
        self: &Arc<Self>,
        client_id: u64,
        request: SessionRetirementRequest,
        retirement_admin: bool,
        unpresented_creation_abandon: bool,
    ) -> RetirementHandling {
        let policy = self.current_retirement_policy().ok().flatten();
        if matches!(
            request.action,
            SessionRetirementAction::GracefulClientDeparture
        ) && pause_before_retirement_departure_transition_for_test().is_err()
        {
            return RetirementHandling::refused(
                request.request_id,
                policy,
                SessionRetirementReceiptReason::HostExiting,
                false,
            );
        }
        if request.expected_fence != self.fence {
            return RetirementHandling::refused(
                request.request_id,
                policy,
                SessionRetirementReceiptReason::GenerationChanged,
                matches!(
                    request.action,
                    SessionRetirementAction::GracefulClientDeparture
                ),
            );
        }
        if self.common.session_class != SessionClass::Standalone {
            return RetirementHandling::refused(
                request.request_id,
                policy,
                SessionRetirementReceiptReason::ManagedSession,
                false,
            );
        }
        let action_requires_admin = matches!(
            request.action,
            SessionRetirementAction::Configure { .. } | SessionRetirementAction::Sweep { .. }
        );
        let action_requires_creation_authority = matches!(
            request.action,
            SessionRetirementAction::AbandonUnpresentedCreationV1
        );
        if action_requires_admin != retirement_admin
            || action_requires_creation_authority != unpresented_creation_abandon
        {
            return RetirementHandling::refused(
                request.request_id,
                policy,
                SessionRetirementReceiptReason::UnsupportedAction,
                false,
            );
        }

        let Ok(transition) = self.termination_transition.lock() else {
            return RetirementHandling::refused(
                request.request_id,
                policy,
                SessionRetirementReceiptReason::HostExiting,
                false,
            );
        };
        let attach = lock_attach_gate(&self.attach_gate);
        if self.termination_requested.load(Ordering::Acquire) {
            return RetirementHandling::refused(
                request.request_id,
                policy,
                SessionRetirementReceiptReason::HostExiting,
                false,
            );
        }
        // Policy updates use these same transition gates. Re-read only after
        // acquiring them so departure authorization, grace, and the receipt
        // all describe the latest durable policy generation.
        let policy = self.current_retirement_policy().ok().flatten();

        let mut complete_barrier = false;
        let handling = match request.action {
            SessionRetirementAction::AbandonUnpresentedCreationV1 => {
                let attach_history_unchanged = self
                    .retirement_timer
                    .lock_schedule()
                    .is_ok_and(|schedule| schedule.generation() == 1);
                let sole_creator_attachment = self.attachments.lock().is_ok_and(|attachments| {
                    attachments.len() == 1 && attachments.contains(&client_id)
                });
                let owns_creation_controller = self
                    .controller
                    .lock()
                    .is_ok_and(|controller| *controller == Some(client_id));
                if !attach_history_unchanged
                    || !sole_creator_attachment
                    || !owns_creation_controller
                {
                    RetirementHandling::preserved(
                        request.request_id,
                        policy,
                        SessionRetirementReceiptReason::OtherClientsAttached,
                        false,
                    )
                } else {
                    match self.idle_retirement_decision_locked(0, true) {
                        IdleRetirementDecision::Eligible => {
                            match self.enqueue_idle_retirement_locked() {
                                Ok(true) => {
                                    complete_barrier = true;
                                    RetirementHandling {
                                        receipt: Some(SessionRetirementReceipt {
                                            request_id: request.request_id,
                                            state: SessionRetirementReceiptState::RetirementArmed,
                                            reason: None,
                                            policy,
                                        }),
                                        close_after_receipt: true,
                                    }
                                }
                                Ok(false) => RetirementHandling::refused(
                                    request.request_id,
                                    policy,
                                    SessionRetirementReceiptReason::HostExiting,
                                    true,
                                ),
                                Err(reason) => RetirementHandling::preserved(
                                    request.request_id,
                                    policy,
                                    reason,
                                    false,
                                ),
                            }
                        }
                        IdleRetirementDecision::Preserve(reason) => {
                            RetirementHandling::preserved(request.request_id, policy, reason, false)
                        }
                    }
                }
            }
            SessionRetirementAction::Configure { policy } => {
                match self.configure_retirement_policy_locked(policy) {
                    Ok(()) => RetirementHandling {
                        receipt: Some(SessionRetirementReceipt {
                            request_id: request.request_id,
                            state: SessionRetirementReceiptState::PolicyUpdated,
                            reason: None,
                            policy,
                        }),
                        close_after_receipt: false,
                    },
                    Err(ConfigureRetirementPolicyError::ReceiptSafe(reason)) => {
                        RetirementHandling::refused(
                            request.request_id,
                            self.current_retirement_policy().ok().flatten(),
                            reason,
                            false,
                        )
                    }
                    Err(ConfigureRetirementPolicyError::ReceiptUnsafe) => {
                        RetirementHandling::receipt_unsafe()
                    }
                }
            }
            SessionRetirementAction::GracefulClientDeparture => {
                let remaining = self
                    .remove_attachment_locked(client_id)
                    .unwrap_or(usize::MAX);
                match self.idle_retirement_decision_locked(remaining, policy.is_some()) {
                    IdleRetirementDecision::Eligible
                    | IdleRetirementDecision::Preserve(
                        SessionRetirementReceiptReason::ProcessObservationUnavailable,
                    ) => {
                        let grace_period_ms =
                            policy.map_or(0, SessionRetirementPolicy::grace_period_ms);
                        match self.arm_idle_retirement_locked(grace_period_ms) {
                            Ok(()) => RetirementHandling {
                                receipt: Some(SessionRetirementReceipt {
                                    request_id: request.request_id,
                                    state: SessionRetirementReceiptState::RetirementArmed,
                                    reason: None,
                                    policy,
                                }),
                                close_after_receipt: true,
                            },
                            Err(_) => RetirementHandling::refused(
                                request.request_id,
                                policy,
                                SessionRetirementReceiptReason::HostExiting,
                                true,
                            ),
                        }
                    }
                    IdleRetirementDecision::Preserve(reason) => {
                        RetirementHandling::preserved(request.request_id, policy, reason, true)
                    }
                }
            }
            SessionRetirementAction::Sweep { apply } => {
                let others = self
                    .attachments
                    .lock()
                    .map(|attachments| attachments.len())
                    .unwrap_or(usize::MAX);
                match self.idle_retirement_decision_locked(others, true) {
                    IdleRetirementDecision::Eligible if !apply => RetirementHandling {
                        receipt: Some(SessionRetirementReceipt {
                            request_id: request.request_id,
                            state: SessionRetirementReceiptState::Eligible,
                            reason: None,
                            policy,
                        }),
                        close_after_receipt: false,
                    },
                    IdleRetirementDecision::Eligible => {
                        match self.enqueue_idle_retirement_locked() {
                            Ok(true) => {
                                complete_barrier = true;
                                RetirementHandling {
                                    receipt: Some(SessionRetirementReceipt {
                                        request_id: request.request_id,
                                        state: SessionRetirementReceiptState::RetirementArmed,
                                        reason: None,
                                        policy,
                                    }),
                                    close_after_receipt: true,
                                }
                            }
                            Ok(false) => RetirementHandling::refused(
                                request.request_id,
                                policy,
                                SessionRetirementReceiptReason::HostExiting,
                                true,
                            ),
                            Err(reason) => RetirementHandling::preserved(
                                request.request_id,
                                policy,
                                reason,
                                false,
                            ),
                        }
                    }
                    IdleRetirementDecision::Preserve(reason) => {
                        RetirementHandling::preserved(request.request_id, policy, reason, false)
                    }
                }
            }
        };
        drop(attach);
        drop(transition);
        if complete_barrier {
            self.complete_termination_barrier();
        }
        handling
    }

    /// Called only while `termination_transition` and `attach_gate` are both
    /// held, in that order.
    fn enqueue_provider_termination_locked(&self, request: ProviderTermination) -> bool {
        if self.provider_exit_observed.load(Ordering::Acquire)
            || self
                .termination_requested
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return false;
        }
        #[cfg(feature = "terminal-state-stream")]
        self.agent_prompt_admission.notify();
        let Ok(_barrier) = self.termination_barrier.lock() else {
            self.termination_requested.store(false, Ordering::Release);
            return false;
        };
        match self.termination_tx.try_send(request) {
            Ok(()) | Err(mpsc::TrySendError::Full(_)) => true,
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.termination_requested.store(false, Ordering::Release);
                false
            }
        }
    }

    fn complete_termination_barrier(&self) {
        // The main loop receives termination before this barrier. A
        // nonblocking PTY write observes the state transition and releases
        // promptly even when the provider stopped reading.
        let _input = self.pty_input_serial.lock();
        let _writer = self.pty_writer.lock();
        let _master = self.pty_master.lock();
        let _host = self.host.lock();
        self.termination_barrier_complete
            .store(true, Ordering::Release);
    }

    fn resize_terminal(
        &self,
        controller_generation: u64,
        rows: u16,
        columns: u16,
    ) -> std::result::Result<(), OperationReceiptReason> {
        if self.provider_exit_observed.load(Ordering::Acquire) {
            return Err(OperationReceiptReason::HostExiting);
        }
        #[cfg(feature = "terminal-state-stream")]
        let _mutation =
            TerminalSurfaceMutation::begin(&self.terminal_surfaces, &self.viewport_publication)
                .map_err(|_| OperationReceiptReason::HostExiting)?;
        self.resize_terminal_with_admission(Some(controller_generation), rows, columns)
    }

    fn resize_terminal_with_admission(
        &self,
        controller_generation: Option<u64>,
        rows: u16,
        columns: u16,
    ) -> std::result::Result<(), OperationReceiptReason> {
        match self.perform_resize_terminal(controller_generation, rows, columns) {
            Ok(()) => Ok(()),
            Err(failure) => {
                self.diagnostics.record(
                    RuntimeDiagnosticEvent::TerminalResizeFailed,
                    RuntimeDiagnosticFields::terminal_resize_failed(failure.stage, failure.cause),
                );
                Err(failure.reason)
            }
        }
    }

    fn perform_resize_terminal(
        &self,
        controller_generation: Option<u64>,
        rows: u16,
        columns: u16,
    ) -> std::result::Result<(), ResizeOperationFailure> {
        if self.termination_requested.load(Ordering::Acquire) {
            return Err(ResizeOperationFailure::new(
                OperationReceiptReason::HostExiting,
                "admission",
                "host_exiting",
            ));
        }
        if rows == 0 || columns == 0 {
            return Err(ResizeOperationFailure::new(
                OperationReceiptReason::InvalidTerminalDimensions,
                "admission",
                "invalid_dimensions",
            ));
        }
        poison_pty_resize_lock_for_test(&self.pty_writer).map_err(|_| {
            ResizeOperationFailure::new(
                OperationReceiptReason::PlatformResizeFailed,
                "fault_setup",
                "fixture_unavailable",
            )
        })?;
        let _pty_io = lock_resize_resource(&self.pty_writer, "pty_io", "pty_io_lock")?;
        let master = lock_resize_resource(&self.pty_master, "pty_master", "pty_master_lock")?;
        let mut host = self.host.lock().map_err(|_| {
            ResizeOperationFailure::new(
                OperationReceiptReason::ResourceLimit,
                "host_lock",
                "poisoned_lock",
            )
        })?;
        let admitted_generation =
            controller_generation.unwrap_or_else(|| host.controller_generation());
        let prepared = host
            .prepare_resize(&self.fence, admitted_generation, rows, columns)
            .map_err(|error| {
                runtime_log(&format!(
                    "terminal resize preparation failed before the platform boundary: {error}"
                ));
                classify_resize_preparation_failure(error)
            })?;
        master
            .resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                runtime_log(&format!("terminal PTY platform resize failed: {error}"));
                ResizeOperationFailure::new(
                    OperationReceiptReason::PlatformResizeFailed,
                    "pty_platform",
                    "platform_api",
                )
            })?;
        let presentation_degradation = prepared.commit().map_err(|error| {
            runtime_log(&format!(
                "terminal resize commit failed after the platform boundary: {error}"
            ));
            classify_resize_commit_failure(error)
        })?;
        #[cfg(not(feature = "terminal-state-stream"))]
        let _ = presentation_degradation;
        #[cfg(feature = "terminal-state-stream")]
        {
            let output_sequence = host.current_output_seq();
            drop(host);
            drop(master);
            if let Some(degradation) = presentation_degradation {
                self.diagnostics.record(
                    RuntimeDiagnosticEvent::TerminalPresentationDegraded,
                    RuntimeDiagnosticFields::terminal_presentation_degraded(
                        terminal_presentation_degradation_code(degradation),
                        output_sequence,
                    ),
                );
            }
            let _ = self.viewport_publication.mark_dirty();
        }
        Ok(())
    }

    fn broadcast(&self, body: FrameBody) {
        let Ok(_publish_order) = self.publish_order.lock() else {
            return;
        };
        self.broadcast_ordered(body);
    }

    fn enqueue_client_ordered(
        &self,
        delivery: &Arc<SubscriberDelivery>,
        body: FrameBody,
    ) -> Result<()> {
        let _publish_order = lock(&self.publish_order)?;
        let mut prepared = PreparedFrame::new(body);
        if delivery.deliver(&mut prepared) {
            Ok(())
        } else {
            Err("Hmux client outbound queue is no longer available".into())
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn enqueue_terminal_record_ordered(
        &self,
        delivery: &Arc<SubscriberDelivery>,
        record: terminal_state_protocol::TerminalStateRecord,
    ) -> Result<()> {
        let terminal_base_protocol_minor = delivery
            .terminal_base_protocol_minor()
            .unwrap_or(TERMINAL_STATE_BASE_PROTOCOL_MINOR);
        let prepared = Self::prepare_structured_batch(
            record,
            terminal_base_protocol_minor,
            delivery.supports_viewport_multipart(),
        )?;
        let _publish_order = lock(&self.publish_order)?;
        let batch = self.sequence_prepared_structured_batch(prepared)?;
        if delivery.deliver_structured(&batch) {
            Ok(())
        } else {
            Err("Hmux client terminal record queue is no longer available".into())
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn broadcast_terminal_record_ordered(
        &self,
        record: terminal_state_protocol::TerminalStateRecord,
    ) -> bool {
        let prepared =
            match Self::prepare_structured_batch(record, TERMINAL_STATE_BASE_PROTOCOL_MINOR, false)
            {
                Ok(prepared) => prepared,
                Err(error) => {
                    eprintln!("hmux-runtime: terminal event encoding failed: {error}");
                    return false;
                }
            };
        let batch = match self.sequence_prepared_structured_batch(prepared) {
            Ok(batch) => batch,
            Err(error) => {
                eprintln!("hmux-runtime: terminal event sequencing failed: {error}");
                return false;
            }
        };
        let deliveries = match self.subscribers.snapshot() {
            Ok(deliveries) => deliveries,
            Err(error) => {
                eprintln!("hmux-runtime: terminal event subscribers unavailable: {error}");
                return false;
            }
        };
        let failed = deliveries
            .into_iter()
            .filter_map(|(client_id, delivery)| {
                (!delivery.deliver_structured(&batch)).then_some((client_id, delivery))
            })
            .collect::<Vec<_>>();
        for (client_id, delivery) in failed {
            let _ = self.subscribers.remove_if_same(client_id, &delivery);
        }
        true
    }

    fn broadcast_after_host(
        &self,
        host: std::sync::MutexGuard<'_, SessionHost>,
        bodies: Vec<FrameBody>,
    ) {
        let Ok(_publish_order) = self.publish_order.lock() else {
            return;
        };
        drop(host);
        for body in bodies {
            self.broadcast_ordered(body);
        }
    }

    /// Publishes while `publish_order` is held and the Host state lock is not.
    fn broadcast_ordered(&self, body: FrameBody) {
        let deliveries = match self.subscribers.snapshot() {
            Ok(deliveries) => deliveries,
            Err(_) => return,
        };
        let mut frame = PreparedFrame::new(body);
        let failed = deliveries
            .into_iter()
            .filter_map(|(client_id, delivery)| {
                (!delivery.deliver(&mut frame)).then_some((client_id, delivery))
            })
            .collect::<Vec<_>>();
        if failed.is_empty() {
            return;
        }
        for (client_id, failed_delivery) in failed {
            let _ = self.subscribers.remove_if_same(client_id, &failed_delivery);
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn prepare_structured_batch(
        record: terminal_state_protocol::TerminalStateRecord,
        terminal_base_protocol_minor: u8,
        viewport_multipart: bool,
    ) -> Result<(Vec<Vec<u8>>, Option<String>)> {
        use terminal_state_protocol::terminal_state_record;

        let viewport_terminal_epoch = matches!(
            record.body.as_ref(),
            Some(terminal_state_record::Body::ViewportFrame(_))
        )
        .then(|| record.terminal_epoch.clone());
        let encoded =
            prepare_structured_record(record, terminal_base_protocol_minor, viewport_multipart)?;
        Ok((encoded, viewport_terminal_epoch))
    }

    #[cfg(feature = "terminal-state-stream")]
    fn sequence_prepared_structured_batch(
        &self,
        mut prepared: (Vec<Vec<u8>>, Option<String>),
    ) -> Result<StructuredStateBatch> {
        sequence_prepared_structured_record(&self.next_terminal_state_record, &mut prepared.0)?;
        match prepared.1 {
            Some(terminal_epoch) => Ok(StructuredStateBatch::new_viewport(
                prepared.0,
                terminal_epoch,
            )?),
            None => Ok(StructuredStateBatch::new(prepared.0)?),
        }
    }

    fn enqueue_current_snapshot(
        &self,
        client_id: u64,
        profile: ScreenSnapshotProfile,
        in_reply_to_request_id: Option<String>,
    ) -> Result<()> {
        let Some(delivery) = self.subscribers.delivery(client_id)? else {
            return Err("Hmux snapshot observer is no longer attached".into());
        };
        // Output ingestion holds Host -> subscribers in this same order. The
        // requested snapshot therefore enters the client's one outbound queue
        // after every delta it includes and before every later delta.
        let host = lock(&self.host)?;
        let mut snapshot = host.current_snapshot(profile)?;
        snapshot.in_reply_to_request_id = in_reply_to_request_id;
        let _publish_order = lock(&self.publish_order)?;
        drop(host);
        let snapshot = FrameBody::ScreenSnapshot(snapshot);
        let mut frame = PreparedFrame::new(snapshot);
        if delivery.deliver(&mut frame) {
            return Ok(());
        }
        let _ = self.subscribers.remove_if_same(client_id, &delivery);
        if !delivery.backpressure().load(Ordering::Acquire) {
            return Err("Hmux snapshot observer is no longer attached".into());
        }
        Ok(())
    }
}

/// The first coalesced census may already be in flight from just before this
/// provider appeared. One bounded retry lets all such callers share the next
/// complete census without restoring the old polling herd.
fn complete_process_snapshot_for_retirement(
    provider_pid: u32,
) -> Option<hebbian_process_sampler::ProcessSnapshot> {
    let sampler = SharedProcessSampler::host_default().ok()?;
    for _ in 0..RETIREMENT_PROCESS_SNAPSHOT_ATTEMPTS {
        if let Ok(snapshot) = sampler
            .complete_process_snapshot_containing(provider_pid, RETIREMENT_PROCESS_SNAPSHOT_MAX_AGE)
        {
            return Some(snapshot);
        }
    }
    None
}

fn retryable_idle_retirement_reason(reason: SessionRetirementReceiptReason) -> bool {
    reason == SessionRetirementReceiptReason::ProcessObservationUnavailable
}

struct ClientRegistration {
    state: Arc<ServerState>,
    client_id: u64,
    session_retirement_admin: bool,
    owns_control: bool,
    active: bool,
}

impl ClientRegistration {
    fn new(
        state: Arc<ServerState>,
        client_id: u64,
        session_retirement_admin: bool,
        owns_control: bool,
    ) -> Self {
        Self {
            state,
            client_id,
            session_retirement_admin,
            owns_control,
            active: true,
        }
    }

    fn cleanup(&mut self) -> Result<usize> {
        let subscriber_count = {
            let _attach = lock_attach_gate(&self.state.attach_gate);
            let attachment_count = if self.session_retirement_admin {
                lock(&self.state.attachments)?.len()
            } else {
                self.state.remove_attachment_locked(self.client_id)?
            };
            self.state.subscribers.remove(self.client_id)?;
            attachment_count
        };
        if self.owns_control {
            release_client_control(&self.state, self.client_id);
        }
        #[cfg(feature = "terminal-state-stream")]
        self.state.remove_terminal_surface(self.client_id);
        self.active = false;
        Ok(subscriber_count)
    }
}

impl Drop for ClientRegistration {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let _attach = lock_attach_gate(&self.state.attach_gate);
        if !self.session_retirement_admin {
            if let Ok(mut attachments) = self.state.attachments.lock() {
                attachments.remove(&self.client_id);
            }
        }
        let _ = self.state.subscribers.remove(self.client_id);
        drop(_attach);
        if self.owns_control {
            release_client_control(&self.state, self.client_id);
        }
        #[cfg(feature = "terminal-state-stream")]
        self.state.remove_terminal_surface(self.client_id);
    }
}

fn reject_overloaded_connection(
    stream: UnixStream,
    state: &ServerState,
    rejection: ConnectionRejection,
) {
    state.diagnostics.record(
        RuntimeDiagnosticEvent::ConnectionRejected,
        RuntimeDiagnosticFields::attach_failed(rejection.diagnostic_code())
            .with_resources(state.resources.snapshot()),
    );
    if stream.set_nonblocking(false).is_err() || verify_pathname_socket_same_user(&stream).is_err()
    {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    let Ok(transport) = ClientTransport::from_verified_unix_socket(stream) else {
        return;
    };
    let writer = transport.writer();
    let codec = FrameCodec::new(FrameLimits::default());
    let _ = write_error_before(
        &codec,
        &writer,
        ErrorCode::ResourceLimit,
        "Hmux Host connection capacity is exhausted",
        RetryPosture::Reconnect,
        Some(Instant::now() + HOST_OVERLOAD_WRITE_TIMEOUT),
    );
    transport.interrupt();
}

fn connection_class(
    state: &ServerState,
    requested_mode: &AttachMode,
    requested_capabilities: &[String],
) -> ConnectionClass {
    if *requested_mode == AttachMode::Controller {
        return ConnectionClass::Priority;
    }
    const PRIORITY_CAPABILITIES: &[&str] = &[
        SHARED_TERMINAL_INPUT_CAPABILITY,
        STANDALONE_TERMINATION_CAPABILITY,
        SESSION_RETIREMENT_CAPABILITY,
        SESSION_RETIREMENT_ADMIN_CAPABILITY,
        MANAGED_PROVIDER_STOP_CAPABILITY,
        MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY,
        MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
        AGENT_STATE_REPORT_CAPABILITY,
        FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
        PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
        MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
    ];
    if requested_capabilities.iter().any(|requested| {
        state.common.capabilities.contains(requested)
            && PRIORITY_CAPABILITIES.contains(&requested.as_str())
    }) {
        ConnectionClass::Priority
    } else {
        ConnectionClass::Ordinary
    }
}

fn release_control_if_owned(state: &ServerState, client_id: u64, owns_control: bool) {
    if owns_control {
        release_client_control(state, client_id);
    }
}

fn serve_client(
    stream: UnixStream,
    state: Arc<ServerState>,
    token: &str,
    mut permit: ConnectionPermit,
) -> Result<()> {
    // Accepted sockets can inherit the nonblocking flag from the listener on
    // macOS. Each connection owns a dedicated reader thread, so restore
    // blocking semantics before running the framed protocol.
    stream.set_nonblocking(false)?;
    verify_pathname_socket_same_user(&stream)?;
    let mut transport = ClientTransport::from_verified_unix_socket(stream)?;
    let writer = transport.writer();
    let interrupt = transport.interrupt_handle();
    let codec = FrameCodec::new(FrameLimits::default());
    transport
        .reader()
        .wait_readable(Some(Duration::from_secs(3)))?;
    let hello_frame = transport
        .reader()
        .read_frame(&codec)?
        .ok_or("Hmux client closed before hello")?
        .into_valid()?;
    let FrameBody::Hello(hello) = hello_frame.body else {
        return Err("first Hmux frame must be hello".into());
    };
    let attach_mode = match hello.requested_mode {
        AttachMode::Controller => "controller",
        AttachMode::Observer => "observer",
    };
    if hello.capability_token != token || hello.expected_fence != state.fence {
        write_error(
            &codec,
            &writer,
            ErrorCode::AuthorizationDenied,
            "Hmux attach authorization was denied",
            RetryPosture::Never,
        )?;
        return Ok(());
    }
    if state.termination_requested.load(Ordering::Acquire)
        || state.provider_exit_observed.load(Ordering::Acquire)
    {
        write_error(
            &codec,
            &writer,
            ErrorCode::SessionExited,
            "Hmux Host is terminating",
            RetryPosture::Never,
        )?;
        return Ok(());
    }
    let Some(selected_version) = state
        .common
        .supported_protocol
        .select_highest(hello.supported_versions)
    else {
        write_error(
            &codec,
            &writer,
            ErrorCode::UnsupportedProtocolVersion,
            "No supported Hmux protocol version",
            RetryPosture::Never,
        )?;
        return Ok(());
    };
    if let Err(rejection) = permit.promote(connection_class(
        &state,
        &hello.requested_mode,
        &hello.requested_capabilities,
    )) {
        state.diagnostics.record(
            RuntimeDiagnosticEvent::ConnectionRejected,
            RuntimeDiagnosticFields::attach_failed(rejection.diagnostic_code())
                .with_resources(state.resources.snapshot()),
        );
        write_error_before(
            &codec,
            &writer,
            ErrorCode::ResourceLimit,
            "Hmux Host active connection capacity is exhausted",
            RetryPosture::Reconnect,
            Some(Instant::now() + HOST_OVERLOAD_WRITE_TIMEOUT),
        )?;
        return Ok(());
    }
    let attach_gate = lock_attach_gate(&state.attach_gate);
    if state.termination_requested.load(Ordering::Acquire)
        || state.provider_exit_observed.load(Ordering::Acquire)
    {
        write_error(
            &codec,
            &writer,
            ErrorCode::SessionExited,
            "Hmux Host is terminating",
            RetryPosture::Never,
        )?;
        return Ok(());
    }
    #[cfg(feature = "terminal-state-stream")]
    if !terminal_capability_request_is_consistent(&hello.requested_capabilities) {
        write_error(
            &codec,
            &writer,
            ErrorCode::UnsupportedCapability,
            "structured terminal capabilities require terminal_state_binary_v1 and terminal_viewport_projection_v1",
            RetryPosture::Never,
        )?;
        return Ok(());
    }
    // Shared terminal input must be advertised by this Host before a client can
    // request it, mirroring managed_provider_stop and agent_state_report below.
    // Granting it on client request alone means a capability the Host chose to
    // withhold cannot actually be withheld -- the gate a relay posture needs.
    let shared = hello.requested_mode == AttachMode::Observer
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == SHARED_TERMINAL_INPUT_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == SHARED_TERMINAL_INPUT_CAPABILITY);
    let managed_provider_stop = hello.requested_mode == AttachMode::Observer
        && state.common.session_class == SessionClass::Managed
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == MANAGED_PROVIDER_STOP_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == MANAGED_PROVIDER_STOP_CAPABILITY);
    let managed_provider_quiescent_stop = managed_provider_stop
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY);
    let managed_provider_conversation_fenced_stop = managed_provider_stop
        && state.common.capabilities.iter().any(|value| {
            value == MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY
        })
        && hello.requested_capabilities.iter().any(|value| {
            value == MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY
        });
    let agent_state_report = hello.requested_mode == AttachMode::Observer
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == AGENT_STATE_REPORT_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == AGENT_STATE_REPORT_CAPABILITY);
    let agent_state_report_observation_fence = agent_state_report
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY);
    let agent_state_report_completion_id = agent_state_report
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY);
    let agent_state_report_causality = agent_state_report
        && state.common.capabilities.iter().any(|value| {
            value == hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY
        })
        && hello.requested_capabilities.iter().any(|value| {
            value == hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY
        });
    let provider_conversation_identity_only_report = agent_state_report
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY);
    let managed_authorization_grant_requested = state
        .common
        .capabilities
        .iter()
        .any(|value| value == MANAGED_AUTHORIZATION_GRANT_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == MANAGED_AUTHORIZATION_GRANT_CAPABILITY);
    let managed_authorization_grant = hello.requested_mode == AttachMode::Observer
        && state.common.session_class == SessionClass::Managed
        && managed_authorization_grant_requested;
    let unpresented_creation_abandon_requested = hello.requested_mode == AttachMode::Controller
        && state.common.session_class == SessionClass::Standalone
        && state
            .common
            .capabilities
            .iter()
            .any(|value| value == UNPRESENTED_CREATION_ABANDON_CAPABILITY)
        && hello
            .requested_capabilities
            .iter()
            .any(|value| value == UNPRESENTED_CREATION_ABANDON_CAPABILITY);
    // Standalone reporters already proved same-user peer identity plus the
    // opaque manifest token, mirroring standalone termination authority.
    // Managed Hosts serve an orchestration boundary, so state reports follow
    // the managed provider-stop precedent and require the adapter-minted
    // authorization proof for the current Host generation.
    let managed_agent_state_report =
        agent_state_report && state.common.session_class == SessionClass::Managed;
    #[cfg(feature = "terminal-state-stream")]
    let managed_agent_prompt_selection = select_managed_agent_prompt_capability(
        hello.requested_mode,
        state.common.session_class == SessionClass::Managed,
        &state.common.capabilities,
        &hello.requested_capabilities,
    );
    #[cfg(not(feature = "terminal-state-stream"))]
    let managed_agent_prompt_selection = None;
    let managed_agent_prompt = managed_agent_prompt_selection.is_some();
    let client_id = state.next_client.fetch_add(1, Ordering::Relaxed);
    let mut owns_control = false;
    let mut unpresented_creation_abandon = false;
    let generation = {
        let mut host = lock(&state.host)?;
        if hello.requested_mode == AttachMode::Controller {
            let mut controller = lock(&state.controller)?;
            if controller.is_some() {
                write_error(
                    &codec,
                    &writer,
                    ErrorCode::ControllerConflict,
                    "Another client controls this Hmux session",
                    RetryPosture::Reconnect,
                )?;
                return Ok(());
            }
            if state.common.session_class == SessionClass::Managed {
                if !state.authorize_managed_connection(
                    hello.authorization_proof_reference.as_deref(),
                    managed_authorization_grant_requested,
                    token,
                )? {
                    write_error(
                        &codec,
                        &writer,
                        ErrorCode::AuthorizationDenied,
                        "managed Hmux attach authorization was denied",
                        RetryPosture::Never,
                    )?;
                    return Ok(());
                }
            } else if let Some(proof) = hello.authorization_proof_reference.as_deref() {
                let mut expected = lock(&state.launch_owner_proof)?;
                if expected.as_deref() != Some(proof) {
                    write_error(
                        &codec,
                        &writer,
                        ErrorCode::AuthorizationDenied,
                        "Hmux launch-owner proof was denied",
                        RetryPosture::Never,
                    )?;
                    return Ok(());
                }
                unpresented_creation_abandon = unpresented_creation_abandon_requested;
                *expected = None;
            }
            let expected = host.controller_generation();
            let (_, granted) = host.grant_control(&state.fence, expected)?;
            *controller = Some(client_id);
            // A new controller is a new input stream: drop any paste or
            // marker state a previous writer stranded mid-envelope.
            lock(&state.controller_submit)?.reset();
            owns_control = true;
            granted
        } else {
            if managed_provider_stop || managed_agent_state_report || managed_agent_prompt {
                if !state.authorize_managed_connection(
                    hello.authorization_proof_reference.as_deref(),
                    managed_authorization_grant_requested || managed_agent_prompt,
                    token,
                )? {
                    write_error(
                        &codec,
                        &writer,
                        ErrorCode::AuthorizationDenied,
                        "managed Hmux observer authorization was denied",
                        RetryPosture::Never,
                    )?;
                    return Ok(());
                }
            } else if hello.authorization_proof_reference.is_some() {
                write_error(
                    &codec,
                    &writer,
                    ErrorCode::AuthorizationDenied,
                    "Observer attach proof was denied",
                    RetryPosture::Never,
                )?;
                return Ok(());
            }
            host.controller_generation()
        }
    };
    let selected_capabilities = hello
        .requested_capabilities
        .iter()
        .filter(|requested| {
            state.common.capabilities.contains(requested)
                && (requested.as_str() != MANAGED_AUTHORIZATION_GRANT_CAPABILITY
                    || managed_authorization_grant)
                && (requested.as_str() != MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY
                    || managed_provider_quiescent_stop)
                && (requested.as_str()
                    != MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY
                    || managed_provider_conversation_fenced_stop)
                && (requested.as_str() != SESSION_RETIREMENT_ADMIN_CAPABILITY
                    || hello.requested_mode == AttachMode::Observer)
                && (requested.as_str() != UNPRESENTED_CREATION_ABANDON_CAPABILITY
                    || unpresented_creation_abandon)
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
    let agent_runtime_state = selected_capabilities
        .iter()
        .any(|capability| capability == AGENT_RUNTIME_STATE_CAPABILITY);
    let agent_identity = selected_capabilities
        .iter()
        .any(|capability| capability == AGENT_IDENTITY_PROJECTION_CAPABILITY);
    let provider_conversation_identity = selected_capabilities
        .iter()
        .any(|capability| capability == PROVIDER_CONVERSATION_IDENTITY_CAPABILITY);
    let working_directory_frame = selected_capabilities
        .iter()
        .any(|capability| capability == WORKING_DIRECTORY_FRAME_CAPABILITY);
    let snapshot_projection =
        SnapshotProjection::new(agent_runtime_state, provider_conversation_identity)
            .with_agent_identity(agent_identity)
            .with_working_directory(working_directory_frame);
    let fenced_provider_conversation_identity_report = selected_capabilities
        .iter()
        .any(|capability| capability == FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY);
    let standalone_termination = selected_capabilities
        .iter()
        .any(|capability| capability == STANDALONE_TERMINATION_CAPABILITY);
    let session_retirement = selected_capabilities
        .iter()
        .any(|capability| capability == SESSION_RETIREMENT_CAPABILITY);
    let session_retirement_admin = selected_capabilities
        .iter()
        .any(|capability| capability == SESSION_RETIREMENT_ADMIN_CAPABILITY);
    let screen_snapshot_profile = selected_capabilities
        .iter()
        .any(|capability| capability == SCREEN_SNAPSHOT_PROFILE_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let terminal_viewport_projection = selected_capabilities
        .iter()
        .any(|capability| capability == TERMINAL_VIEWPORT_PROJECTION_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let terminal_input_intents = selected_capabilities
        .iter()
        .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let process_observed_agent_prompt = selected_capabilities
        .iter()
        .any(|capability| capability == PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let terminal_viewport_wheel = terminal_viewport_wheel_permitted(&selected_capabilities);
    #[cfg(feature = "terminal-state-stream")]
    let terminal_default_colors = terminal_default_colors_permitted(&selected_capabilities);
    #[cfg(feature = "terminal-state-stream")]
    let terminal_base_protocol_minor =
        selected_terminal_base_protocol_minor(&selected_capabilities)
            .unwrap_or(TERMINAL_STATE_BASE_PROTOCOL_MINOR);
    #[cfg(feature = "terminal-state-stream")]
    let terminal_viewport_multipart = terminal_viewport_multipart_permitted(&selected_capabilities);
    #[cfg(feature = "terminal-state-stream")]
    let mut terminal_viewport_active_connection = if terminal_viewport_projection {
        Some(
            permit
                .retain_active()
                .ok_or("terminal viewport worker requires an active connection")?,
        )
    } else {
        None
    };
    if session_retirement_admin
        && (shared
            || standalone_termination
            || managed_provider_stop
            || agent_state_report
            || fenced_provider_conversation_identity_report
            || provider_conversation_identity_only_report
            || managed_authorization_grant
            || unpresented_creation_abandon)
    {
        write_error(
            &codec,
            &writer,
            ErrorCode::UnsupportedCapability,
            "session retirement administration cannot share a mutating client posture",
            RetryPosture::Never,
        )?;
        return Ok(());
    }
    // Profile fields are honored only on connections that negotiated the
    // capability; unnegotiated (older) clients always get the full snapshot.
    let initial_snapshot_profile = if screen_snapshot_profile {
        hello
            .initial_snapshot_profile
            .unwrap_or(ScreenSnapshotProfile::Full)
    } else {
        ScreenSnapshotProfile::Full
    };
    // A cursor is honored only on connections that negotiated the capability,
    // for the same reason profiles are: an unnegotiated peer has not agreed to
    // a reply that omits the snapshot, and giving it one would look like a Host
    // that answered the handshake with nothing.
    let reconnect_cursor = selected_capabilities
        .iter()
        .any(|capability| capability == RECONNECT_RESUME_CAPABILITY)
        .then(|| hello.reconnect_cursor.clone())
        .flatten();
    let queue = Arc::new(BoundedQueue::with_host_budget(
        SUBSCRIBER_QUEUE_MAX_RECORDS,
        SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES,
        SUBSCRIBER_QUEUE_MAX_AGE,
        Arc::clone(&state.resources),
    ));
    let receiver = Arc::clone(&queue);
    let backpressure = Arc::new(AtomicBool::new(false));
    #[cfg(feature = "terminal-state-stream")]
    let delivery = if terminal_viewport_projection {
        SubscriberDelivery::new_viewport(
            queue,
            Arc::clone(&backpressure),
            state.diagnostics.clone(),
            snapshot_projection,
            terminal_base_protocol_minor,
            terminal_viewport_multipart,
        )
    } else {
        SubscriberDelivery::new(
            queue,
            Arc::clone(&backpressure),
            state.diagnostics.clone(),
            snapshot_projection,
        )
    };
    #[cfg(not(feature = "terminal-state-stream"))]
    let delivery = SubscriberDelivery::new(
        queue,
        Arc::clone(&backpressure),
        state.diagnostics.clone(),
        snapshot_projection,
    );
    let (ack, reply, exit, subscriber_count) = {
        #[cfg(feature = "terminal-state-stream")]
        let mut host = lock(&state.host)?;
        #[cfg(not(feature = "terminal-state-stream"))]
        let host = lock(&state.host)?;
        #[cfg(feature = "terminal-state-stream")]
        let reply = if terminal_viewport_projection {
            None
        } else {
            Some(attach_reply(
                &host,
                &state.fence,
                reconnect_cursor.as_ref(),
                initial_snapshot_profile,
                snapshot_projection,
            )?)
        };
        #[cfg(not(feature = "terminal-state-stream"))]
        let reply = Some(attach_reply(
            &host,
            &state.fence,
            reconnect_cursor.as_ref(),
            initial_snapshot_profile,
            snapshot_projection,
        )?);
        let (inspection, tombstone) = host.inspect_metadata(&state.fence)?;
        #[cfg(feature = "terminal-state-stream")]
        let initial_agent_identity = (terminal_viewport_projection && agent_identity)
            .then(|| inspection.agent_identity.cloned())
            .flatten();
        #[cfg(feature = "terminal-state-stream")]
        let initial_working_directory = (terminal_viewport_projection && working_directory_frame)
            .then(|| inspection.working_directory.cloned())
            .flatten();
        #[cfg(feature = "terminal-state-stream")]
        let initial_agent_runtime_state = (terminal_viewport_projection && agent_runtime_state)
            .then(|| inspection.agent_runtime_state.cloned())
            .flatten();
        #[cfg(feature = "terminal-state-stream")]
        let initial_provider_conversation_identity = (terminal_viewport_projection
            && provider_conversation_identity)
            .then(|| inspection.provider_conversation_identity.cloned())
            .flatten();
        #[cfg(not(feature = "terminal-state-stream"))]
        let _ = inspection;
        let exit = tombstone.map(|value| value.exit.clone());
        #[cfg(feature = "terminal-state-stream")]
        let viewport_projection = if terminal_viewport_projection {
            let active_connection = terminal_viewport_active_connection
                .take()
                .ok_or("terminal viewport worker connection was already consumed")?;
            let prepared = prepare_terminal_viewport(
                &state,
                &mut host,
                terminal_base_protocol_minor,
                terminal_viewport_multipart,
                active_connection,
            );
            match prepared {
                Ok(prepared) => Some(prepared),
                Err(error) => {
                    drop(host);
                    release_control_if_owned(&state, client_id, owns_control);
                    refuse_terminal_viewport_attach(&codec, &writer, "prepare", error)?;
                    return Ok(());
                }
            }
        } else {
            None
        };
        // Build the complete attach seed before this delivery is visible to
        // live publishers. HelloAck is emitted only after that seed and the
        // projection worker are both registered, making readiness one commit
        // point instead of an acknowledgement followed by asynchronous setup.
        let publish_order = lock(&state.publish_order)?;
        #[cfg(feature = "terminal-state-stream")]
        let viewport_projection = {
            let semantic_seeds = [
                initial_agent_runtime_state.map(FrameBody::AgentRuntimeState),
                initial_agent_identity.map(FrameBody::AgentIdentity),
                initial_working_directory.map(FrameBody::WorkingDirectory),
                initial_provider_conversation_identity.map(FrameBody::ProviderConversationIdentity),
            ];
            let seeded =
                seed_terminal_delivery(&state, &delivery, semantic_seeds, viewport_projection);
            match seeded {
                Ok(projection) => projection,
                Err(error) => {
                    drop(host);
                    drop(publish_order);
                    release_control_if_owned(&state, client_id, owns_control);
                    refuse_terminal_viewport_attach(&codec, &writer, "commit", error)?;
                    return Ok(());
                }
            }
        };
        let subscriber_count = match if session_retirement_admin {
            lock(&state.attachments).map(|attachments| attachments.len())
        } else {
            state.register_attachment_locked(client_id)
        } {
            Ok(count) => count,
            Err(error) => {
                drop(host);
                drop(publish_order);
                release_control_if_owned(&state, client_id, owns_control);
                return Err(error);
            }
        };
        if let Err(error) = state
            .subscribers
            .insert(client_id, Arc::clone(&delivery), Some(permit))
        {
            if !session_retirement_admin {
                let _ = state.remove_attachment_locked(client_id);
            }
            drop(host);
            drop(publish_order);
            release_control_if_owned(&state, client_id, owns_control);
            return Err(error.into());
        }
        let ack = HelloAck {
            selected_version,
            selected_capabilities,
            actual_fence: state.fence.clone(),
            host_build_version: HOST_BUILD_ID.to_string(),
            lifecycle: if exit.is_some() {
                LifecycleState::Exited
            } else if owns_control {
                LifecycleState::Controlling
            } else {
                LifecycleState::Observing
            },
            host_process: state.host_process.clone(),
            provider_process: host.provider_process().cloned(),
            earliest_retained_output_seq: host.earliest_retained_output_seq(),
            current_output_seq: host.current_output_seq(),
            controller_generation: generation,
            authorization_posture: if state.common.session_class == SessionClass::Managed {
                if hello.requested_mode == AttachMode::Controller {
                    AuthorizationPosture::DaemonAuthorized
                } else {
                    AuthorizationPosture::DaemonAuthorizedObserver
                }
            } else {
                AuthorizationPosture::StandaloneLocalOwner
            },
        };
        drop(host);
        drop(publish_order);
        #[cfg(feature = "terminal-state-stream")]
        if let Some(viewport) = viewport_projection {
            if let Err(error) = state.register_seeded_terminal_view_projection(
                client_id,
                viewport.projection,
                viewport.publication_generation,
                if terminal_input_intents {
                    WheelPtySink::Connected
                } else {
                    WheelPtySink::Absent
                },
                viewport.active_connection,
            ) {
                let _ = state.subscribers.remove(client_id);
                if !session_retirement_admin {
                    let _ = state.remove_attachment_locked(client_id);
                }
                state.remove_terminal_surface(client_id);
                release_control_if_owned(&state, client_id, owns_control);
                return Err(error);
            }
        }
        (ack, reply, exit, subscriber_count)
    };
    // Registration is the attach commit point. Socket backpressure after this
    // point must not hold up Host-owned provider termination.
    drop(attach_gate);
    let mut registration = ClientRegistration::new(
        Arc::clone(&state),
        client_id,
        session_retirement_admin,
        owns_control,
    );
    let current_output_seq = ack.current_output_seq;
    let controller_generation = ack.controller_generation;
    send_body(&codec, &writer, 1, FrameBody::HelloAck(ack))?;
    state.diagnostics.record(
        RuntimeDiagnosticEvent::AttachReady,
        RuntimeDiagnosticFields::attach_ready(
            attach_mode,
            current_output_seq,
            controller_generation,
            subscriber_count,
        )
        .with_resources(state.resources.snapshot()),
    );
    let mut frame_id = 2_u64;
    match reply {
        None => {}
        Some(AttachReply::Snapshot(snapshot)) => {
            send_body(
                &codec,
                &writer,
                frame_id,
                FrameBody::ScreenSnapshot(snapshot),
            )?;
            frame_id += 1;
        }
        Some(AttachReply::SnapshotAfterGap(gap, snapshot)) => {
            send_body(&codec, &writer, frame_id, FrameBody::ReplayGap(gap))?;
            frame_id += 1;
            send_body(
                &codec,
                &writer,
                frame_id,
                FrameBody::ScreenSnapshot(snapshot),
            )?;
            frame_id += 1;
        }
        Some(AttachReply::Resume(deltas)) => {
            for delta in deltas {
                send_body(&codec, &writer, frame_id, FrameBody::OutputDelta(delta))?;
                frame_id += 1;
            }
        }
    }
    if let Some(exit) = exit {
        send_body(&codec, &writer, frame_id, FrameBody::Exit(exit))?;
        frame_id += 1;
    }
    let outbound_writer = Arc::clone(&writer);
    let outbound_interrupt = Arc::clone(&interrupt);
    // The live producer numbers after whatever the attach reply consumed. A
    // resume can emit thousands of retained deltas, so the old fixed base of
    // 100 would have collided with them.
    let first_outbound_frame_id = frame_id.max(FIRST_OUTBOUND_FRAME_ID);
    let (outbound_done_tx, outbound_done_rx) = mpsc::sync_channel(1);
    let outbound = thread::spawn(move || {
        run_subscriber_outbound(
            &outbound_writer,
            &outbound_interrupt,
            receiver,
            backpressure,
            first_outbound_frame_id,
        );
        let _ = outbound_done_tx.send(());
    });
    let read_result = client_read_loop(
        transport.reader(),
        &state,
        &delivery,
        client_id,
        ClientPermissions {
            owns_control,
            shared,
            standalone_termination,
            session_retirement,
            session_retirement_admin,
            unpresented_creation_abandon,
            managed_provider_stop,
            managed_provider_quiescent_stop,
            managed_provider_conversation_fenced_stop,
            screen_snapshot_profile,
            agent_state_report,
            agent_state_report_completion_id,
            agent_state_report_causality,
            agent_state_report_observation_fence,
            provider_conversation_identity,
            fenced_provider_conversation_identity_report,
            provider_conversation_identity_only_report,
            managed_authorization_grant,
            #[cfg(feature = "terminal-state-stream")]
            terminal_viewport_projection,
            #[cfg(feature = "terminal-state-stream")]
            terminal_input_intents,
            #[cfg(feature = "terminal-state-stream")]
            agent_prompt: managed_agent_prompt_selection,
            #[cfg(feature = "terminal-state-stream")]
            process_observed_agent_prompt,
            #[cfg(feature = "terminal-state-stream")]
            terminal_viewport_wheel,
            #[cfg(feature = "terminal-state-stream")]
            terminal_default_colors,
            #[cfg(feature = "terminal-state-stream")]
            terminal_base_protocol_minor,
        },
    );
    let subscriber_count = registration.cleanup()?;
    // Closing registration seals the queue. Let the outbound worker drain any
    // ordered terminal receipt, but never let a blocked peer hold Host cleanup.
    drop(writer);
    finish_subscriber_outbound(
        &interrupt,
        outbound_done_rx,
        outbound,
        SUBSCRIBER_OUTBOUND_DRAIN_TIMEOUT,
    );
    transport.interrupt();
    state.diagnostics.record(
        RuntimeDiagnosticEvent::AttachDetached,
        RuntimeDiagnosticFields::attach_detached(attach_mode, subscriber_count)
            .with_resources(state.resources.snapshot()),
    );
    read_result.map(|_| ())
}

#[derive(Clone, Copy)]
struct ClientPermissions {
    owns_control: bool,
    shared: bool,
    standalone_termination: bool,
    session_retirement: bool,
    session_retirement_admin: bool,
    unpresented_creation_abandon: bool,
    managed_provider_stop: bool,
    managed_provider_quiescent_stop: bool,
    managed_provider_conversation_fenced_stop: bool,
    screen_snapshot_profile: bool,
    agent_state_report: bool,
    agent_state_report_completion_id: bool,
    agent_state_report_causality: bool,
    agent_state_report_observation_fence: bool,
    provider_conversation_identity: bool,
    fenced_provider_conversation_identity_report: bool,
    provider_conversation_identity_only_report: bool,
    managed_authorization_grant: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_viewport_projection: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_input_intents: bool,
    #[cfg(feature = "terminal-state-stream")]
    agent_prompt: Option<AgentPromptCapabilitySelection>,
    #[cfg(feature = "terminal-state-stream")]
    process_observed_agent_prompt: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_viewport_wheel: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_default_colors: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_base_protocol_minor: u8,
}

impl ClientPermissions {
    fn may_resize_terminal_surface(self) -> bool {
        self.owns_control || self.shared || {
            #[cfg(feature = "terminal-state-stream")]
            {
                self.terminal_viewport_projection
            }
            #[cfg(not(feature = "terminal-state-stream"))]
            {
                false
            }
        }
    }
}

enum ClientReadOutcome {
    Preserve,
    IntentionalDeparture,
}

fn client_read_loop(
    reader: &mut dyn FrameReader,
    state: &Arc<ServerState>,
    delivery: &Arc<SubscriberDelivery>,
    client_id: u64,
    permissions: ClientPermissions,
) -> Result<ClientReadOutcome> {
    let codec = FrameCodec::new(FrameLimits::default());
    loop {
        let payload = match reader.read_payload(&codec) {
            Ok(Some(payload)) => payload,
            Ok(None) | Err(TransportError::Interrupted | TransportError::Truncated) => {
                return Ok(ClientReadOutcome::Preserve);
            }
            Err(TransportError::Io { source, .. })
                if matches!(
                    source.kind(),
                    io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                ) =>
            {
                return Ok(ClientReadOutcome::Preserve);
            }
            Err(TransportError::Codec(hmux_host::local_protocol::FrameCodecError::Io(source)))
                if matches!(
                    source.kind(),
                    io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                ) =>
            {
                return Ok(ClientReadOutcome::Preserve);
            }
            Err(error) => return Err(error.into()),
        };
        #[cfg(feature = "terminal-state-stream")]
        let body = if payload.starts_with(&terminal_state_protocol::ENVELOPE_MAGIC) {
            if !permissions.terminal_viewport_projection {
                FrameBody::Error(ErrorFrame {
                    origin_code: None,
                    code: ErrorCode::AuthorizationDenied,
                    message: "structured terminal viewport was not negotiated".to_string(),
                    retry: RetryPosture::Never,
                    required_capability: Some(TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string()),
                    supported_versions: None,
                    in_reply_to_request_id: None,
                })
            } else {
                match decode_upstream(
                    &payload,
                    IngressPermissions {
                        viewport: permissions.terminal_viewport_projection,
                        input: permissions.terminal_input_intents,
                        agent_prompt: permissions.agent_prompt,
                        process_observed_agent_prompt: permissions.process_observed_agent_prompt,
                        wheel: permissions.terminal_viewport_wheel,
                        default_colors: permissions.terminal_default_colors,
                        base_protocol_minor: permissions.terminal_base_protocol_minor,
                        host_provider_id: &state.common.provider_id,
                    },
                )? {
                    StructuredUpstream::Input {
                        record_id,
                        record,
                        admission,
                    } => {
                        let _agent_prompt_publication = if admission.agent_prompt().is_some() {
                            Some(state.agent_prompt_admission.begin_publication()?)
                        } else {
                            None
                        };
                        let receipt = apply_structured_terminal_input(
                            state,
                            client_id,
                            record_id,
                            &record,
                            admission,
                        )?;
                        let release_resize_frame = matches!(
                            receipt.body.as_ref(),
                            Some(
                                terminal_state_protocol::terminal_state_record::Body::ResizeReceipt(
                                    _
                                )
                            )
                        );
                        state.enqueue_terminal_record_ordered(delivery, receipt)?;
                        if release_resize_frame {
                            state.release_terminal_surface_frame(
                                client_id,
                                &record_id.to_string(),
                            )?;
                        }
                        continue;
                    }
                    StructuredUpstream::ViewportIntent { record } => {
                        if let Some(receipt) =
                            apply_structured_terminal_viewport(state, client_id, &record)?
                        {
                            state.enqueue_terminal_record_ordered(delivery, receipt)?;
                            state.release_terminal_surface_frame(
                                client_id,
                                &record.metadata.record_id.to_string(),
                            )?;
                        }
                        continue;
                    }
                    StructuredUpstream::Unauthorized(required_capability) => {
                        FrameBody::Error(ErrorFrame {
                            origin_code: None,
                            code: ErrorCode::AuthorizationDenied,
                            message: "structured terminal operation is not authorized".to_string(),
                            retry: RetryPosture::Never,
                            required_capability: Some(required_capability.to_string()),
                            supported_versions: None,
                            in_reply_to_request_id: None,
                        })
                    }
                }
            }
        } else {
            codec
                .decode_payload_for_dispatch(&payload)?
                .into_valid()?
                .body
        };
        #[cfg(not(feature = "terminal-state-stream"))]
        let body = codec
            .decode_payload_for_dispatch(&payload)?
            .into_valid()?
            .body;
        let body = match body {
            FrameBody::SessionRetirementRequest(request) => {
                if !permissions.session_retirement {
                    state.enqueue_client_ordered(
                        delivery,
                        FrameBody::Error(ErrorFrame {
                            origin_code: None,
                            code: ErrorCode::UnsupportedCapability,
                            message: "session retirement capability was not negotiated".to_string(),
                            retry: RetryPosture::Never,
                            required_capability: Some(SESSION_RETIREMENT_CAPABILITY.to_string()),
                            supported_versions: None,
                            in_reply_to_request_id: Some(request.request_id),
                        }),
                    )?;
                    continue;
                }
                let handling = state.handle_session_retirement(
                    client_id,
                    request,
                    permissions.session_retirement_admin,
                    permissions.unpresented_creation_abandon,
                );
                let Some(receipt) = handling.receipt else {
                    return Err(
                        "retirement policy persistence became receipt-unsafe; closing transport"
                            .into(),
                    );
                };
                state.enqueue_client_ordered(
                    delivery,
                    FrameBody::SessionRetirementReceipt(receipt),
                )?;
                if handling.close_after_receipt {
                    return Ok(ClientReadOutcome::IntentionalDeparture);
                }
                continue;
            }
            body => body,
        };
        #[cfg(feature = "terminal-state-stream")]
        let mut resize_frame_barrier = None;
        let response = match body {
            FrameBody::Input(input) if permissions.owns_control || permissions.shared => {
                let application = apply_pty_input(
                    state,
                    PtyInput::Bytes(&input.bytes),
                    ControllerInputEffect::DraftCapable,
                    InputAdmission::Ordinary,
                    permissions
                        .owns_control
                        .then_some(input.controller_generation),
                    None,
                )?;
                let (receipt_state, reason) =
                    crate::input_receipt::classic_outcome(application.outcome);
                FrameBody::InputReceipt(InputReceipt {
                    request_id: input.request_id,
                    controller_generation: application.controller_generation,
                    state: receipt_state,
                    reason,
                    detail: application.detail,
                })
            }
            FrameBody::Resize(resize) if permissions.may_resize_terminal_surface() => {
                let generation = lock(&state.host)?.controller_generation();
                let mutation_generation = if permissions.owns_control {
                    resize.controller_generation
                } else {
                    generation
                };
                #[cfg(feature = "terminal-state-stream")]
                let result = if permissions.terminal_viewport_projection {
                    resize_frame_barrier = Some(resize.request_id.clone());
                    let result = state.propose_terminal_surface(
                        client_id,
                        resize.rows,
                        resize.columns,
                        None,
                        Some(resize.request_id.clone()),
                    );
                    result
                        .map(|geometry| (geometry.rows, geometry.columns))
                        .map_err(|error| error.operation_reason())
                } else {
                    state
                        .resize_terminal(mutation_generation, resize.rows, resize.columns)
                        .map(|()| (resize.rows, resize.columns))
                };
                #[cfg(not(feature = "terminal-state-stream"))]
                let result = state
                    .resize_terminal(mutation_generation, resize.rows, resize.columns)
                    .map(|()| (resize.rows, resize.columns));
                let (receipt_state, reason, applied) = match result {
                    Ok(geometry) => (ResizeReceiptState::AppliedToTerminal, None, Some(geometry)),
                    Err(
                        reason @ (OperationReceiptReason::HostExiting
                        | OperationReceiptReason::InvalidTerminalDimensions
                        | OperationReceiptReason::StaleControllerGeneration),
                    ) => (ResizeReceiptState::Refused, Some(reason), None),
                    Err(reason) => (ResizeReceiptState::Failed, Some(reason), None),
                };
                FrameBody::ResizeReceipt(ResizeReceipt {
                    request_id: resize.request_id,
                    controller_generation: generation,
                    rows: applied.map(|geometry| geometry.0),
                    columns: applied.map(|geometry| geometry.1),
                    state: receipt_state,
                    reason,
                })
            }
            FrameBody::StandaloneTerminate(request) if permissions.standalone_termination => {
                let accepted = state
                    .request_provider_termination(ProviderTermination::StandaloneClientRequest);
                FrameBody::StandaloneTerminateReceipt(StandaloneTerminateReceipt {
                    request_id: request.request_id,
                    state: if accepted {
                        StandaloneTerminateReceiptState::Accepted
                    } else {
                        StandaloneTerminateReceiptState::Failed
                    },
                    reason: (!accepted).then_some(OperationReceiptReason::HostExiting),
                })
            }
            FrameBody::ManagedProviderStop(request) if permissions.managed_provider_stop => {
                let has_unsupported_fence = request.expected_quiescence.is_some()
                    && !permissions.managed_provider_quiescent_stop
                    || request.expected_conversation.is_some()
                        && !permissions.managed_provider_conversation_fenced_stop;
                let outcome = if has_unsupported_fence {
                    Err(OperationReceiptReason::AgentRuntimeChanged)
                } else if request.expected_quiescence.is_some()
                    || request.expected_conversation.is_some()
                {
                    state.request_managed_provider_termination_at(
                        request.expected_quiescence.as_ref(),
                        request.expected_conversation.as_ref(),
                    )
                } else if state.request_managed_provider_termination() {
                    Ok(())
                } else {
                    Err(OperationReceiptReason::HostExiting)
                };
                let (receipt_state, reason) = match outcome {
                    Ok(()) => (ManagedProviderStopReceiptState::Accepted, None),
                    Err(reason @ OperationReceiptReason::AgentRuntimeChanged) => {
                        (ManagedProviderStopReceiptState::Refused, Some(reason))
                    }
                    Err(reason) => (ManagedProviderStopReceiptState::Failed, Some(reason)),
                };
                FrameBody::ManagedProviderStopReceipt(ManagedProviderStopReceipt {
                    request_id: request.request_id,
                    state: receipt_state,
                    reason,
                })
            }
            FrameBody::ManagedAuthorizationGrantRequest(request)
                if permissions.managed_authorization_grant =>
            {
                match state.issue_managed_authorization_grant() {
                    Ok(authorization_proof_reference) => {
                        FrameBody::ManagedAuthorizationGrantReceipt(
                            ManagedAuthorizationGrantReceipt {
                                request_id: request.request_id,
                                authorization_proof_reference,
                            },
                        )
                    }
                    Err(_) => FrameBody::Error(ErrorFrame {
                        origin_code: None,
                        code: ErrorCode::ResourceLimit,
                        message: "managed authorization grant could not be minted".to_string(),
                        retry: RetryPosture::Reconnect,
                        required_capability: None,
                        supported_versions: None,
                        in_reply_to_request_id: Some(request.request_id),
                    }),
                }
            }
            FrameBody::AgentStateReport(report) => {
                // Fold under Host state, then publish after releasing it. The
                // shared fold keeps Unix and Windows report semantics exact.
                let mut host = lock(&state.host)?;
                let application = agent_state_report::apply(
                    &mut host,
                    &state.fence,
                    &state.common.provider_id,
                    agent_state_report::Permissions {
                        report: permissions.agent_state_report,
                        completion_id: permissions.agent_state_report_completion_id,
                        causality: permissions.agent_state_report_causality,
                        observation_fence: permissions.agent_state_report_observation_fence,
                        conversation_identity: permissions.provider_conversation_identity,
                        fenced_conversation_identity: permissions
                            .fenced_provider_conversation_identity_report,
                        identity_only_conversation: permissions
                            .provider_conversation_identity_only_report,
                    },
                    report,
                );
                state.broadcast_after_host(host, application.broadcasts);
                #[cfg(feature = "terminal-state-stream")]
                state.agent_prompt_admission.notify();
                application.response
            }
            FrameBody::ScreenSnapshotRequest(request) => {
                if request.expected_fence != state.fence {
                    FrameBody::Error(ErrorFrame {
                        origin_code: None,
                        code: ErrorCode::IdentityMismatch,
                        message: "snapshot fence does not match".to_string(),
                        retry: RetryPosture::Never,
                        required_capability: None,
                        supported_versions: None,
                        in_reply_to_request_id: Some(request.request_id),
                    })
                } else {
                    let profile = if permissions.screen_snapshot_profile {
                        request.profile.unwrap_or(ScreenSnapshotProfile::Full)
                    } else {
                        ScreenSnapshotProfile::Full
                    };
                    state.enqueue_current_snapshot(client_id, profile, Some(request.request_id))?;
                    continue;
                }
            }
            FrameBody::Detach(_) => return Ok(ClientReadOutcome::Preserve),
            FrameBody::ControlRelease(release) if permissions.owns_control => {
                let previous = release.controller_generation;
                release_client_control(state, client_id);
                let current = lock(&state.host)?.controller_generation();
                FrameBody::ControlReceipt(ControlReceipt {
                    request_id: release.request_id,
                    previous_controller_generation: previous,
                    controller_generation: current,
                    state: ControlReceiptState::Released,
                    reason: None,
                })
            }
            _ => FrameBody::Error(ErrorFrame {
                origin_code: None,
                code: ErrorCode::AuthorizationDenied,
                message: "frame is not authorized for this attachment".to_string(),
                retry: RetryPosture::Never,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: None,
            }),
        };
        state.enqueue_client_ordered(delivery, response)?;
        #[cfg(feature = "terminal-state-stream")]
        if let Some(receipt_barrier) = resize_frame_barrier {
            state.release_terminal_surface_frame(client_id, &receipt_barrier)?;
        }
    }
}

fn release_client_control(state: &ServerState, client_id: u64) {
    // Keep the same Host -> controller lock order used during controller
    // admission. Opposite ordering can deadlock a disconnect racing an attach.
    if let Ok(mut host) = state.host.lock() {
        if let Ok(mut controller) = state.controller.lock() {
            if *controller == Some(client_id) {
                let generation = host.controller_generation();
                let _ = host.release_control(&state.fence, generation);
                *controller = None;
                // The departing controller may have left an unclosed paste
                // envelope; a stranded in-paste flag would classify every
                // later Enter as paste content and silently disable submit
                // detection for the session.
                if let Ok(mut scanner) = state.controller_submit.lock() {
                    scanner.reset();
                }
            }
        }
    }
}

fn set_nonblocking(fd: RawFd) -> Result<()> {
    // SAFETY: fcntl reads and updates flags for the live Host-owned PTY fd.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: the same live fd is updated with its existing flags plus
    // O_NONBLOCK. No pointer arguments are involved.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}

fn poll_fd(fd: RawFd, events: libc::c_short, timeout: Duration) -> io::Result<bool> {
    let mut descriptor = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    let timeout_ms = timeout.as_millis().try_into().unwrap_or(libc::c_int::MAX);
    // SAFETY: descriptor points to one initialized pollfd for the duration of
    // the call.
    let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
    if result >= 0 {
        Ok(result > 0)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(feature = "terminal-state-stream")]
fn viewport_projection_loop(state: Arc<ServerState>) {
    let mut observed_generation = 0;
    while let Some(generation) = state.viewport_publication.wait_after(observed_generation) {
        observed_generation = generation;
        let pass = state
            .schedule_latest_terminal_viewports(generation)
            .and_then(|pass| {
                if pass.wait_completed() {
                    Ok(())
                } else {
                    Err("the terminal viewport projection pass did not complete".into())
                }
            });
        if let Err(error) = pass {
            let reason = error.to_string();
            let retired =
                state.retire_terminal_viewport_attachments(&reason, ViewportRetirement::Retryable);
            eprintln!(
                "hmux-runtime: {reason}; retired {retired} attachment(s) and preserved the provider"
            );
        }
        if !state.viewport_publication.mark_completed(generation) {
            return;
        }
    }
}

fn runtime_identity_loop(provider_pid: u32, state: Arc<ServerState>) {
    const POLL_INTERVAL: Duration = Duration::from_millis(750);
    let mut sampler = SharedProcessSampler::host_default().ok();
    // 샘플러를 못 만들면 에이전트 감지가 영영 멈춘다. 750ms마다 말없이 다시
    // 시도하면 그 사실이 어디에도 남지 않아, 한참 뒤 엉뚱한 곳의 타임아웃으로만
    // 드러난다 — 이번에 main을 빨갛게 만든 것이 정확히 그 침묵이었다. 한 번은 남긴다.
    let mut announced_sampler_failure = false;
    loop {
        thread::sleep(POLL_INTERVAL);
        if state.stopped.lock().is_ok_and(|stopped| *stopped) {
            return;
        }
        if sampler.is_none() {
            match SharedProcessSampler::host_default() {
                Ok(ready) => {
                    announced_sampler_failure = false;
                    sampler = Some(ready);
                }
                Err(error) if !announced_sampler_failure => {
                    announced_sampler_failure = true;
                    eprintln!(
                        "hmux-runtime: process sampler unavailable, agent detection is paused: {error}"
                    );
                }
                Err(_) => {}
            }
        }
        let identity = sampler
            .as_ref()
            .and_then(|sampler| runtime_identity::inspect(provider_pid, sampler));
        {
            let Ok(mut host) = state.host.lock() else {
                return;
            };
            let mut runtime_state = host
                .expire_agent_runtime_state(&state.fence, Instant::now())
                .ok()
                .flatten();
            let mut metadata_changed = false;
            let mut agent_changed = false;
            let mut working_directory_changed = false;
            if let Some(identity) = identity {
                let previous_agent = host.current_agent_provider();
                agent_changed = host
                    .observe_agent_identity(
                        &state.fence,
                        AgentIdentityObservation::process_inspection(identity.agent),
                    )
                    .unwrap_or(false);
                metadata_changed = agent_changed;
                if let Some(cwd) = identity.cwd {
                    working_directory_changed = host
                        .observe_working_directory(
                            &state.fence,
                            WorkingDirectoryObservation::new(
                                cwd,
                                hmux_host::local_protocol::WorkingDirectorySource::ProcessInspection,
                            ),
                        )
                        .unwrap_or(false);
                    metadata_changed |= working_directory_changed;
                }
                if let Some(execution_location) = identity.execution_location {
                    metadata_changed |= host
                        .observe_execution_location(&state.fence, execution_location)
                        .unwrap_or(false);
                }
                let process_state = match identity.agent {
                    Some(_) if previous_agent != identity.agent => {
                        // Process inspection proves that an agent provider is
                        // running, but it cannot prove an active turn. Input
                        // admission and provider reports own `working`.
                        Some(AgentRuntimeObservation::waiting(
                            hmux_host::local_protocol::AgentRuntimeStateSource::ProcessLifecycle,
                        ))
                    }
                    Some(_) => None,
                    None if previous_agent.is_some() => Some(AgentRuntimeObservation::exited()),
                    None => None,
                }
                .and_then(|observation| {
                    host.observe_agent_runtime_state(&state.fence, observation)
                        .ok()
                        .flatten()
                });
                if process_state.is_some() {
                    runtime_state = process_state;
                }
            }
            let mut broadcasts = Vec::with_capacity(2);
            #[cfg(feature = "terminal-state-stream")]
            let agent_prompt_readiness_changed = runtime_state.is_some() || agent_changed;
            if let Some(runtime_state) = runtime_state {
                // Publish the typed transition before the metadata snapshot.
                // A client may use the snapshot to advance its duplicate
                // suppression boundary, so the reverse order would make the
                // live transition disappear from its event stream.
                broadcasts.push(FrameBody::AgentRuntimeState(runtime_state));
            }
            if metadata_changed {
                if let Ok(snapshot) = host.current_snapshot(ScreenSnapshotProfile::Full) {
                    if agent_changed {
                        if let Some(identity) = snapshot.agent_identity.clone() {
                            broadcasts.push(FrameBody::AgentIdentity(identity));
                        }
                    }
                    if working_directory_changed {
                        if let Some(working_directory) = snapshot.working_directory.clone() {
                            broadcasts.push(FrameBody::WorkingDirectory(working_directory));
                        }
                    }
                    broadcasts.push(FrameBody::ScreenSnapshot(snapshot));
                }
            }
            state.broadcast_after_host(host, broadcasts);
            #[cfg(feature = "terminal-state-stream")]
            if agent_prompt_readiness_changed {
                state.agent_prompt_admission.notify();
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ResizeOperationFailure {
    reason: OperationReceiptReason,
    stage: &'static str,
    cause: &'static str,
}

impl ResizeOperationFailure {
    const fn new(reason: OperationReceiptReason, stage: &'static str, cause: &'static str) -> Self {
        Self {
            reason,
            stage,
            cause,
        }
    }
}

fn classify_resize_preparation_failure(error: SessionHostError) -> ResizeOperationFailure {
    let (reason, cause) = match error {
        SessionHostError::StaleControllerGeneration => (
            OperationReceiptReason::StaleControllerGeneration,
            "stale_controller",
        ),
        SessionHostError::SessionExited | SessionHostError::FenceMismatch => {
            (OperationReceiptReason::HostExiting, "host_exiting")
        }
        SessionHostError::TerminalReplay(TerminalReplayError::InvalidDimensions { .. }) => (
            OperationReceiptReason::InvalidTerminalDimensions,
            "invalid_dimensions",
        ),
        SessionHostError::TerminalReplay(TerminalReplayError::TerminalStateRevisionExhausted) => (
            OperationReceiptReason::PlatformResizeFailed,
            "revision_exhausted",
        ),
        SessionHostError::TerminalReplay(_) => {
            (OperationReceiptReason::PlatformResizeFailed, "host_state")
        }
        SessionHostError::ProviderStillRunning
        | SessionHostError::InvalidSuccessor(_)
        | SessionHostError::InvalidRetainedEpochLimit => {
            (OperationReceiptReason::PlatformResizeFailed, "host_state")
        }
    };
    ResizeOperationFailure::new(reason, "host_prepare", cause)
}

fn classify_resize_commit_failure(error: SessionHostError) -> ResizeOperationFailure {
    match error {
        SessionHostError::TerminalReplay(TerminalReplayError::TerminalEngineFailure { .. }) => {
            ResizeOperationFailure::new(
                OperationReceiptReason::PlatformResizeFailed,
                "host_commit",
                "terminal_engine",
            )
        }
        error => {
            let failure = classify_resize_preparation_failure(error);
            ResizeOperationFailure::new(failure.reason, "host_commit", failure.cause)
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
fn terminal_presentation_degradation_code(
    degradation: TerminalPresentationDegradation,
) -> &'static str {
    match degradation {
        TerminalPresentationDegradation::MutationObservation => "mutation_observation",
        TerminalPresentationDegradation::MutationProjection => "mutation_projection",
    }
}

#[cfg(feature = "terminal-state-stream")]
fn terminal_history_degradation_code(error: &TerminalReplayError) -> &'static str {
    match error {
        TerminalReplayError::HistoryStorageBackpressure { .. } => "history_capacity",
        TerminalReplayError::ColdHistoryJournalUnavailable => "history_journal_unavailable",
        TerminalReplayError::ColdHistoryRecoveryRequired => "history_recovery_required",
        TerminalReplayError::ColdHistoryRetentionRequired => "history_retention_limit",
        TerminalReplayError::ColdHistoryOfferRequiresContinuation => "history_continuation",
        TerminalReplayError::TerminalEngineFailure { .. } => "history_engine_failure",
        _ => "history_inconsistent",
    }
}

fn runtime_directory() -> Result<PathBuf> {
    let directory = env::var_os("HMUX_RUNTIME_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_runtime_directory);
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    Ok(directory)
}

/// Sockets must live somewhere only this runtime deletes them. The previous
/// default, `env::temp_dir()` (macOS `/var/folders/…/T`), is reaped by the OS
/// on file age: it unlinked the sockets of every 3+ day old session out from
/// under their live manifests, and each affected pane failed attach with
/// ENOENT (2026-09-01). A home-anchored root has the runtime's own lifetime —
/// and is shorter than the macOS temp path. The temp dir remains only for
/// homeless environments or a home so deep the socket would overflow the
/// 104-byte `sun_path` bound (sockets are `<root>/<24 hex>.sock`).
fn default_runtime_directory() -> PathBuf {
    home_anchored_runtime_directory(env::var_os("HOME")).unwrap_or_else(|| {
        env::temp_dir().join(format!(
            "hmux-runtime-{}",
            // SAFETY: geteuid has no arguments and does not dereference memory.
            unsafe { libc::geteuid() }
        ))
    })
}

fn home_anchored_runtime_directory(home: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let home = home.filter(|value| !value.is_empty())?;
    let directory = PathBuf::from(home).join(".hmux/run");
    (std::os::unix::ffi::OsStrExt::as_bytes(directory.as_os_str()).len() <= 64)
        .then_some(directory)
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
        .max(1)
}

fn hostname() -> String {
    env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

fn runtime_log(message: &str) {
    let Some(path) = env::var_os("HMUX_RUNTIME_LOG").filter(|value| !value.is_empty()) else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| "hmux runtime lock was poisoned".into())
}

fn lock_resize_resource<'a, T>(
    mutex: &'a Mutex<T>,
    resource: &str,
    failure_stage: &'static str,
) -> std::result::Result<std::sync::MutexGuard<'a, T>, ResizeOperationFailure> {
    match mutex.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => {
            mutex.clear_poison();
            drop(poisoned.into_inner());
            runtime_log(&format!(
                "terminal resize found poisoned {resource}; failed the exact request and restored later session operations"
            ));
            Err(ResizeOperationFailure::new(
                OperationReceiptReason::PlatformResizeFailed,
                failure_stage,
                "poisoned_lock",
            ))
        }
    }
}

fn lock_pty_writer_preserving_liveness<'a, T>(
    mutex: &'a Mutex<T>,
    operation: &str,
) -> std::sync::MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        mutex.clear_poison();
        runtime_log(&format!(
            "recovering PTY writer serialization for later {operation} after an earlier operation failed"
        ));
        poisoned.into_inner()
    })
}

fn lock_attach_gate(mutex: &Mutex<()>) -> std::sync::MutexGuard<'_, ()> {
    mutex.lock().unwrap_or_else(|poisoned| {
        mutex.clear_poison();
        runtime_log("recovering state-free attach serialization gate after worker failure");
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {

    use super::*;
    use hmux_host::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
        AgentRuntimeStateProjection, AgentRuntimeStateSource, Detach, InputReceiptState,
        OutputDelta, WireFrame,
    };
    use subscriber_delivery::{FrameQueue, OutboundRecord};

    /// Red-first contract for the socket root: the default must be
    /// home-anchored (the runtime's own lifetime), never the OS-reaped temp
    /// dir, except when HOME is unusable or would overflow sun_path headroom.
    #[test]
    fn socket_root_prefers_the_home_anchor_over_reapable_temp() {
        assert_eq!(
            home_anchored_runtime_directory(Some("/Users/jwan".into())),
            Some(PathBuf::from("/Users/jwan/.hmux/run")),
        );
        assert_eq!(home_anchored_runtime_directory(None), None);
        assert_eq!(home_anchored_runtime_directory(Some("".into())), None);
        let deep = format!("/very/{}", "x".repeat(80));
        assert_eq!(home_anchored_runtime_directory(Some(deep.into())), None);
    }

    #[test]
    fn provider_state_removal_overrides_a_poisoned_launch_environment() {
        let state = tempfile::tempdir().unwrap();
        let marker = state.path().join("codex-home");
        let environment = ProviderStateEnvironment::from_mutations(
            std::collections::BTreeMap::new(),
            std::collections::BTreeSet::from(["CODEX_HOME".into()]),
        )
        .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "printf '%s' \"${CODEX_HOME-unset}\" > \"$1\"",
            "--",
            marker.to_str().unwrap(),
        ]);
        command.env("CODEX_HOME", "/poisoned/codex-home");
        apply_provider_state_environment(&mut command, &environment);

        let mut child = pair.slave.spawn_command(command).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "unset");
    }

    #[test]
    fn attach_serialization_gate_survives_a_failed_worker() {
        let gate = Arc::new(Mutex::new(()));
        let failed_worker_gate = Arc::clone(&gate);
        assert!(
            thread::spawn(move || {
                let _guard = failed_worker_gate.lock().expect("lock attach gate");
                panic!("simulated attach worker failure");
            })
            .join()
            .is_err()
        );

        drop(lock_attach_gate(&gate));
        assert!(!gate.is_poisoned(), "attach gate remained poisoned");
    }

    fn expect_json_record(record: OutboundRecord) -> Arc<FrameBody> {
        match record {
            OutboundRecord::Json(body) => body,
            #[cfg(feature = "terminal-state-stream")]
            OutboundRecord::TerminalState(_) | OutboundRecord::TerminalViewportBatch(_) => {
                panic!("expected queued JSON control record")
            }
        }
    }

    #[test]
    fn blocked_subscriber_outbound_cleanup_is_bounded() {
        let (mut writer, peer) = UnixStream::pair().unwrap();
        let shutdown: Arc<dyn TransportInterrupt> = Arc::new(
            hmux_local_platform::transport::fd::SocketInterrupt::new(writer.try_clone().unwrap()),
        );
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let outbound = thread::spawn(move || {
            let payload = vec![0_u8; 64 * 1024];
            while writer.write_all(&payload).is_ok() {}
            let _ = done_tx.send(());
        });
        let started = Instant::now();

        assert!(!finish_subscriber_outbound(
            &shutdown,
            done_rx,
            outbound,
            Duration::from_millis(50),
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(peer);
    }

    #[test]
    fn required_rehost_checkpoint_lookup_is_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let root = DiscoveryRoot::create(directory.path().join("hmux")).unwrap();
        let source = PresentationCheckpointSource::new(
            "workspace",
            "source-session",
            "local-user",
            "source-runner",
            1,
            "source-host",
            "source-terminal",
        )
        .unwrap();

        assert!(
            load_presentation_checkpoint(&root, &source).is_err(),
            "a requested recovery source must not silently become a fresh terminal"
        );
    }

    #[test]
    fn idle_accept_waits_for_readiness_instead_of_polling() {
        let state = tempfile::tempdir().unwrap();
        let socket_path = state.path().join("accept.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        configure_accept_listener(&listener).unwrap();
        let (accepted_tx, accepted_rx) = mpsc::sync_channel(1);
        let accept_thread = thread::spawn(move || {
            accepted_tx.send(listener.accept()).unwrap();
        });

        assert!(
            accepted_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "an idle listener must remain asleep until socket readiness"
        );
        let client = UnixStream::connect(&socket_path).unwrap();
        let accepted = accepted_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("a real connection wakes the blocked accept")
            .expect("the ready listener accepts the connection");
        drop(accepted);
        drop(client);
        accept_thread.join().unwrap();
    }

    fn subscriber_queue(max_records: usize, max_accounted_bytes: usize) -> Arc<FrameQueue> {
        Arc::new(BoundedQueue::new(
            max_records,
            max_accounted_bytes,
            SUBSCRIBER_QUEUE_MAX_AGE,
        ))
    }

    fn subscriber_with_queue(
        queue: Arc<FrameQueue>,
        backpressure: Arc<AtomicBool>,
        agent_runtime_state: bool,
        provider_conversation_identity: bool,
    ) -> Arc<SubscriberDelivery> {
        SubscriberDelivery::new(
            queue,
            backpressure,
            RuntimeDiagnostics::disabled(),
            SnapshotProjection::new(agent_runtime_state, provider_conversation_identity),
        )
    }

    fn subscriber(agent_runtime_state: bool) -> Arc<SubscriberDelivery> {
        subscriber_with_queue(
            subscriber_queue(
                SUBSCRIBER_QUEUE_MAX_RECORDS,
                SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES,
            ),
            Arc::new(AtomicBool::new(false)),
            agent_runtime_state,
            false,
        )
    }

    fn deliver_to_subscriber(subscriber: &SubscriberDelivery, body: &FrameBody) -> bool {
        subscriber.deliver(&mut PreparedFrame::new(body.clone()))
    }

    fn enqueue_to_subscriber(
        subscribers: &mut HashMap<u64, Arc<SubscriberDelivery>>,
        client_id: u64,
        body: FrameBody,
    ) -> bool {
        let delivered = subscribers
            .get(&client_id)
            .is_some_and(|subscriber| deliver_to_subscriber(subscriber, &body));
        if !delivered {
            subscribers.remove(&client_id);
        }
        delivered
    }

    #[test]
    fn semantic_state_frames_require_explicit_negotiation() {
        let state = FrameBody::AgentRuntimeState(AgentRuntimeStateProjection {
            terminal_epoch: "terminal-1".into(),
            revision: 1,
            observed_through_output_seq: 0,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 0,
        });
        let ordinary = FrameBody::Detach(Detach { reason: None });

        assert!(!subscriber(false).accepts(&state));
        assert!(subscriber(true).accepts(&state));
        assert!(subscriber(false).accepts(&ordinary));
    }

    #[test]
    fn snapshots_strip_provider_identity_without_explicit_negotiation() {
        let fence = SessionFence {
            workspace_id: "workspace-1".into(),
            session_id: "session-1".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 1,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        };
        let snapshot = FrameBody::ScreenSnapshot(ScreenSnapshot {
            fence: fence.clone(),
            sequence_through: 3,
            rows: 24,
            columns: 80,
            encoding: hmux_host::local_protocol::ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: Vec::new(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: Some(AgentRuntimeStateProjection {
                terminal_epoch: "terminal-1".into(),
                revision: 1,
                observed_through_output_seq: 3,
                lifecycle: AgentRuntimeLifecycle::Running,
                activity: AgentRuntimeActivity::Working,
                attention: AgentRuntimeAttention::None,
                attention_id: None,
                source: AgentRuntimeStateSource::ProviderEvent,
                turn_completed_count: 0,
            }),
            provider_conversation_identity: Some(Box::new(
                hmux_host::local_protocol::ProviderConversationIdentityProjection {
                    fence,
                    revision: 1,
                    observed_through_output_seq: 3,
                    provider_id: "codex".into(),
                    conversation_id: "conversation-1".into(),
                    source:
                        hmux_host::local_protocol::ProviderConversationIdentitySource::ProviderEvent,
                },
            )),
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: None,
        });
        let receiver = subscriber_queue(1, SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES);
        let subscriber = subscriber_with_queue(
            Arc::clone(&receiver),
            Arc::new(AtomicBool::new(false)),
            false,
            false,
        );

        assert!(deliver_to_subscriber(&subscriber, &snapshot));
        let delivered = expect_json_record(receiver.pop().unwrap());
        let FrameBody::ScreenSnapshot(delivered) = delivered.as_ref().clone() else {
            panic!("expected projected screen snapshot");
        };
        assert!(delivered.provider_conversation_identity.is_none());
        assert!(delivered.agent_runtime_state.is_none());
    }

    #[test]
    fn saturated_subscriber_requests_typed_snapshot_recovery() {
        let receiver = subscriber_queue(1, SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES);
        let backpressure = Arc::new(AtomicBool::new(false));
        let subscriber = subscriber_with_queue(
            Arc::clone(&receiver),
            Arc::clone(&backpressure),
            false,
            false,
        );
        let ordinary = FrameBody::Detach(Detach { reason: None });
        subscriber
            .queue()
            .try_push(
                OutboundRecord::Json(Arc::new(ordinary.clone())),
                subscriber_queue_accounted_bytes(&ordinary),
            )
            .unwrap();

        assert!(!deliver_to_subscriber(&subscriber, &ordinary));
        assert!(backpressure.load(Ordering::Acquire));
        drop(receiver);
    }

    #[test]
    fn small_output_burst_past_legacy_frame_cap_remains_attached() {
        let queue = subscriber_queue(
            SUBSCRIBER_QUEUE_MAX_RECORDS,
            SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES,
        );
        let backpressure = Arc::new(AtomicBool::new(false));
        let subscriber =
            subscriber_with_queue(Arc::clone(&queue), Arc::clone(&backpressure), false, false);

        for output_seq in 1..=300 {
            let output = FrameBody::OutputDelta(OutputDelta {
                terminal_epoch: "terminal-1".into(),
                output_seq,
                bytes: vec![b'x'],
                rows: None,
                columns: None,
                working_directory: None,
                execution_location: None,
                agent_identity: None,
            });
            assert!(deliver_to_subscriber(&subscriber, &output));
        }

        assert!(!backpressure.load(Ordering::Acquire));
        for expected_sequence in 1..=300 {
            let body = expect_json_record(queue.pop().expect("queued output record"));
            assert!(matches!(
                body.as_ref(),
                FrameBody::OutputDelta(OutputDelta { output_seq, .. })
                    if *output_seq == expected_sequence
            ));
        }
    }

    #[test]
    fn requested_snapshot_uses_the_existing_subscriber_fifo() {
        let receiver = subscriber_queue(4, SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES);
        let subscriber = subscriber_with_queue(
            Arc::clone(&receiver),
            Arc::new(AtomicBool::new(false)),
            false,
            false,
        );
        let mut subscribers = HashMap::from([(7, subscriber)]);
        let before = FrameBody::Detach(Detach {
            reason: Some("before".into()),
        });
        let snapshot = FrameBody::Detach(Detach {
            reason: Some("snapshot".into()),
        });
        let after = FrameBody::Detach(Detach {
            reason: Some("after".into()),
        });

        assert!(deliver_to_subscriber(subscribers.get(&7).unwrap(), &before));
        assert!(enqueue_to_subscriber(&mut subscribers, 7, snapshot));
        assert!(deliver_to_subscriber(subscribers.get(&7).unwrap(), &after));

        let reasons = [receiver.pop(), receiver.pop(), receiver.pop()]
            .into_iter()
            .map(|body| match expect_json_record(body.unwrap()).as_ref() {
                FrameBody::Detach(Detach { reason }) => reason
                    .as_deref()
                    .expect("queued marker has a reason")
                    .to_string(),
                _ => panic!("expected queued marker"),
            })
            .collect::<Vec<_>>();
        assert_eq!(reasons, ["before", "snapshot", "after"]);
    }

    #[test]
    fn requested_snapshot_saturation_fences_the_observer_deterministically() {
        let receiver = subscriber_queue(1, SUBSCRIBER_QUEUE_MAX_ACCOUNTED_BYTES);
        let backpressure = Arc::new(AtomicBool::new(false));
        let subscriber = subscriber_with_queue(
            Arc::clone(&receiver),
            Arc::clone(&backpressure),
            false,
            false,
        );
        let mut subscribers = HashMap::from([(7, subscriber)]);
        let queued_delta = FrameBody::Detach(Detach {
            reason: Some("queued-delta".into()),
        });
        let requested_snapshot = FrameBody::Detach(Detach {
            reason: Some("requested-snapshot".into()),
        });

        assert!(deliver_to_subscriber(
            subscribers.get(&7).unwrap(),
            &queued_delta
        ));
        assert!(!enqueue_to_subscriber(
            &mut subscribers,
            7,
            requested_snapshot
        ));
        assert!(backpressure.load(Ordering::Acquire));
        assert!(!subscribers.contains_key(&7));
        assert!(matches!(
            expect_json_record(receiver.pop().unwrap()).as_ref(),
            FrameBody::Detach(Detach {
                reason: Some(reason)
            }) if reason == "queued-delta"
        ));
    }

    #[test]
    fn only_transient_process_observation_retries_idle_retirement() {
        assert!(retryable_idle_retirement_reason(
            SessionRetirementReceiptReason::ProcessObservationUnavailable
        ));
        for reason in [
            SessionRetirementReceiptReason::ProviderBusy,
            SessionRetirementReceiptReason::ProviderIdentityChanged,
            SessionRetirementReceiptReason::SessionExited,
            SessionRetirementReceiptReason::OtherClientsAttached,
            SessionRetirementReceiptReason::PolicyNotConfigured,
        ] {
            assert!(!retryable_idle_retirement_reason(reason));
        }
    }

    #[test]
    fn stale_mutations_produce_protocol_valid_refusals() {
        let reason = crate::input_transaction::input_operation_reason(
            &SessionHostError::StaleControllerGeneration,
        );
        assert_eq!(reason, OperationReceiptReason::StaleControllerGeneration);

        for body in [
            FrameBody::InputReceipt(InputReceipt {
                request_id: "stale-input".into(),
                controller_generation: 2,
                state: InputReceiptState::Refused,
                reason: Some(reason),
                detail: None,
            }),
            FrameBody::ResizeReceipt(ResizeReceipt {
                request_id: "stale-resize".into(),
                controller_generation: 2,
                rows: None,
                columns: None,
                state: ResizeReceiptState::Refused,
                reason: Some(reason),
            }),
        ] {
            WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body,
            }
            .validate(&FrameLimits::default())
            .unwrap();
        }
    }

    #[test]
    fn every_failure_class_token_survives_the_classic_receipt_validator() {
        let mut errors = vec![
            SessionHostError::FenceMismatch,
            SessionHostError::SessionExited,
            SessionHostError::ProviderStillRunning,
            SessionHostError::StaleControllerGeneration,
            SessionHostError::InvalidSuccessor("workspace_id"),
            SessionHostError::InvalidRetainedEpochLimit,
            SessionHostError::TerminalReplay(TerminalReplayError::TerminalEngineFailure {
                operation: "capture terminal color overrides on a very long operation name",
                code: -2_147_483_648,
            }),
            SessionHostError::TerminalReplay(TerminalReplayError::TerminalEngineFailure {
                operation: "encode key",
                code: 7,
            }),
            SessionHostError::TerminalReplay(TerminalReplayError::InvalidStructuredProjection {
                reason: "Mixed-Case Reason!",
            }),
        ];
        for replay in [
            TerminalReplayError::InvalidFence { field: "x" },
            TerminalReplayError::InvalidLimit { field: "x" },
            TerminalReplayError::InvalidDimensions {
                rows: 0,
                columns: 0,
            },
            TerminalReplayError::EmptyOutput,
            TerminalReplayError::DeltaTooLarge {
                actual: 2,
                maximum: 1,
            },
            TerminalReplayError::SnapshotLimitTooSmall {
                minimum: 2,
                actual: 1,
            },
            TerminalReplayError::SequenceExhausted,
            TerminalReplayError::TerminalStateRevisionExhausted,
            TerminalReplayError::TerminalEventSequenceExhausted,
            TerminalReplayError::StateRevisionExhausted,
            TerminalReplayError::TerminalEpochMismatch,
            TerminalReplayError::CursorAhead {
                requested: 2,
                current: 1,
            },
            TerminalReplayError::InvalidWorkingDirectory,
            TerminalReplayError::InvalidExecutionLocation,
            TerminalReplayError::InvalidAgentRuntimeState,
            TerminalReplayError::InvalidProviderConversationIdentity,
            TerminalReplayError::ProviderConversationIdentityConflict,
            TerminalReplayError::InvalidRecoveredPresentation,
            TerminalReplayError::InvalidStructuredInput,
            TerminalReplayError::InvalidTerminalDefaultColors,
            TerminalReplayError::ColdHistoryInvariant,
            TerminalReplayError::ColdHistoryJournalUnavailable,
            TerminalReplayError::ColdHistoryRecoveryRequired,
            TerminalReplayError::ColdHistoryRetentionRequired,
            TerminalReplayError::ColdHistoryOfferRequiresContinuation,
            TerminalReplayError::ColdHistoryProjectionBudgetExceeded,
            TerminalReplayError::ViewportCaptureBudgetExceeded {
                actual: 2,
                maximum: 1,
            },
            TerminalReplayError::ColdHistoryCellWidthExceedsColumns {
                display_width: 2,
                columns: 1,
            },
            TerminalReplayError::HistoryStorageBackpressure {
                pending_bytes: 2,
                maximum_pending_bytes: 1,
            },
        ] {
            errors.push(SessionHostError::TerminalReplay(replay));
        }
        for error in errors {
            let detail = error.failure_class().into_owned();
            let frame = WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::InputReceipt(InputReceipt {
                    request_id: "class-input".into(),
                    controller_generation: 2,
                    state: InputReceiptState::Refused,
                    reason: Some(OperationReceiptReason::ResourceLimit),
                    detail: Some(detail.clone()),
                }),
            };
            frame
                .validate(&FrameLimits::default())
                .unwrap_or_else(|failure| panic!("{error}: token {detail:?} rejected: {failure}"));
        }
        assert_eq!(
            SessionHostError::TerminalReplay(TerminalReplayError::TerminalEngineFailure {
                operation: "encode key",
                code: -1,
            })
            .failure_class(),
            "replay_engine_failure_neg1_encode_key"
        );
    }

    #[test]
    fn resize_failures_preserve_prepare_and_commit_boundaries() {
        let invalid_dimensions = classify_resize_preparation_failure(
            SessionHostError::TerminalReplay(TerminalReplayError::InvalidDimensions {
                rows: 20,
                columns: 2_000,
            }),
        );
        assert_eq!(
            (
                invalid_dimensions.reason,
                invalid_dimensions.stage,
                invalid_dimensions.cause,
            ),
            (
                OperationReceiptReason::InvalidTerminalDimensions,
                "host_prepare",
                "invalid_dimensions",
            ),
        );
        let engine_commit = classify_resize_commit_failure(SessionHostError::TerminalReplay(
            TerminalReplayError::TerminalEngineFailure {
                operation: "resize",
                code: -1,
            },
        ));
        assert_eq!(
            (
                engine_commit.reason,
                engine_commit.stage,
                engine_commit.cause,
            ),
            (
                OperationReceiptReason::PlatformResizeFailed,
                "host_commit",
                "terminal_engine",
            ),
        );
    }
}
