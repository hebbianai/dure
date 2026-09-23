mod catalog;
#[cfg(feature = "local-runtime")]
mod catalog_census;
mod connection;
mod control_plane;
mod controller;
mod discovery_roots;
mod error;
#[cfg(feature = "local-runtime")]
mod exact_discovery;
#[cfg(feature = "local-runtime")]
mod exited_retirement;
// Shared by the side that writes the forced command and the side that sends an
// SSH command, which live in crates that cannot depend on each other.
pub mod gateway_invocation;
// Both the laptop that seals a pairing QR and the phone that opens it. One
// implementation, because a KDF or a field order that differs by one detail
// fails only at a desk with a phone in hand.
#[cfg(feature = "offline-pairing")]
pub mod offline_pairing;
// Shared by the laptop that writes the online pairing exchange and the phone
// that reads it. One serde shape, transcript order, and proof implementation.
pub mod online_pairing;
// Signals pids read from a manifest against *this* kernel's process table.
// Meaningless — and, once a manifest can describe another machine, actively
// dangerous — anywhere the session is not colocated.
#[cfg(all(unix, feature = "local-runtime"))]
mod host_socket_owner;
#[cfg(all(unix, feature = "local-runtime"))]
mod legacy_terminate;
mod local_session;
#[cfg(feature = "local-runtime")]
mod managed_authorization;
#[cfg(all(windows, feature = "local-runtime"))]
mod windows_process_generation;
// Broker facades spawn a local `hmux-runtime` subprocess against
// a locally resolved binary and working directory, so they stand or fall with
// `runtime_broker` itself.
#[cfg(feature = "local-runtime")]
mod managed_attach;
#[cfg(feature = "local-runtime")]
mod managed_create;
#[cfg(feature = "local-runtime")]
mod managed_create_reconcile;
#[cfg(feature = "local-runtime")]
mod managed_rehost;
#[cfg(feature = "local-runtime")]
mod managed_session_target;
#[cfg(feature = "local-runtime")]
pub use managed_session_target::ManagedRehostResolutionResponse;
#[cfg(feature = "local-runtime")]
mod managed_stop;
mod observer;
pub mod recovery_journal;
mod report_agent_state;
#[cfg(feature = "local-runtime")]
mod runtime_broker;
mod session;
#[cfg(all(unix, feature = "local-runtime"))]
pub mod session_files;
/// CLI capability for resolving staged file paths through the session's SSH route.
pub const SESSION_FILE_ROUTE_CAPABILITY: &str = "session_file_route_v1";
mod session_liveness;
mod shell_bridge;
#[cfg(feature = "local-runtime")]
mod standalone_completed_target;
#[cfg(feature = "local-runtime")]
mod standalone_create;
#[cfg(feature = "local-runtime")]
mod standalone_replacement_source;
#[cfg(all(feature = "local-runtime", any(unix, windows)))]
mod standalone_retirement;
mod standalone_terminate;
#[cfg(feature = "local-runtime")]
mod state_gc;
#[cfg(feature = "terminal-state-stream")]
mod terminal_surface;

pub use catalog::{
    DISCOVERY_ROOT_ENV, LocalSessionCatalog, SESSION_CATALOG_QUERY_SCHEMA_VERSION,
    SessionCatalogIdentity, SessionCatalogPage, SessionCatalogQuery, SessionCatalogSnapshot,
    SessionCatalogTruncation,
};
#[cfg(feature = "local-runtime")]
pub use catalog::{StaleSessionRetirement, default_discovery_root};
#[cfg(feature = "local-runtime")]
pub use catalog_census::{
    CATALOG_CENSUS_WORKER_SUBCOMMAND, CatalogCensusError, CatalogCensusOperation,
    CatalogCensusRequest, CatalogCensusResponse, CatalogCensusWorker, CatalogResolutionError,
    list_local_sessions_isolated, query_local_sessions_isolated,
    resolve_local_session_from_complete_census, resolve_local_session_id_isolated,
    resolve_local_session_isolated, resolve_local_session_name_from_complete_census,
    resolve_local_session_name_isolated, serve_catalog_census,
};
pub use connection::{
    AttachReplay, ConnectionInterrupt, ConnectionOptions, LocalAttachRole, LocalConnection,
    LocalWriter, SHARED_TERMINAL_INPUT_CAPABILITY,
};
#[cfg(feature = "terminal-state-stream")]
pub use connection::{
    ConnectionRecord, InitialTerminalState, TerminalInputWriterCapability,
    TerminalProjectionHandle, TerminalSurfaceDetachHandle, TerminalUpstreamHandles,
};
pub use control_plane::{
    ExactSessionProbeBatchError, ExactSessionProbeResult, LegacyAdoptionDecision,
    LegacyAdoptionPolicyInput, MAX_EXACT_SESSION_PROBE_TARGETS, RecoveryDecision,
    RecoveryPolicyInput, SESSION_PROBE_QUANTUM, SessionEffectiveLifecycle, SessionHealth,
    SessionInspection, SessionProbeStatus, StandaloneUpgradeDecision, StandaloneUpgradePolicyInput,
    evaluate_legacy_adoption_policy, evaluate_recovery_policy, evaluate_standalone_upgrade_policy,
    inspect_local_session, inspect_local_sessions, inspect_local_sessions_exact,
    probe_local_session, probe_local_session_exact, probe_local_session_exact_until,
    probe_local_session_with_timeout,
};
pub use controller::{
    AttachedControllerAttachment, AttachedSessionController, ControllerAttachOptions,
    ControllerAttachment, ControllerEvent, ControllerInputReceipt, ControllerInterrupt,
    ControllerMutationHandle, ControllerNegotiation, ControllerReceiptReason,
    ControllerReceiptState, ControllerResizeReceipt, LocalSessionController,
};
pub use discovery_roots::{DEFAULT_DISCOVERY_RELATIVE_PATH, DURE_HOME_ENV};
pub use error::{ClientError, HostErrorCode, RetryDirective};
#[cfg(feature = "local-runtime")]
pub use exact_discovery::{
    EXACT_DISCOVERY_WORKER_SUBCOMMAND, ExactDiscoveryLookupRequest, ExactDiscoveryLookupResponse,
    ExactDiscoveryWorker, inspect_local_sessions_exact_isolated, serve_exact_discovery_lookup,
};
#[cfg(all(feature = "local-runtime", any(unix, windows)))]
pub use exited_retirement::CompletedStandaloneTargetLifecycle;
#[cfg(feature = "local-runtime")]
pub use exited_retirement::{
    ExitedSessionRetirementCandidates, ExitedSessionRetirementCursor, ExitedSessionRetirementError,
    ExitedSessionRetirementFence, ExitedSessionRetirementGeneration, ExitedSessionRetirementMode,
    ExitedSessionRetirementOutcome, ExitedSessionRetirementProcessProof,
    ExitedSessionRetirementReason, ExitedSessionRetirementReceipt, ExitedSessionRetirementReport,
    ExitedSessionRetirementTarget, MAX_EXITED_SESSION_RETIREMENT_TARGETS,
};
#[cfg(feature = "local-runtime")]
#[doc(hidden)]
pub use managed_attach::prepare_managed_attach_receipt;
pub use session_liveness::{
    LivenessState, Recoverability, SessionLiveness, SessionLivenessInput, liveness_state_name,
    project_session_liveness, recoverability_name,
};
#[cfg(feature = "terminal-state-stream")]
pub use terminal_surface::{
    TerminalAgentPromptError, TerminalAgentPromptReceipt, TerminalCommandInputError,
    TerminalCommandInputReceipt, TerminalIntentReceipt, TerminalSurfaceAccess,
    TerminalSurfaceAttachment, TerminalSurfaceEvent, TerminalSurfaceFrame,
};
pub mod transport;

// `SessionFence` is part of the public attach seam: a caller supplying its own
// transport has to name the session it is attaching to, and re-exporting it
// keeps that from requiring a direct `hmux-host` dependency.
#[cfg(all(unix, feature = "local-runtime"))]
pub use hmux_host::local_discovery::{DiscoveryGcMode, DiscoveryGcSelection};
pub use hmux_local_platform::peer_attestation::{AttestationError, PeerAttestation, SessionScope};
pub use hmux_runtime_contract::{
    DEFAULT_INTERACTIVE_COLORTERM, DEFAULT_INTERACTIVE_TERM, HMUX_CHANNEL_EPOCH_ENV, HMUX_ENV,
    HMUX_HOST_INSTANCE_ID_ENV, HMUX_RUNNER_INSTANCE_ENV, HMUX_RUNNER_PRINCIPAL_ENV,
    HMUX_SESSION_ID_ENV, HMUX_SESSION_NAME_ENV, HMUX_TERMINAL_EPOCH_ENV, HMUX_WORKSPACE_ID_ENV,
    MANAGED_ATTACH_BROKER_SUBCOMMAND, MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_ADVANCE_CAPABILITY, MANAGED_CREATE_BROKER_SUBCOMMAND, MANAGED_CREATE_CAPABILITY,
    MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND, MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2,
    MANAGED_CREATE_CHAIN_STOP_CAPABILITY, MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2,
    MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND, MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE,
    MANAGED_CREATE_RETIRED_EXACT_CODE, MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE,
    MANAGED_REHOST_BROKER_SUBCOMMAND, MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
    MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA,
    MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION,
    MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND, MANAGED_REHOST_RECOVERY_ACTION,
    MANAGED_REHOST_RECOVERY_ID_PREFIX, MANAGED_REHOST_REPLACEMENT_SCHEMA,
    MANAGED_REHOST_REPLACEMENT_SCHEMA_VERSION, MANAGED_REHOST_RESOLUTION_SCHEMA,
    MANAGED_REHOST_RESOLUTION_SCHEMA_VERSION, MANAGED_REHOST_SCHEMA, MANAGED_REHOST_SCHEMA_VERSION,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION, MANAGED_STOP_QUIESCENT_REQUEST_VERSION,
    MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND, MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES,
    ManagedAttachBrokerResponse, ManagedAttachDecision, ManagedAttachFailure,
    ManagedAttachFinalization, ManagedAttachReceipt, ManagedAttachRequest,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest, ManagedCreateBrokerResponse,
    ManagedCreateChainStopBrokerResponse, ManagedCreateChainStopBrokerResponseV2,
    ManagedCreateChainStopReceipt, ManagedCreateChainStopReceiptV2, ManagedCreateFailure,
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt,
    ManagedCreateReconcileAuthorityUnavailable, ManagedCreateReconcileBrokerResponse,
    ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedRehostBrokerResponse,
    ManagedRehostFailure, ManagedRehostGeneration, ManagedRehostLaunchIdentity,
    ManagedRehostReceipt, ManagedRehostRecipe, ManagedRehostReconcileRequest,
    ManagedRehostReplacement, ManagedRehostRequest, ManagedRehostResolution,
    ManagedRehostSourceRecipe, ManagedStopBrokerResponse, ManagedStopConversationFence,
    ManagedStopFailure, ManagedStopOutcome, ManagedStopQuiescenceFence, ManagedStopReceipt,
    ManagedStopReconcileRequest, ManagedStopRequest, PROVIDER_STATE_ENVIRONMENT_CAPABILITY,
    PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY, PermissionMode,
    PresentationCheckpointPredecessor, ProviderConversationIdentitySeed, ProviderStateEnvironment,
    STANDALONE_CREATE_BROKER_SUBCOMMAND, STANDALONE_REQUEST_BOUND_CREATE_CAPABILITY,
    StandaloneCreateBrokerResponse, StandaloneCreateFailure, StandaloneCreateReceipt,
    StandaloneCreateRequest, StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity,
    StandaloneResurrectionRecipe, StandaloneResurrectionReplayPolicy, TerminalDefaultColors,
    TerminalEnvironment, TerminalEnvironmentPolicy, interactive_terminal_environment_policy,
    read_managed_attach_finalization, read_managed_attach_request,
    read_managed_create_advance_request, read_managed_create_chain_stop_request,
    read_managed_create_request, read_standalone_create_request, write_managed_attach_finalization,
    write_managed_attach_response, write_managed_create_advance_response,
    write_managed_create_chain_stop_response, write_managed_create_chain_stop_response_v2,
    write_managed_create_response, write_standalone_create_response,
};
pub use hmux_session_protocol::AgentStateReportCausality;
pub use hmux_session_protocol::discovery::SessionRetirementPolicy;
pub use hmux_session_protocol::{
    AGENT_PROMPT_CAPABILITY, AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
    AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY, AGENT_STATE_REPORT_MAX_WORKING_TTL_MS,
    LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    PROVIDER_CONVERSATION_CONTINUATION_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY,
};
pub use hmux_session_protocol::{
    FrameBody, MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY, SESSION_RETIREMENT_ADMIN_CAPABILITY,
    SESSION_RETIREMENT_CAPABILITY, ScreenSnapshotProfile, ScreenSnapshotRequest, SessionFence,
    SessionRetirementAction, SessionRetirementReceipt, SessionRetirementReceiptReason,
    SessionRetirementReceiptState, UNPRESENTED_CREATION_ABANDON_CAPABILITY,
};
#[cfg(all(unix, feature = "local-runtime"))]
pub use host_socket_owner::local_host_socket_owner_absent;
#[cfg(all(unix, feature = "local-runtime"))]
pub use legacy_terminate::{
    LocalProcessGenerationStatus, exact_local_process_generation, probe_local_process_generation,
};
pub use local_session::LocalSession;
#[cfg(feature = "local-runtime")]
pub use managed_attach::ManagedSessionAttacher;
#[cfg(feature = "local-runtime")]
pub use managed_create::{
    CreatedManagedSession, ManagedCreateAdvanceResolution, ManagedCreateChainResolution,
    ManagedCreateError, ManagedCreateFailureDisposition, ManagedCreateIdentityResolution,
    ManagedCreateResolution, ManagedCreateResolutionError, ManagedSessionCreator,
    managed_replacement_root_request,
};
#[cfg(feature = "local-runtime")]
pub use managed_create_reconcile::ManagedSessionCreateReconciler;
#[cfg(feature = "local-runtime")]
pub use managed_rehost::{
    MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV, ManagedRehostSource, ManagedSessionRehoster,
};
#[cfg(feature = "local-runtime")]
pub use managed_stop::{
    MANAGED_STOP_OUTCOME_UNKNOWN_CODE, MANAGED_STOP_REFUSED_CODE, ManagedSessionStopper,
};
pub use observer::{
    AgentIdentityDescriptor, AgentIdentitySource, AgentProvider, AgentRuntimeActivity,
    AgentRuntimeAttention, AgentRuntimeLifecycle, AgentRuntimeStateDescriptor,
    AgentRuntimeStateSource, AttachedObserverAttachment, AttachedSessionObserver,
    AuthorizationProofReference, ExecutionLocation, ExecutionLocationDescriptor,
    ExecutionLocationSource, LocalSessionObserver, ObserverAttachOptions, ObserverAttachment,
    ObserverEvent, ObserverExit, ObserverInterrupt, ObserverLifecycle, ObserverMutationHandle,
    ObserverNegotiation, OutputDeltaDescriptor, ProviderConversationIdentityDescriptor,
    ProviderConversationIdentitySource, RecoveredPresentationDescriptor, ReplayGapDescriptor,
    ScreenSnapshotDescriptor, ScreenSnapshotProfileDescriptor, WorkingDirectoryDescriptor,
    WorkingDirectorySource, project_agent_identity, project_agent_runtime_state,
    project_provider_conversation_identity, project_working_directory_projection,
};
#[cfg(feature = "local-runtime")]
pub use report_agent_state::ManagedAgentStateReporter;
pub use report_agent_state::{
    AgentStateReport, AgentStateReportObservationFence, AgentStateReportOutcome,
    ProviderConversationIdentity,
};
pub use session::{
    EndpointDescriptor, EndpointKind, ExitDescriptor, ProcessDescriptor, ProtocolVersion,
    SessionClass, SessionDescriptor, SessionFailureDescriptor, SessionLifecycle, SessionSelector,
    VersionRange,
};
pub use shell_bridge::{InteractiveShellBridgeError, interactive_shell_with_command_bridge};
#[cfg(feature = "local-runtime")]
pub use standalone_completed_target::{
    COMPLETED_STANDALONE_TARGET_SCHEMA, CompletedStandaloneTarget,
    validate_standalone_recovery_receipt,
};
#[cfg(feature = "local-runtime")]
pub use standalone_create::{
    CreatedStandaloneSession, StandaloneSessionCreator, standalone_create_idempotency_key,
};
#[cfg(feature = "local-runtime")]
pub use standalone_replacement_source::StandaloneReplacementSource;
#[cfg(feature = "local-runtime")]
pub use state_gc::{
    LocalStateGcError, LocalStateGcPolicy, LocalStateGcReport, collect_local_state,
    maintain_registration_capacity,
};
#[cfg(all(windows, feature = "local-runtime"))]
pub use windows_process_generation::{
    LocalProcessGenerationStatus, exact_local_process_generation, probe_local_process_generation,
};
