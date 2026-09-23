pub use hmux_session_protocol::TerminalDefaultColors;
use hmux_session_protocol::discovery::SessionRetirementPolicy;
use hmux_session_protocol::{
    AGENT_PROMPT_CAPABILITY, AgentPromptCapabilitySelection, AgentStateReport,
    AgentStateReportOutcome, FrameBody, FrameLimits, LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
    MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY, MANAGED_PROVIDER_STOP_CAPABILITY,
    PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY, PROTOCOL_V1, SessionFence, WireFrame,
};
use serde::de::DeserializeOwned;
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

mod client_session_environment;
mod standalone_create;
mod standalone_create_operation;
mod standalone_recipe;

pub use standalone_create::{
    STANDALONE_LOCATED_OPERATION_CREATE_CAPABILITY, STANDALONE_OPERATION_BOUND_CREATE_CAPABILITY,
    StandaloneCreateRequest,
};

pub use client_session_environment::{
    is_launching_client_session_env_key, launching_client_session_env_keys,
};

pub use standalone_create_operation::{
    AdmittedStandaloneCreateOperation, STANDALONE_CREATE_OPERATION_CAPABILITY,
    STANDALONE_CREATE_OPERATION_PROTOCOL_MANIFEST,
    STANDALONE_CREATE_OPERATION_RECONCILE_CAPABILITY,
    STANDALONE_CREATE_OPERATION_RETIRE_COMPLETED_TARGET_CAPABILITY,
    STANDALONE_CREATE_OPERATION_RETIREMENT_ACKNOWLEDGE_CAPABILITY,
    STANDALONE_CREATE_OPERATION_SCHEMA_VERSION, STANDALONE_CREATE_OPERATION_SUBCOMMAND,
    StandaloneCreateOperationMode, StandaloneCreateOperationRequest,
    StandaloneCreateOperationResponse, read_standalone_create_operation_request,
    read_standalone_create_operation_response, read_standalone_create_operation_response_for,
    write_standalone_create_operation_response,
};

pub const STANDALONE_CREATE_BROKER_SUBCOMMAND: &str = "internal-hmux-standalone-create";
/// The full managed create grammar, including provider-state removals.
/// Host attachment protocol compatibility does not imply broker compatibility.
pub const MANAGED_CREATE_CAPABILITY: &str = "managed_create_v6";
/// Request-bound standalone identities must never become general resurrection recipes.
pub const STANDALONE_REQUEST_BOUND_CREATE_CAPABILITY: &str = "standalone_request_bound_create_v1";
pub const MANAGED_CREATE_BROKER_SUBCOMMAND: &str = "internal-hmux-managed-create";
pub const MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND: &str =
    "internal-hmux-managed-create-reconcile";
pub const MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND: &str =
    "internal-hmux-managed-create-advance-v3";
pub const MANAGED_CREATE_ADVANCE_CAPABILITY: &str = "managed_create_advance_v3";
pub const MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND: &str =
    "internal-hmux-managed-create-chain-stop";
pub const MANAGED_CREATE_CHAIN_STOP_CAPABILITY: &str = "managed_create_chain_stop_v1";
pub const MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2: &str =
    "internal-hmux-managed-create-chain-stop-v2";
pub const MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2: &str = "managed_create_chain_stop_v2";
pub const MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES: usize = 128;
pub const MANAGED_ATTACH_BROKER_SUBCOMMAND: &str = "internal-hmux-managed-attach";
pub const MANAGED_AGENT_STATE_REPORT_BROKER_SUBCOMMAND: &str =
    "internal-hmux-managed-agent-state-report";
pub const MANAGED_STOP_BROKER_SUBCOMMAND: &str = "internal-hmux-managed-stop";
pub const MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND: &str = "internal-hmux-managed-stop-reconcile";
pub const MANAGED_REHOST_BROKER_SUBCOMMAND: &str = "internal-hmux-managed-rehost";
pub const MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND: &str =
    "internal-hmux-managed-rehost-reconcile";
pub const MANAGED_REHOST_RECOVERY_ACTION: &str = "managed_rehost_exact_fence_v1";
pub const MANAGED_REHOST_RECOVERY_ID_PREFIX: &str = "managed-rehost-v1:";
pub const MANAGED_CONVERSATION_WRITER_CONFLICT_CODE: &str =
    "hmux_managed_conversation_writer_conflict";
pub const MANAGED_CREATE_RETIRED_EXACT_CODE: &str = "hmux_managed_create_retired_exact";
pub const MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE: &str =
    "hmux_managed_create_request_digest_conflict";
pub const MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE: &str =
    "hmux_managed_create_successor_digest_conflict";
pub const MANAGED_CREATE_REQUEST_INVALID_CODE: &str = "hmux_managed_request_invalid";
pub const DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE: &str =
    "hmux_discovery_registration_capacity_exceeded";
pub const HOST_REGISTRATION_CAPACITY_EXIT_CODE: i32 = 73;
pub const HMUX_ENV: &str = "HMUX";
pub const HMUX_SESSION_ID_ENV: &str = "HMUX_SESSION_ID";
pub const HMUX_SESSION_NAME_ENV: &str = "HMUX_SESSION_NAME";
pub const HMUX_WORKSPACE_ID_ENV: &str = "HMUX_WORKSPACE_ID";
pub const HMUX_RUNNER_PRINCIPAL_ENV: &str = "HMUX_RUNNER_PRINCIPAL";
pub const HMUX_RUNNER_INSTANCE_ENV: &str = "HMUX_RUNNER_INSTANCE";
pub const HMUX_CHANNEL_EPOCH_ENV: &str = "HMUX_CHANNEL_EPOCH";
pub const HMUX_HOST_INSTANCE_ID_ENV: &str = "HMUX_HOST_INSTANCE_ID";
pub const HMUX_TERMINAL_EPOCH_ENV: &str = "HMUX_TERMINAL_EPOCH";

const BROKER_SCHEMA_V1: &str = "hmux-standalone-create-v1";
const BROKER_SCHEMA_VERSION_V1: u16 = 1;
const BROKER_SCHEMA_V2: &str = "hmux-standalone-create-v2";
const BROKER_SCHEMA_VERSION_V2: u16 = 2;
const BROKER_SCHEMA_V3: &str = "hmux-standalone-create-v3";
const BROKER_SCHEMA_VERSION_V3: u16 = 3;
const MANAGED_ATTACH_SCHEMA: &str = "hmux-managed-attach-v1";
const MANAGED_ATTACH_SCHEMA_VERSION: u16 = 1;
const MANAGED_AGENT_STATE_REPORT_SCHEMA: &str = "hmux-managed-agent-state-report-v1";
const MANAGED_AGENT_STATE_REPORT_SCHEMA_VERSION: u16 = 1;
const MANAGED_AGENT_STATE_REPORT_CAUSAL_SCHEMA_VERSION: u16 = 2;
const MANAGED_CREATE_SCHEMA: &str = "hmux-managed-create-v1";
const MANAGED_CREATE_SCHEMA_VERSION: u16 = 1;
const MANAGED_CREATE_PROVIDER_STATE_SCHEMA: &str = "hmux-managed-create-v2";
const MANAGED_CREATE_PROVIDER_STATE_SCHEMA_VERSION: u16 = 2;
const MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA: &str = "hmux-managed-create-v3";
const MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA_VERSION: u16 = 3;
const MANAGED_CREATE_REHOST_RECIPE_SCHEMA: &str = "hmux-managed-create-v4";
const MANAGED_CREATE_REHOST_RECIPE_SCHEMA_VERSION: u16 = 4;
const MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA: &str = "hmux-managed-create-v5";
const MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION: u16 = 5;
const MANAGED_CREATE_PROVIDER_STATE_REMOVAL_SCHEMA: &str = "hmux-managed-create-v6";
const MANAGED_CREATE_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION: u16 = 6;
const MANAGED_CREATE_RECONCILE_SCHEMA: &str = "hmux-managed-create-reconcile-v1";
const MANAGED_CREATE_RECONCILE_SCHEMA_VERSION: u16 = 1;
const MANAGED_CREATE_ADVANCE_SCHEMA: &str = "hmux-managed-create-advance-v2";
const MANAGED_CREATE_ADVANCE_SCHEMA_VERSION: u16 = 2;
const MANAGED_CREATE_REPLACE_CURRENT_SCHEMA: &str = "hmux-managed-create-replace-current-v1";
const MANAGED_CREATE_REPLACE_CURRENT_SCHEMA_VERSION: u16 = 1;
const MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA: &str = "hmux-managed-create-chain-stop-v1";
const MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_VERSION: u16 = 1;
const MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_V2: &str = "hmux-managed-create-chain-stop-v2";
const MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_VERSION_V2: u16 = 2;
const MANAGED_REHOST_RECIPE_SCHEMA: &str = "hmux-managed-rehost-recipe-v1";
const MANAGED_REHOST_RECIPE_SCHEMA_VERSION: u16 = 1;
const MANAGED_REHOST_SOURCE_RECIPE_SCHEMA: &str = "hmux-managed-rehost-source-recipe-v1";
const MANAGED_REHOST_SOURCE_RECIPE_SCHEMA_VERSION: u16 = 1;
const MANAGED_REHOST_SOURCE_RECIPE_TERMINAL_DEFAULT_COLORS_SCHEMA: &str =
    "hmux-managed-rehost-source-recipe-v2";
const MANAGED_REHOST_SOURCE_RECIPE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION: u16 = 2;
const MANAGED_REHOST_SOURCE_RECIPE_PROVIDER_STATE_REMOVAL_SCHEMA: &str =
    "hmux-managed-rehost-source-recipe-v3";
const MANAGED_REHOST_SOURCE_RECIPE_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION: u16 = 3;
pub const MANAGED_REHOST_SCHEMA: &str = "hmux-managed-rehost-v1";
pub const MANAGED_REHOST_SCHEMA_VERSION: u16 = 1;
pub const MANAGED_REHOST_REPLACEMENT_SCHEMA: &str = "hmux-managed-rehost-v2";
pub const MANAGED_REHOST_REPLACEMENT_SCHEMA_VERSION: u16 = 2;
pub const MANAGED_REHOST_TARGET_BUILD_SCHEMA: &str = "hmux-managed-rehost-v3";
pub const MANAGED_REHOST_TARGET_BUILD_SCHEMA_VERSION: u16 = 3;
pub const MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA: &str = "managed-session-replacement-v4";
pub const MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA_VERSION: u16 = 4;
pub const MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA: &str = "managed-session-replacement-v5";
pub const MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION: u16 = 5;
pub const MANAGED_REHOST_SOCKET_OWNER_ABSENT_SCHEMA: &str = "managed-session-replacement-v6";
pub const MANAGED_REHOST_SOCKET_OWNER_ABSENT_SCHEMA_VERSION: u16 = 6;
pub const MANAGED_REHOST_GUARDED_FRESH_SCHEMA: &str = "managed-session-replacement-v7";
pub const MANAGED_REHOST_GUARDED_FRESH_SCHEMA_VERSION: u16 = 7;
const MANAGED_REHOST_FRESH_RECEIPT_SCHEMA: &str = "managed-session-replacement-receipt-v2";
const MANAGED_REHOST_FRESH_RECEIPT_SCHEMA_VERSION: u16 = 2;
const MANAGED_REHOST_RECONCILE_SCHEMA: &str = "hmux-managed-rehost-reconcile-v1";
const MANAGED_REHOST_RECONCILE_SCHEMA_VERSION: u16 = 1;
const MANAGED_REHOST_RECONCILE_IDENTITY_SCHEMA: &str = "hmux-managed-rehost-reconcile-identity-v2";
const MANAGED_REHOST_RECONCILE_IDENTITY_SCHEMA_VERSION: u16 = 2;
pub const MANAGED_REHOST_RESOLUTION_SCHEMA: &str = "hmux-managed-rehost-resolution-v1";
pub const MANAGED_REHOST_RESOLUTION_SCHEMA_VERSION: u16 = 1;
const MANAGED_STOP_SCHEMA: &str = "hmux-managed-stop-v1";
const MANAGED_STOP_REQUEST_SCHEMA_VERSION_LEGACY: u16 = 1;
const MANAGED_STOP_REQUEST_SCHEMA_VERSION_FENCED: u16 = 2;
pub const MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION: u16 = 3;
const MANAGED_STOP_REQUEST_SCHEMA_VERSION_COMPLETE_FENCE: u16 =
    MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION;
pub const MANAGED_STOP_QUIESCENT_REQUEST_VERSION: u16 = 4;
pub const MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION: u16 = 5;
const MANAGED_STOP_RECEIPT_SCHEMA_VERSION_COMPLETE_FENCE: u16 = 2;
const MANAGED_STOP_RECONCILE_SCHEMA: &str = "hmux-managed-stop-reconcile-v1";
const MANAGED_STOP_RECONCILE_SCHEMA_VERSION_COMPLETE_FENCE: u16 = 2;
pub const MAX_BROKER_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_RECOVERY_OPERATION_PAYLOAD_BYTES: usize = 32 * 1024;
const MAX_SESSION_NAME_BYTES: usize = 256;
const MAX_COMMAND_ARGUMENTS: usize = 64;
const MAX_COMMAND_ARGUMENT_BYTES: usize = 32 * 1024;
const MAX_TERMINAL_ENVIRONMENT_OVERRIDES: usize = 16;
const MAX_TERMINAL_ENVIRONMENT_VALUE_BYTES: usize = 32 * 1024;
const MAX_PROVIDER_STATE_ENVIRONMENT_ENTRIES: usize = 32;
const MAX_PROVIDER_STATE_ENVIRONMENT_NAME_BYTES: usize = 64;
const MAX_PROVIDER_STATE_ENVIRONMENT_PATH_BYTES: usize = 4096;
const RESURRECTION_SCHEMA_V1: &str = "hmux-standalone-resurrection-v1";
const RESURRECTION_SCHEMA_VERSION_V1: u16 = 1;
const RESURRECTION_SCHEMA_V2: &str = "hmux-standalone-resurrection-v2";
const RESURRECTION_SCHEMA_VERSION_V2: u16 = 2;
const RESURRECTION_SCHEMA_V3: &str = "hmux-standalone-resurrection-v3";
const RESURRECTION_SCHEMA_VERSION_V3: u16 = 3;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_AUTHORIZATION_REFERENCE_BYTES: usize = 4096;
const MAX_STOP_REASON_BYTES: usize = 4096;
const MAX_MANAGED_REHOST_OPERATION_ID_BYTES: usize = 128;
pub const MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER: &str = "__HMUX_EXACT_CONVERSATION_ID__";

pub const DEFAULT_INTERACTIVE_TERM: &str = "xterm-256color";
pub const DEFAULT_INTERACTIVE_COLORTERM: &str = "truecolor";
pub const PROVIDER_STATE_ENVIRONMENT_CAPABILITY: &str = "provider_state_environment_v1";
/// Provider-state mutations may explicitly remove inherited selectors before
/// a provider child is spawned. Older Hosts must reject these mutations rather
/// than silently inheriting their own launch environment.
pub const PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY: &str =
    "provider_state_environment_removal_v1";

fn managed_stop_requirement_capability(version: u16) -> Option<&'static str> {
    match version {
        MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION => Some(MANAGED_PROVIDER_STOP_CAPABILITY),
        MANAGED_STOP_QUIESCENT_REQUEST_VERSION => Some(MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY),
        MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION => {
            Some(MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY)
        }
        _ => None,
    }
}

fn managed_create_stop_requirement_capability(version: u16) -> Option<&'static str> {
    match version {
        MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION
        | MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION => {
            managed_stop_requirement_capability(version)
        }
        _ => None,
    }
}
/// Binary carrier for the complete structured viewport profile.
pub const TERMINAL_STATE_BINARY_CAPABILITY: &str = "terminal_state_binary_v1";
/// Complete, replaceable viewport frames with connection-local scroll state.
pub const TERMINAL_VIEWPORT_PROJECTION_CAPABILITY: &str = "terminal_viewport_projection_v1";
/// One ordered wheel intent whose final route is chosen by the Host-owned
/// terminal actor from current modes and the attachment's available sinks.
pub const TERMINAL_VIEWPORT_WHEEL_CAPABILITY: &str = "terminal_viewport_wheel_v1";
/// Multipart transport for a complete viewport that exceeds one terminal-state
/// envelope. The base viewport capability remains the rolling-upgrade path.
pub const TERMINAL_VIEWPORT_MULTIPART_CAPABILITY: &str = "terminal_viewport_multipart_v1";
/// Semantic terminal input carried as binary records and acknowledged by
/// correlated binary final receipts. Admission is connection-scoped and does
/// not depend on client colocation or a controller lease.
pub const TERMINAL_INPUT_INTENT_CAPABILITY: &str = "terminal_input_intent_v1";
/// Allows a writable structured surface to update the terminal core defaults
/// used for OSC 10/11 replies through the existing ordered viewport stream.
pub const TERMINAL_DEFAULT_COLORS_CAPABILITY: &str = "terminal_default_colors_v1";

/// Selects exactly one prompt wire lane without reinterpreting independent
/// terminal capabilities requested by the same attachment.
#[must_use]
pub fn terminal_capability_permitted_for_agent_prompt(
    selection: Option<AgentPromptCapabilitySelection>,
    capability: &str,
) -> bool {
    match selection {
        None => !matches!(
            capability,
            AGENT_PROMPT_CAPABILITY
                | LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY
                | PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY
        ),
        Some(AgentPromptCapabilitySelection::Targeted) => {
            capability != LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY
        }
        Some(AgentPromptCapabilitySelection::LegacyFresh) => !matches!(
            capability,
            AGENT_PROMPT_CAPABILITY | PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY
        ),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalViewportProtocolVersion {
    pub envelope_major: u8,
    pub envelope_minor: u8,
}

/// Envelope/schema minor for every terminal record kind that predates the
/// minor-5 wheel and multipart additions. Selecting either capability never
/// changes this value; only the capability-specific record kinds use minor 5.
pub const TERMINAL_STATE_BASE_PROTOCOL_MINOR: u8 = 4;

pub const TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION: TerminalViewportProtocolVersion =
    TerminalViewportProtocolVersion {
        envelope_major: 1,
        envelope_minor: 5,
    };

pub const TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION: TerminalViewportProtocolVersion =
    TerminalViewportProtocolVersion {
        envelope_major: 1,
        envelope_minor: 5,
    };

pub const TERMINAL_DEFAULT_COLORS_PROTOCOL_VERSION: TerminalViewportProtocolVersion =
    TerminalViewportProtocolVersion {
        envelope_major: 1,
        envelope_minor: 6,
    };

/// Whether a requested structured-terminal capability set names one complete
/// carrier. Binary transport and viewport projection are inseparable, and
/// dependent operations cannot be requested without both.
#[must_use]
pub fn terminal_capability_request_is_consistent(requested_capabilities: &[String]) -> bool {
    let requested = |capability: &str| {
        requested_capabilities
            .iter()
            .any(|requested| requested == capability)
    };
    let binary = requested(TERMINAL_STATE_BINARY_CAPABILITY);
    let viewport = requested(TERMINAL_VIEWPORT_PROJECTION_CAPABILITY);
    let input = requested(TERMINAL_INPUT_INTENT_CAPABILITY);
    let agent_prompt =
        requested(AGENT_PROMPT_CAPABILITY) || requested(LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY);
    let process_observed_agent_prompt = requested(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY);
    let dependent = input
        || agent_prompt
        || process_observed_agent_prompt
        || requested(TERMINAL_VIEWPORT_WHEEL_CAPABILITY)
        || requested(TERMINAL_VIEWPORT_MULTIPART_CAPABILITY)
        || requested(TERMINAL_DEFAULT_COLORS_CAPABILITY);
    binary == viewport
        && (!dependent || (binary && viewport))
        && (!process_observed_agent_prompt || requested(AGENT_PROMPT_CAPABILITY))
}

/// Returns the envelope minor selected for all pre-existing terminal record
/// kinds. Minor-5 permissions are deliberately separate from this value so a
/// new record kind cannot silently upgrade input, resize, receipt, event, or
/// direct viewport records. The carrier and viewport capabilities form one
/// exact base profile; neither selects a structured stream by itself.
#[must_use]
pub fn selected_terminal_base_protocol_minor(selected_capabilities: &[String]) -> Option<u8> {
    [
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    ]
    .into_iter()
    .all(|required| {
        selected_capabilities
            .iter()
            .any(|selected| selected == required)
    })
    .then_some(TERMINAL_STATE_BASE_PROTOCOL_MINOR)
}

/// Whether the selected capability set permits minor-5
/// `ViewportFramePart` records. This does not change the base record minor.
#[must_use]
pub fn terminal_viewport_multipart_permitted(selected_capabilities: &[String]) -> bool {
    [
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    ]
    .into_iter()
    .all(|required| {
        selected_capabilities
            .iter()
            .any(|selected| selected == required)
    })
}

/// Whether this attachment selected the minor-5 wheel intent and receipt.
#[must_use]
pub fn terminal_viewport_wheel_permitted(selected_capabilities: &[String]) -> bool {
    [
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    ]
    .into_iter()
    .all(|required| {
        selected_capabilities
            .iter()
            .any(|selected| selected == required)
    })
}

/// Whether this writable attachment selected minor-6 default-color intents.
#[must_use]
pub fn terminal_default_colors_permitted(selected_capabilities: &[String]) -> bool {
    [
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
        TERMINAL_DEFAULT_COLORS_CAPABILITY,
    ]
    .into_iter()
    .all(|required| {
        selected_capabilities
            .iter()
            .any(|selected| selected == required)
    })
}

const TERMINAL_ENVIRONMENT_KEYS: &[&str] = &[
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "FORCE_COLOR",
];

/// Explicit per-session terminal environment overrides. `None` removes the
/// variable. An absent key inherits the interactive profile: TERM/COLORTERM
/// defaults are set, inherited NO_COLOR is removed, and other color variables
/// remain untouched.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TerminalEnvironment(BTreeMap<String, Option<String>>);

impl TerminalEnvironment {
    pub fn new(values: BTreeMap<String, Option<String>>) -> Result<Self, RuntimeContractError> {
        let environment = Self(values);
        environment.validate()?;
        Ok(environment)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn values(&self) -> &BTreeMap<String, Option<String>> {
        &self.0
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.0.len() > MAX_TERMINAL_ENVIRONMENT_OVERRIDES {
            return Err(RuntimeContractError::new(
                "too many terminal environment overrides",
            ));
        }
        for (key, value) in &self.0 {
            if !TERMINAL_ENVIRONMENT_KEYS.contains(&key.as_str()) {
                return Err(RuntimeContractError::new(format!(
                    "unsupported terminal environment override: {key}"
                )));
            }
            if value
                .as_ref()
                .is_some_and(|value| value.len() > MAX_TERMINAL_ENVIRONMENT_VALUE_BYTES)
            {
                return Err(RuntimeContractError::new(format!(
                    "terminal environment override is too large: {key}"
                )));
            }
        }
        Ok(())
    }
}

/// Private, per-process provider state-root selection. Values are absolute
/// filesystem paths, never tokens or credential contents. The environment is
/// carried only in the bounded broker/Host launch packet and is intentionally
/// absent from discovery manifests and create receipts.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct ProviderStateEnvironment {
    set: BTreeMap<String, String>,
    remove: BTreeSet<String>,
}

impl ProviderStateEnvironment {
    pub fn new(values: BTreeMap<String, String>) -> Result<Self, RuntimeContractError> {
        Self::from_mutations(values, BTreeSet::new())
    }

    pub fn from_mutations(
        set: BTreeMap<String, String>,
        remove: BTreeSet<String>,
    ) -> Result<Self, RuntimeContractError> {
        let environment = Self { set, remove };
        environment.validate()?;
        Ok(environment)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.set.is_empty() && self.remove.is_empty()
    }

    #[must_use]
    pub fn values(&self) -> &BTreeMap<String, String> {
        &self.set
    }

    #[must_use]
    pub fn removals(&self) -> &BTreeSet<String> {
        &self.remove
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.set.len() + self.remove.len() > MAX_PROVIDER_STATE_ENVIRONMENT_ENTRIES {
            return Err(RuntimeContractError::new(
                "provider state environment has too many entries",
            ));
        }
        if self.set.keys().any(|key| self.remove.contains(key)) {
            return Err(RuntimeContractError::new(
                "provider state environment cannot set and remove the same key",
            ));
        }
        for key in self.set.keys() {
            if !provider_state_environment_set_name_is_supported(key) {
                return Err(RuntimeContractError::new(format!(
                    "provider state environment key is unsupported: {key}"
                )));
            }
        }
        for key in &self.remove {
            if !provider_state_environment_removal_name_is_supported(key) {
                return Err(RuntimeContractError::new(format!(
                    "provider state environment key is unsupported: {key}"
                )));
            }
        }
        for (key, value) in &self.set {
            if value.is_empty()
                || value.len() > MAX_PROVIDER_STATE_ENVIRONMENT_PATH_BYTES
                || value.chars().any(char::is_control)
                || !Path::new(value).is_absolute()
            {
                return Err(RuntimeContractError::new(format!(
                    "provider state environment path is invalid: {key}"
                )));
            }
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderStateEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderStateEnvironment")
            .field("set_keys", &self.set.keys().collect::<Vec<_>>())
            .field("removed_keys", &self.remove)
            .field("values", &"<redacted paths>")
            .finish()
    }
}

fn provider_state_environment_name_is_safe(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_PROVIDER_STATE_ENVIRONMENT_NAME_BYTES
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && key
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        && key != "HOME"
        && key != "PATH"
        && !key.starts_with("HMUX")
        && !TERMINAL_ENVIRONMENT_KEYS.contains(&key)
}

fn provider_state_root_name_is_supported(key: &str) -> bool {
    provider_state_environment_name_is_safe(key)
        && (key.ends_with("_HOME")
            || key.ends_with("_CONFIG_DIR")
            || key.ends_with("_STATE_DIR")
            || key.ends_with("_DATA_DIR"))
}

fn provider_state_environment_name_is_sensitive(key: &str) -> bool {
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
        "API_KEY",
        "AUTH",
    ]
    .iter()
    .any(|fragment| key.contains(fragment))
}

fn provider_state_environment_set_name_is_supported(key: &str) -> bool {
    provider_state_root_name_is_supported(key) && !provider_state_environment_name_is_sensitive(key)
}

fn provider_state_environment_removal_name_is_supported(key: &str) -> bool {
    provider_state_environment_name_is_safe(key)
}

impl Serialize for ProviderStateEnvironment {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.set.len() + self.remove.len()))?;
        for (key, value) in &self.set {
            map.serialize_entry(key, value)?;
        }
        for key in &self.remove {
            map.serialize_entry(key, &Option::<&str>::None)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ProviderStateEnvironment {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mutations = BTreeMap::<String, Option<String>>::deserialize(deserializer)?;
        let mut set = BTreeMap::new();
        let mut remove = BTreeSet::new();
        for (key, value) in mutations {
            match value {
                Some(value) => {
                    set.insert(key, value);
                }
                None => {
                    remove.insert(key);
                }
            }
        }
        Self::from_mutations(set, remove).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalEnvironmentPolicy {
    set: BTreeMap<String, String>,
    remove: BTreeSet<String>,
}

impl TerminalEnvironmentPolicy {
    #[must_use]
    pub fn set(&self) -> &BTreeMap<String, String> {
        &self.set
    }

    #[must_use]
    pub fn remove(&self) -> &BTreeSet<String> {
        &self.remove
    }
}

/// Build the common environment mutation applied only when a new interactive
/// process is spawned. Reattaching to a running process cannot change its
/// environment and intentionally does not call this policy.
#[must_use]
pub fn interactive_terminal_environment_policy(
    overrides: &TerminalEnvironment,
) -> TerminalEnvironmentPolicy {
    let mut set = BTreeMap::from([
        (
            "COLORTERM".to_string(),
            DEFAULT_INTERACTIVE_COLORTERM.to_string(),
        ),
        ("TERM".to_string(), DEFAULT_INTERACTIVE_TERM.to_string()),
    ]);
    let mut remove = BTreeSet::from(["NO_COLOR".to_string()]);
    for (key, value) in overrides.values() {
        match value {
            Some(value) => {
                remove.remove(key);
                set.insert(key.clone(), value.clone());
            }
            None => {
                set.remove(key);
                remove.insert(key.clone());
            }
        }
    }
    TerminalEnvironmentPolicy { set, remove }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneResurrectionRecipe {
    schema: String,
    schema_version: u16,
    session_name: String,
    provider_cwd: PathBuf,
    command: Vec<String>,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default, skip_serializing_if = "TerminalEnvironment::is_empty")]
    terminal_environment: TerminalEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resurrection_replay_policy: Option<StandaloneResurrectionReplayPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retirement_policy: Option<SessionRetirementPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_default_colors: Option<TerminalDefaultColors>,
    created_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StandaloneResurrectionReplayPolicy {
    SafeInteractiveShell,
    ConfirmExplicitCommand,
}

impl StandaloneResurrectionRecipe {
    pub fn new(
        session_name: impl Into<String>,
        provider_cwd: impl Into<PathBuf>,
        command: Vec<String>,
        initial_rows: u16,
        initial_columns: u16,
        created_unix_ms: u64,
    ) -> Result<Self, RuntimeContractError> {
        let recipe = Self {
            schema: RESURRECTION_SCHEMA_V1.to_string(),
            schema_version: RESURRECTION_SCHEMA_VERSION_V1,
            session_name: session_name.into(),
            provider_cwd: provider_cwd.into(),
            command,
            initial_rows,
            initial_columns,
            terminal_environment: TerminalEnvironment::default(),
            resurrection_replay_policy: None,
            retirement_policy: None,
            terminal_default_colors: None,
            created_unix_ms,
        };
        recipe.validate()?;
        Ok(recipe)
    }

    pub fn with_terminal_environment(
        mut self,
        terminal_environment: TerminalEnvironment,
    ) -> Result<Self, RuntimeContractError> {
        terminal_environment.validate()?;
        self.terminal_environment = terminal_environment;
        self.validate()?;
        Ok(self)
    }

    pub fn with_resurrection_replay_policy(
        mut self,
        resurrection_replay_policy: StandaloneResurrectionReplayPolicy,
    ) -> Result<Self, RuntimeContractError> {
        self.resurrection_replay_policy = Some(resurrection_replay_policy);
        self.validate()?;
        Ok(self)
    }

    pub fn with_retirement_policy(
        self,
        retirement_policy: SessionRetirementPolicy,
    ) -> Result<Self, RuntimeContractError> {
        self.with_retirement_policy_option(Some(retirement_policy))
    }

    pub fn with_retirement_policy_option(
        mut self,
        retirement_policy: Option<SessionRetirementPolicy>,
    ) -> Result<Self, RuntimeContractError> {
        if retirement_policy.is_some_and(|policy| !policy.is_valid()) {
            return Err(RuntimeContractError::new(
                "standalone retirement policy is invalid",
            ));
        }
        self.retirement_policy = retirement_policy;
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    pub fn with_terminal_default_colors(
        self,
        colors: TerminalDefaultColors,
    ) -> Result<Self, RuntimeContractError> {
        self.with_terminal_default_colors_option(Some(colors))
    }

    pub fn with_terminal_default_colors_option(
        mut self,
        colors: Option<TerminalDefaultColors>,
    ) -> Result<Self, RuntimeContractError> {
        if let Some(colors) = colors {
            colors
                .validate()
                .map_err(|error| RuntimeContractError::new(error.to_string()))?;
        }
        self.terminal_default_colors = colors;
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn session_name(&self) -> &str {
        &self.session_name
    }

    #[must_use]
    pub fn provider_cwd(&self) -> &Path {
        &self.provider_cwd
    }

    #[must_use]
    pub fn command(&self) -> &[String] {
        &self.command
    }

    #[must_use]
    pub fn initial_rows(&self) -> u16 {
        self.initial_rows
    }

    #[must_use]
    pub fn initial_columns(&self) -> u16 {
        self.initial_columns
    }

    #[must_use]
    pub fn terminal_environment(&self) -> &TerminalEnvironment {
        &self.terminal_environment
    }

    #[must_use]
    pub fn resurrection_replay_policy(&self) -> StandaloneResurrectionReplayPolicy {
        effective_resurrection_replay_policy(&self.command, self.resurrection_replay_policy)
    }

    #[must_use]
    pub fn retirement_policy(&self) -> Option<SessionRetirementPolicy> {
        self.retirement_policy
    }

    #[must_use]
    pub fn terminal_default_colors(&self) -> Option<TerminalDefaultColors> {
        self.terminal_default_colors
    }

    #[must_use]
    pub fn requires_operator_confirmation(&self) -> bool {
        self.resurrection_replay_policy()
            == StandaloneResurrectionReplayPolicy::ConfirmExplicitCommand
    }

    #[must_use]
    pub fn created_unix_ms(&self) -> u64 {
        self.created_unix_ms
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        StandaloneCreateRequest::new(
            self.provider_cwd.clone(),
            Some(self.session_name.clone()),
            self.command.clone(),
            self.initial_rows,
            self.initial_columns,
        )?
        .with_terminal_environment(self.terminal_environment.clone())?
        .with_terminal_default_colors_option(self.terminal_default_colors)?;
        validate_resurrection_replay_policy(&self.command, self.resurrection_replay_policy)?;
        let policy_valid = self
            .retirement_policy
            .is_none_or(SessionRetirementPolicy::is_valid);
        let schema_valid = match (self.terminal_default_colors, self.retirement_policy) {
            (Some(_), _) => {
                self.schema == RESURRECTION_SCHEMA_V3
                    && self.schema_version == RESURRECTION_SCHEMA_VERSION_V3
            }
            (None, None) => {
                self.schema == RESURRECTION_SCHEMA_V1
                    && self.schema_version == RESURRECTION_SCHEMA_VERSION_V1
            }
            (None, Some(_)) => {
                self.schema == RESURRECTION_SCHEMA_V2
                    && self.schema_version == RESURRECTION_SCHEMA_VERSION_V2
            }
        };
        if !policy_valid || !schema_valid || self.created_unix_ms == 0 {
            return Err(RuntimeContractError::new(
                "standalone resurrection recipe is invalid",
            ));
        }
        Ok(())
    }

    fn refresh_schema(&mut self) {
        let (schema, version) = if self.terminal_default_colors.is_some() {
            (RESURRECTION_SCHEMA_V3, RESURRECTION_SCHEMA_VERSION_V3)
        } else if self.retirement_policy.is_some() {
            (RESURRECTION_SCHEMA_V2, RESURRECTION_SCHEMA_VERSION_V2)
        } else {
            (RESURRECTION_SCHEMA_V1, RESURRECTION_SCHEMA_VERSION_V1)
        };
        self.schema = schema.to_string();
        self.schema_version = version;
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeContractError {
    message: String,
}

impl RuntimeContractError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for RuntimeContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RuntimeContractError {}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneRecoveryCreateIdentity {
    target_session_id: String,
    launch_owner_proof: String,
    #[serde(
        default,
        skip_serializing_if = "StandaloneRecipeRequirement::requires_existing"
    )]
    recipe_requirement: StandaloneRecipeRequirement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_predecessor: Option<PresentationCheckpointPredecessor>,
}

/// Whether a deterministic standalone identity may establish its canonical
/// resurrection recipe, must recover one that is already durable, or delegates
/// replay to the exact request authority that submitted the launch.
///
/// The compatibility default is deliberately fail-closed: every pre-existing
/// recovery request still requires an existing recipe. A creation gateway must
/// opt in to `InitializeIfAbsent` for the first request and can then retry the
/// exact same identity after response loss, or use `RequestBound` when its own
/// exact request store is the only replay authority.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StandaloneRecipeRequirement {
    #[default]
    Existing,
    InitializeIfAbsent,
    /// The exact caller-owned request is the sole replay authority. The
    /// runtime must not read or publish a general resurrection recipe.
    RequestBound,
}

impl StandaloneRecipeRequirement {
    fn requires_existing(&self) -> bool {
        *self == Self::Existing
    }
}

impl fmt::Debug for StandaloneRecoveryCreateIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StandaloneRecoveryCreateIdentity")
            .field("target_session_id", &self.target_session_id)
            .field("launch_owner_proof", &"<redacted>")
            .field("recipe_requirement", &self.recipe_requirement)
            .field(
                "source_predecessor",
                &self.source_predecessor.as_ref().map(|_| "<exact fence>"),
            )
            .finish()
    }
}

impl StandaloneRecoveryCreateIdentity {
    pub fn new(
        target_session_id: impl Into<String>,
        launch_owner_proof: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let identity = Self {
            target_session_id: target_session_id.into(),
            launch_owner_proof: launch_owner_proof.into(),
            recipe_requirement: StandaloneRecipeRequirement::Existing,
            source_predecessor: None,
        };
        identity.validate()?;
        Ok(identity)
    }

    #[must_use]
    pub fn target_session_id(&self) -> &str {
        &self.target_session_id
    }

    #[must_use]
    pub fn launch_owner_proof(&self) -> &str {
        &self.launch_owner_proof
    }

    #[must_use]
    pub fn with_recipe_requirement(
        mut self,
        recipe_requirement: StandaloneRecipeRequirement,
    ) -> Self {
        self.recipe_requirement = recipe_requirement;
        self
    }

    #[must_use]
    pub fn recipe_requirement(&self) -> StandaloneRecipeRequirement {
        self.recipe_requirement
    }

    pub fn with_source_predecessor(
        mut self,
        predecessor: PresentationCheckpointPredecessor,
    ) -> Result<Self, RuntimeContractError> {
        predecessor.validate()?;
        self.source_predecessor = Some(predecessor);
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn source_predecessor(&self) -> Option<&PresentationCheckpointPredecessor> {
        self.source_predecessor.as_ref()
    }

    fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_opaque_identity(
            &self.target_session_id,
            "standalone recovery target session id",
        )?;
        validate_opaque_identity(
            &self.launch_owner_proof,
            "standalone recovery launch owner proof",
        )?;
        if !self.target_session_id.starts_with("standalone_") {
            return Err(RuntimeContractError::new(
                "standalone recovery target session id is invalid",
            ));
        }
        if let Some(predecessor) = &self.source_predecessor {
            predecessor.validate()?;
            if predecessor.session_id() == self.target_session_id {
                return Err(RuntimeContractError::new(
                    "standalone recovery source must differ from its target",
                ));
            }
        }
        Ok(())
    }
}

fn effective_resurrection_replay_policy(
    command: &[String],
    configured: Option<StandaloneResurrectionReplayPolicy>,
) -> StandaloneResurrectionReplayPolicy {
    configured.unwrap_or({
        if command.is_empty() {
            StandaloneResurrectionReplayPolicy::SafeInteractiveShell
        } else {
            StandaloneResurrectionReplayPolicy::ConfirmExplicitCommand
        }
    })
}

fn validate_resurrection_replay_policy(
    command: &[String],
    configured: Option<StandaloneResurrectionReplayPolicy>,
) -> Result<(), RuntimeContractError> {
    match configured {
        Some(StandaloneResurrectionReplayPolicy::SafeInteractiveShell)
            if !command.is_empty()
                && (command.len() != 1 || !Path::new(&command[0]).is_absolute()) =>
        {
            Err(RuntimeContractError::new(
                "safe interactive shell replay requires one absolute executable path",
            ))
        }
        Some(StandaloneResurrectionReplayPolicy::ConfirmExplicitCommand) if command.is_empty() => {
            Err(RuntimeContractError::new(
                "explicit command replay policy requires a command",
            ))
        }
        _ => Ok(()),
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneCreateReceipt {
    schema: String,
    schema_version: u16,
    session_id: String,
    workspace_id: String,
    session_name: String,
    discovery_root: PathBuf,
    launch_owner_proof: String,
}

impl StandaloneCreateReceipt {
    pub fn new(
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
        session_name: impl Into<String>,
        discovery_root: impl Into<PathBuf>,
        launch_owner_proof: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let receipt = Self {
            schema: BROKER_SCHEMA_V1.to_string(),
            schema_version: BROKER_SCHEMA_VERSION_V1,
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
            session_name: session_name.into(),
            discovery_root: discovery_root.into(),
            launch_owner_proof: launch_owner_proof.into(),
        };
        receipt.validate()?;
        Ok(receipt)
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn session_name(&self) -> &str {
        &self.session_name
    }

    #[must_use]
    pub fn discovery_root(&self) -> &Path {
        &self.discovery_root
    }

    #[must_use]
    pub fn launch_owner_proof(&self) -> &str {
        &self.launch_owner_proof
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != BROKER_SCHEMA_V1 || self.schema_version != BROKER_SCHEMA_VERSION_V1 {
            return Err(RuntimeContractError::new(
                "standalone create receipt has an unsupported schema",
            ));
        }
        if self.session_id.is_empty()
            || self.workspace_id.is_empty()
            || self.session_name.is_empty()
            || self.discovery_root.as_os_str().is_empty()
            || self.launch_owner_proof.is_empty()
        {
            return Err(RuntimeContractError::new(
                "standalone create receipt is missing required identity",
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for StandaloneCreateReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StandaloneCreateReceipt")
            .field("schema", &self.schema)
            .field("schema_version", &self.schema_version)
            .field("session_id", &self.session_id)
            .field("workspace_id", &self.workspace_id)
            .field("session_name", &self.session_name)
            .field("discovery_root", &self.discovery_root)
            .field("launch_owner_proof", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneCreateFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum StandaloneCreateBrokerResponse {
    Created(StandaloneCreateReceipt),
    Refused(StandaloneCreateFailure),
}

impl StandaloneCreateBrokerResponse {
    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(StandaloneCreateFailure {
            code: code.into(),
            message: message.into(),
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Default,
    BypassApprovals,
}

/// Exact predecessor identity whose private presentation checkpoint may seed a
/// replacement terminal. This carries no terminal bytes and grants no attach
/// or mutation authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationCheckpointPredecessor {
    session_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: u64,
    host_instance_id: String,
    terminal_epoch: String,
}

impl PresentationCheckpointPredecessor {
    pub fn new(
        session_id: impl Into<String>,
        runner_principal: impl Into<String>,
        runner_instance: impl Into<String>,
        channel_epoch: u64,
        host_instance_id: impl Into<String>,
        terminal_epoch: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let predecessor = Self {
            session_id: session_id.into(),
            runner_principal: runner_principal.into(),
            runner_instance: runner_instance.into(),
            channel_epoch,
            host_instance_id: host_instance_id.into(),
            terminal_epoch: terminal_epoch.into(),
        };
        predecessor.validate()?;
        Ok(predecessor)
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_identifier(&self.session_id, "presentation predecessor session id")?;
        validate_identifier(
            &self.runner_principal,
            "presentation predecessor runner principal",
        )?;
        validate_identifier(
            &self.runner_instance,
            "presentation predecessor runner instance",
        )?;
        validate_identifier(
            &self.host_instance_id,
            "presentation predecessor host instance id",
        )?;
        validate_identifier(
            &self.terminal_epoch,
            "presentation predecessor terminal epoch",
        )?;
        if self.channel_epoch == 0 {
            return Err(RuntimeContractError::new(
                "presentation predecessor channel epoch must be non-zero",
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn runner_principal(&self) -> &str {
        &self.runner_principal
    }

    #[must_use]
    pub fn runner_instance(&self) -> &str {
        &self.runner_instance
    }

    #[must_use]
    pub fn channel_epoch(&self) -> u64 {
        self.channel_epoch
    }

    #[must_use]
    pub fn host_instance_id(&self) -> &str {
        &self.host_instance_id
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConversationIdentitySeed {
    provider_id: String,
    conversation_id: String,
}

impl ProviderConversationIdentitySeed {
    pub fn new(
        provider_id: impl Into<String>,
        conversation_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let seed = Self {
            provider_id: provider_id.into(),
            conversation_id: conversation_id.into(),
        };
        seed.validate()?;
        Ok(seed)
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_opaque_identity(&self.provider_id, "conversation identity provider id")?;
        validate_opaque_identity(
            &self.conversation_id,
            "conversation identity opaque identifier",
        )
    }
}

/// Owner-only, provider-neutral recipe for replacing one managed provider
/// with the exact Host-observed conversation. Product adapters own the
/// provider grammar and persist a fully reviewed argv template at create time;
/// Hmux substitutes the opaque identity into the single bounded placeholder.
/// No credential material is permitted here. `launch_reference` is an opaque,
/// non-secret equality coordinate such as a Dure credential profile id.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostRecipe {
    schema: String,
    schema_version: u16,
    command_template: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_reference: Option<String>,
}

impl ManagedRehostRecipe {
    pub fn new(
        command_template: Vec<String>,
        launch_reference: Option<String>,
    ) -> Result<Self, RuntimeContractError> {
        let recipe = Self {
            schema: MANAGED_REHOST_RECIPE_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_RECIPE_SCHEMA_VERSION,
            command_template,
            launch_reference,
        };
        recipe.validate()?;
        Ok(recipe)
    }

    #[must_use]
    pub fn command_template(&self) -> &[String] {
        &self.command_template
    }

    #[must_use]
    pub fn launch_reference(&self) -> Option<&str> {
        self.launch_reference.as_deref()
    }

    pub fn render_command(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<String>, RuntimeContractError> {
        self.validate()?;
        validate_opaque_identity(conversation_id, "managed rehost conversation id")?;
        Ok(self
            .command_template
            .iter()
            .map(|argument| {
                argument.replace(
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
                    conversation_id,
                )
            })
            .collect())
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_REHOST_RECIPE_SCHEMA
            || self.schema_version != MANAGED_REHOST_RECIPE_SCHEMA_VERSION
        {
            return Err(RuntimeContractError::new(
                "managed rehost recipe has an unsupported schema",
            ));
        }
        validate_command(&self.command_template, "managed rehost recipe")?;
        let placeholder_count = self
            .command_template
            .iter()
            .map(|argument| {
                argument
                    .match_indices(MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER)
                    .count()
            })
            .sum::<usize>();
        if placeholder_count != 1 {
            return Err(RuntimeContractError::new(
                "managed rehost recipe must contain exactly one conversation placeholder",
            ));
        }
        if let Some(reference) = self.launch_reference.as_deref() {
            validate_opaque_identity(reference, "managed rehost launch reference")?;
        }
        Ok(())
    }
}

/// Owner-only, non-secret launch authority captured when a managed session is
/// created. The original provider command is intentionally absent: it may
/// contain arbitrary caller input and is not needed to resume one exact
/// provider conversation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostSourceRecipe {
    schema: String,
    schema_version: u16,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    permission_mode: PermissionMode,
    provider_cwd: PathBuf,
    initial_rows: u16,
    initial_columns: u16,
    terminal_environment: TerminalEnvironment,
    provider_state_environment: ProviderStateEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_default_colors: Option<TerminalDefaultColors>,
    required_managed_stop_request_version: u16,
    rehost: ManagedRehostRecipe,
}

impl ManagedRehostSourceRecipe {
    pub fn from_create_request(
        request: &ManagedCreateRequest,
    ) -> Result<Option<Self>, RuntimeContractError> {
        request.validate()?;
        let Some(rehost) = request.managed_rehost_recipe.clone() else {
            return Ok(None);
        };
        let recipe = Self {
            schema: if !request.provider_state_environment.removals().is_empty() {
                MANAGED_REHOST_SOURCE_RECIPE_PROVIDER_STATE_REMOVAL_SCHEMA.to_string()
            } else if request.terminal_default_colors.is_some() {
                MANAGED_REHOST_SOURCE_RECIPE_TERMINAL_DEFAULT_COLORS_SCHEMA.to_string()
            } else {
                MANAGED_REHOST_SOURCE_RECIPE_SCHEMA.to_string()
            },
            schema_version: if !request.provider_state_environment.removals().is_empty() {
                MANAGED_REHOST_SOURCE_RECIPE_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION
            } else if request.terminal_default_colors.is_some() {
                MANAGED_REHOST_SOURCE_RECIPE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION
            } else {
                MANAGED_REHOST_SOURCE_RECIPE_SCHEMA_VERSION
            },
            session_id: request.session_id.clone(),
            workspace_id: request.workspace_id.clone(),
            provider_id: request.provider_id.clone(),
            permission_mode: request.permission_mode,
            provider_cwd: request.provider_cwd.clone(),
            initial_rows: request.initial_rows,
            initial_columns: request.initial_columns,
            terminal_environment: request.terminal_environment.clone(),
            provider_state_environment: request.provider_state_environment.clone(),
            terminal_default_colors: request.terminal_default_colors,
            required_managed_stop_request_version: request
                .required_managed_stop_request_version
                .ok_or_else(|| {
                    RuntimeContractError::new(
                        "managed rehost source recipe requires complete stop authority",
                    )
                })?,
            rehost,
        };
        recipe.validate()?;
        Ok(Some(recipe))
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn permission_mode(&self) -> PermissionMode {
        self.permission_mode
    }

    #[must_use]
    pub fn provider_cwd(&self) -> &Path {
        &self.provider_cwd
    }

    #[must_use]
    pub fn initial_rows(&self) -> u16 {
        self.initial_rows
    }

    #[must_use]
    pub fn initial_columns(&self) -> u16 {
        self.initial_columns
    }

    #[must_use]
    pub fn terminal_environment(&self) -> &TerminalEnvironment {
        &self.terminal_environment
    }

    #[must_use]
    pub fn provider_state_environment(&self) -> &ProviderStateEnvironment {
        &self.provider_state_environment
    }

    #[must_use]
    pub fn terminal_default_colors(&self) -> Option<TerminalDefaultColors> {
        self.terminal_default_colors
    }

    #[must_use]
    pub fn required_managed_stop_request_version(&self) -> u16 {
        self.required_managed_stop_request_version
    }

    #[must_use]
    pub fn rehost(&self) -> &ManagedRehostRecipe {
        &self.rehost
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let has_removals = !self.provider_state_environment.removals().is_empty();
        let schema_valid = if has_removals {
            self.schema == MANAGED_REHOST_SOURCE_RECIPE_PROVIDER_STATE_REMOVAL_SCHEMA
                && self.schema_version
                    == MANAGED_REHOST_SOURCE_RECIPE_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION
        } else if self.terminal_default_colors.is_some() {
            self.schema == MANAGED_REHOST_SOURCE_RECIPE_TERMINAL_DEFAULT_COLORS_SCHEMA
                && self.schema_version
                    == MANAGED_REHOST_SOURCE_RECIPE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION
        } else {
            self.schema == MANAGED_REHOST_SOURCE_RECIPE_SCHEMA
                && self.schema_version == MANAGED_REHOST_SOURCE_RECIPE_SCHEMA_VERSION
        };
        if !schema_valid {
            return Err(RuntimeContractError::new(
                "managed rehost source recipe has an unsupported schema",
            ));
        }
        validate_identifier(&self.session_id, "managed rehost source session id")?;
        validate_identifier(&self.workspace_id, "managed rehost source workspace id")?;
        validate_identifier(&self.provider_id, "managed rehost source provider id")?;
        if !self.provider_cwd.is_absolute() {
            return Err(RuntimeContractError::new(
                "managed rehost source provider cwd must be absolute",
            ));
        }
        if self.initial_rows == 0 || self.initial_columns == 0 {
            return Err(RuntimeContractError::new(
                "managed rehost source terminal dimensions must be non-zero",
            ));
        }
        self.terminal_environment.validate()?;
        self.provider_state_environment.validate()?;
        if let Some(colors) = self.terminal_default_colors {
            colors
                .validate()
                .map_err(|error| RuntimeContractError::new(error.to_string()))?;
        }
        if managed_stop_requirement_capability(self.required_managed_stop_request_version).is_none()
        {
            return Err(RuntimeContractError::new(
                "managed rehost source recipe requires supported stop authority",
            ));
        }
        self.rehost.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCreateRequest {
    schema: String,
    schema_version: u16,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    permission_mode: PermissionMode,
    provider_cwd: PathBuf,
    command: Vec<String>,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default, skip_serializing_if = "TerminalEnvironment::is_empty")]
    terminal_environment: TerminalEnvironment,
    #[serde(default, skip_serializing_if = "ProviderStateEnvironment::is_empty")]
    provider_state_environment: ProviderStateEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    presentation_predecessor: Option<PresentationCheckpointPredecessor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_identity: Option<ProviderConversationIdentitySeed>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    required_managed_stop_request_version: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_rehost_recipe: Option<ManagedRehostRecipe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_default_colors: Option<TerminalDefaultColors>,
}

impl ManagedCreateRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        idempotency_key: impl Into<String>,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
        provider_id: impl Into<String>,
        permission_mode: PermissionMode,
        provider_cwd: impl Into<PathBuf>,
        command: Vec<String>,
        initial_rows: u16,
        initial_columns: u16,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_CREATE_SCHEMA.to_string(),
            schema_version: MANAGED_CREATE_SCHEMA_VERSION,
            idempotency_key: idempotency_key.into(),
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
            provider_id: provider_id.into(),
            permission_mode,
            provider_cwd: provider_cwd.into(),
            command,
            initial_rows,
            initial_columns,
            terminal_environment: TerminalEnvironment::default(),
            provider_state_environment: ProviderStateEnvironment::default(),
            presentation_predecessor: None,
            conversation_identity: None,
            required_managed_stop_request_version: None,
            managed_rehost_recipe: None,
            terminal_default_colors: None,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn with_terminal_environment(
        mut self,
        terminal_environment: TerminalEnvironment,
    ) -> Result<Self, RuntimeContractError> {
        terminal_environment.validate()?;
        self.terminal_environment = terminal_environment;
        self.validate()?;
        Ok(self)
    }

    pub fn with_provider_state_environment(
        mut self,
        provider_state_environment: ProviderStateEnvironment,
    ) -> Result<Self, RuntimeContractError> {
        provider_state_environment.validate()?;
        if provider_state_environment.is_empty() {
            return Err(RuntimeContractError::new(
                "provider state environment must not be empty",
            ));
        }
        self.provider_state_environment = provider_state_environment;
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    pub fn with_required_managed_stop_request_version(
        mut self,
        version: u16,
    ) -> Result<Self, RuntimeContractError> {
        self.required_managed_stop_request_version = Some(version);
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    pub fn with_presentation_predecessor(
        mut self,
        predecessor: PresentationCheckpointPredecessor,
    ) -> Result<Self, RuntimeContractError> {
        predecessor.validate()?;
        if predecessor.session_id == self.session_id {
            return Err(RuntimeContractError::new(
                "presentation predecessor must be a different session",
            ));
        }
        self.presentation_predecessor = Some(predecessor);
        self.validate()?;
        Ok(self)
    }

    pub fn with_conversation_identity(
        mut self,
        seed: ProviderConversationIdentitySeed,
    ) -> Result<Self, RuntimeContractError> {
        seed.validate()?;
        if seed.provider_id != self.provider_id {
            return Err(RuntimeContractError::new(
                "conversation identity provider must match managed create provider",
            ));
        }
        self.conversation_identity = Some(seed);
        self.validate()?;
        Ok(self)
    }

    pub fn with_managed_rehost_recipe(
        mut self,
        recipe: ManagedRehostRecipe,
    ) -> Result<Self, RuntimeContractError> {
        recipe.validate()?;
        self.managed_rehost_recipe = Some(recipe);
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    pub fn with_terminal_default_colors(
        self,
        colors: TerminalDefaultColors,
    ) -> Result<Self, RuntimeContractError> {
        self.with_terminal_default_colors_option(Some(colors))
    }

    pub fn with_terminal_default_colors_option(
        mut self,
        colors: Option<TerminalDefaultColors>,
    ) -> Result<Self, RuntimeContractError> {
        if let Some(colors) = colors {
            colors
                .validate()
                .map_err(|error| RuntimeContractError::new(error.to_string()))?;
        }
        self.terminal_default_colors = colors;
        self.refresh_schema();
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn permission_mode(&self) -> PermissionMode {
        self.permission_mode
    }

    #[must_use]
    pub fn provider_cwd(&self) -> &Path {
        &self.provider_cwd
    }

    #[must_use]
    pub fn command(&self) -> &[String] {
        &self.command
    }

    #[must_use]
    pub fn initial_rows(&self) -> u16 {
        self.initial_rows
    }

    #[must_use]
    pub fn initial_columns(&self) -> u16 {
        self.initial_columns
    }

    #[must_use]
    pub fn terminal_environment(&self) -> &TerminalEnvironment {
        &self.terminal_environment
    }

    #[must_use]
    pub fn provider_state_environment(&self) -> &ProviderStateEnvironment {
        &self.provider_state_environment
    }

    #[must_use]
    pub fn presentation_predecessor(&self) -> Option<&PresentationCheckpointPredecessor> {
        self.presentation_predecessor.as_ref()
    }

    #[must_use]
    pub fn conversation_identity(&self) -> Option<&ProviderConversationIdentitySeed> {
        self.conversation_identity.as_ref()
    }

    #[must_use]
    pub fn required_managed_stop_request_version(&self) -> Option<u16> {
        self.required_managed_stop_request_version
    }

    #[must_use]
    pub fn managed_rehost_recipe(&self) -> Option<&ManagedRehostRecipe> {
        self.managed_rehost_recipe.as_ref()
    }

    #[must_use]
    pub fn terminal_default_colors(&self) -> Option<TerminalDefaultColors> {
        self.terminal_default_colors
    }

    /// Rebinds only the logical create identity. Every launch, provider,
    /// credential-selection, lifecycle, and presentation field remains byte
    /// equivalent in the serialized request.
    pub fn retarget_identity(
        &self,
        idempotency_key: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let mut request = self.clone();
        request.idempotency_key = idempotency_key.into();
        request.session_id = session_id.into();
        request.validate()?;
        Ok(request)
    }

    /// Canonical logical-create identity. Recovery authority and presentation
    /// defaults are bound separately, so neither invalidates an exact retry.
    pub fn canonical_create_identity_json(&self) -> Result<String, RuntimeContractError> {
        self.validate()?;
        let mut identity = self.clone();
        identity.managed_rehost_recipe = None;
        identity.terminal_default_colors = None;
        identity.refresh_schema();
        identity.validate()?;
        serde_json::to_string(&identity)
            .map_err(|_| RuntimeContractError::new("managed create identity is not serializable"))
    }

    #[must_use]
    pub fn requires_managed_stop_lifecycle_contract(&self) -> bool {
        self.required_managed_stop_request_version
            .is_some_and(|version| managed_create_stop_requirement_capability(version).is_some())
    }

    /// Host capability that must be present on the created generation before
    /// the broker can publish a successful receipt for this lifecycle contract.
    #[must_use]
    pub fn required_managed_stop_host_capability(&self) -> Option<&'static str> {
        self.required_managed_stop_request_version
            .and_then(managed_create_stop_requirement_capability)
    }

    /// Complete Host contract required before the provider can be launched and
    /// again before a successful receipt can be published.
    pub fn required_host_capabilities(&self) -> impl Iterator<Item = &'static str> {
        [
            self.required_managed_stop_host_capability(),
            (!self.provider_state_environment.values().is_empty())
                .then_some(PROVIDER_STATE_ENVIRONMENT_CAPABILITY),
            (!self.provider_state_environment.removals().is_empty())
                .then_some(PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY),
        ]
        .into_iter()
        .flatten()
    }

    fn refresh_schema(&mut self) {
        if !self.provider_state_environment.removals().is_empty() {
            self.schema = MANAGED_CREATE_PROVIDER_STATE_REMOVAL_SCHEMA.to_string();
            self.schema_version = MANAGED_CREATE_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION;
        } else if self.terminal_default_colors.is_some() {
            self.schema = MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA.to_string();
            self.schema_version = MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION;
        } else if self.managed_rehost_recipe.is_some() {
            self.schema = MANAGED_CREATE_REHOST_RECIPE_SCHEMA.to_string();
            self.schema_version = MANAGED_CREATE_REHOST_RECIPE_SCHEMA_VERSION;
        } else if self.required_managed_stop_request_version.is_some() {
            self.schema = MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA.to_string();
            self.schema_version = MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA_VERSION;
        } else if self.provider_state_environment.is_empty() {
            self.schema = MANAGED_CREATE_SCHEMA.to_string();
            self.schema_version = MANAGED_CREATE_SCHEMA_VERSION;
        } else {
            self.schema = MANAGED_CREATE_PROVIDER_STATE_SCHEMA.to_string();
            self.schema_version = MANAGED_CREATE_PROVIDER_STATE_SCHEMA_VERSION;
        }
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let has_removals = !self.provider_state_environment.removals().is_empty();
        let legacy_schema = self.schema == MANAGED_CREATE_SCHEMA
            && self.schema_version == MANAGED_CREATE_SCHEMA_VERSION
            && self.provider_state_environment.is_empty()
            && self.required_managed_stop_request_version.is_none()
            && self.managed_rehost_recipe.is_none();
        let provider_state_schema = self.schema == MANAGED_CREATE_PROVIDER_STATE_SCHEMA
            && self.schema_version == MANAGED_CREATE_PROVIDER_STATE_SCHEMA_VERSION
            && !self.provider_state_environment.is_empty()
            && !has_removals
            && self.required_managed_stop_request_version.is_none()
            && self.managed_rehost_recipe.is_none();
        let lifecycle_requirements_schema = self.schema
            == MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA
            && self.schema_version == MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA_VERSION
            && !has_removals
            && self
                .required_managed_stop_request_version
                .is_some_and(|version| {
                    managed_create_stop_requirement_capability(version).is_some()
                })
            && self.managed_rehost_recipe.is_none();
        let rehost_recipe_schema = self.schema == MANAGED_CREATE_REHOST_RECIPE_SCHEMA
            && self.schema_version == MANAGED_CREATE_REHOST_RECIPE_SCHEMA_VERSION
            && !has_removals
            && self.managed_rehost_recipe.is_some()
            && self
                .required_managed_stop_request_version
                .is_some_and(|version| {
                    managed_create_stop_requirement_capability(version).is_some()
                });
        let terminal_default_colors_schema = self.schema
            == MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA
            && self.schema_version == MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION
            && !has_removals
            && self.terminal_default_colors.is_some()
            && self
                .required_managed_stop_request_version
                .is_none_or(|version| {
                    managed_create_stop_requirement_capability(version).is_some()
                })
            && (self.managed_rehost_recipe.is_none()
                || self.required_managed_stop_request_version.is_some());
        let provider_state_removal_schema = self.schema
            == MANAGED_CREATE_PROVIDER_STATE_REMOVAL_SCHEMA
            && self.schema_version == MANAGED_CREATE_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION
            && has_removals
            && self
                .required_managed_stop_request_version
                .is_none_or(|version| {
                    managed_create_stop_requirement_capability(version).is_some()
                })
            && (self.managed_rehost_recipe.is_none()
                || self.required_managed_stop_request_version.is_some());
        let previous_schema = legacy_schema
            || provider_state_schema
            || lifecycle_requirements_schema
            || rehost_recipe_schema;
        if !provider_state_removal_schema
            && !terminal_default_colors_schema
            && (self.terminal_default_colors.is_some() || !previous_schema)
        {
            return Err(RuntimeContractError::new(
                "managed create request has an unsupported schema",
            ));
        }
        validate_identifier(&self.idempotency_key, "managed create idempotency key")?;
        validate_identifier(&self.session_id, "managed create session id")?;
        validate_identifier(&self.workspace_id, "managed create workspace id")?;
        validate_identifier(&self.provider_id, "managed create provider id")?;
        if !self.provider_cwd.is_absolute() {
            return Err(RuntimeContractError::new(
                "managed create provider cwd must be absolute",
            ));
        }
        if self.initial_rows == 0 || self.initial_columns == 0 {
            return Err(RuntimeContractError::new(
                "managed create terminal dimensions must be non-zero",
            ));
        }
        validate_command(&self.command, "managed create")?;
        self.terminal_environment.validate()?;
        self.provider_state_environment.validate()?;
        if let Some(predecessor) = &self.presentation_predecessor {
            predecessor.validate()?;
            if predecessor.session_id == self.session_id {
                return Err(RuntimeContractError::new(
                    "presentation predecessor must be a different session",
                ));
            }
        }
        if let Some(seed) = &self.conversation_identity {
            seed.validate()?;
            if seed.provider_id != self.provider_id {
                return Err(RuntimeContractError::new(
                    "conversation identity provider must match managed create provider",
                ));
            }
        }
        if let Some(recipe) = &self.managed_rehost_recipe {
            recipe.validate()?;
        }
        if let Some(colors) = self.terminal_default_colors {
            colors
                .validate()
                .map_err(|error| RuntimeContractError::new(error.to_string()))?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedCreateOutcome {
    Created,
    Reused,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCreateGenerationFence {
    runner_principal: String,
    runner_instance: String,
    channel_epoch: u64,
    host_instance_id: String,
    terminal_epoch: String,
}

impl ManagedCreateGenerationFence {
    pub fn new(
        runner_principal: impl Into<String>,
        runner_instance: impl Into<String>,
        channel_epoch: u64,
        host_instance_id: impl Into<String>,
        terminal_epoch: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let fence = Self {
            runner_principal: runner_principal.into(),
            runner_instance: runner_instance.into(),
            channel_epoch,
            host_instance_id: host_instance_id.into(),
            terminal_epoch: terminal_epoch.into(),
        };
        fence.validate()?;
        Ok(fence)
    }

    #[must_use]
    pub fn runner_principal(&self) -> &str {
        &self.runner_principal
    }

    #[must_use]
    pub fn runner_instance(&self) -> &str {
        &self.runner_instance
    }

    #[must_use]
    pub fn channel_epoch(&self) -> u64 {
        self.channel_epoch
    }

    #[must_use]
    pub fn host_instance_id(&self) -> &str {
        &self.host_instance_id
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn matches_generation(
        &self,
        runner_principal: &str,
        runner_instance: &str,
        channel_epoch: &str,
        host_instance_id: &str,
        terminal_epoch: &str,
    ) -> bool {
        self.runner_principal == runner_principal
            && self.runner_instance == runner_instance
            && self.channel_epoch.to_string() == channel_epoch
            && self.host_instance_id == host_instance_id
            && self.terminal_epoch == terminal_epoch
    }

    fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_identifier(&self.runner_principal, "managed create runner principal")?;
        validate_identifier(&self.runner_instance, "managed create runner instance")?;
        if self.channel_epoch == 0 {
            return Err(RuntimeContractError::new(
                "managed create channel epoch must be non-zero",
            ));
        }
        validate_identifier(&self.host_instance_id, "managed create Host instance id")?;
        validate_identifier(&self.terminal_epoch, "managed create terminal epoch")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCreateReceipt {
    schema: String,
    schema_version: u16,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    permission_mode: PermissionMode,
    discovery_root: PathBuf,
    outcome: ManagedCreateOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation_fence: Option<ManagedCreateGenerationFence>,
}

impl ManagedCreateReceipt {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        idempotency_key: impl Into<String>,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
        provider_id: impl Into<String>,
        permission_mode: PermissionMode,
        discovery_root: impl Into<PathBuf>,
        outcome: ManagedCreateOutcome,
    ) -> Result<Self, RuntimeContractError> {
        let receipt = Self {
            schema: MANAGED_CREATE_SCHEMA.to_string(),
            schema_version: MANAGED_CREATE_SCHEMA_VERSION,
            idempotency_key: idempotency_key.into(),
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
            provider_id: provider_id.into(),
            permission_mode,
            discovery_root: discovery_root.into(),
            outcome,
            generation_fence: None,
        };
        receipt.validate()?;
        Ok(receipt)
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn permission_mode(&self) -> PermissionMode {
        self.permission_mode
    }

    #[must_use]
    pub fn discovery_root(&self) -> &Path {
        &self.discovery_root
    }

    #[must_use]
    pub fn outcome(&self) -> ManagedCreateOutcome {
        self.outcome
    }

    pub fn with_generation_fence(
        mut self,
        generation_fence: ManagedCreateGenerationFence,
    ) -> Result<Self, RuntimeContractError> {
        generation_fence.validate()?;
        self.generation_fence = Some(generation_fence);
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn generation_fence(&self) -> Option<&ManagedCreateGenerationFence> {
        self.generation_fence.as_ref()
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_CREATE_SCHEMA
            || self.schema_version != MANAGED_CREATE_SCHEMA_VERSION
        {
            return Err(RuntimeContractError::new(
                "managed create receipt has an unsupported schema",
            ));
        }
        validate_identifier(&self.idempotency_key, "managed create idempotency key")?;
        validate_identifier(&self.session_id, "managed create session id")?;
        validate_identifier(&self.workspace_id, "managed create workspace id")?;
        validate_identifier(&self.provider_id, "managed create provider id")?;
        if !self.discovery_root.is_absolute() {
            return Err(RuntimeContractError::new(
                "managed create discovery root must be absolute",
            ));
        }
        if let Some(fence) = &self.generation_fence {
            fence.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCreateFailure {
    #[serde(default)]
    pub disposition: ManagedCreateFailureDisposition,
    pub code: String,
    pub message: String,
}

impl ManagedCreateFailure {
    /// Older runtimes did not serialize `disposition`. Their unknown failures
    /// stay retryable, while the bounded pre-admission codes retain the same
    /// permanent meaning as the typed protocol.
    #[must_use]
    pub fn effective_disposition(&self) -> ManagedCreateFailureDisposition {
        if self.disposition == ManagedCreateFailureDisposition::Rejected
            || matches!(
                self.code.as_str(),
                MANAGED_CREATE_REQUEST_INVALID_CODE
                    | MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE
                    | MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE
                    | MANAGED_CONVERSATION_WRITER_CONFLICT_CODE
                    | MANAGED_CREATE_RETIRED_EXACT_CODE
            )
        {
            ManagedCreateFailureDisposition::Rejected
        } else {
            ManagedCreateFailureDisposition::Retryable
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedCreateFailureDisposition {
    Rejected,
    /// Includes transport failures and admitted launches whose exact outcome
    /// must be reconciled by replaying the same idempotency key.
    #[default]
    Retryable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedCreateBrokerResponse {
    Completed(Box<ManagedCreateReceipt>),
    Refused(ManagedCreateFailure),
}

/// Identity-only lookup for a durable managed-create generation.
///
/// The request deliberately omits the create digest and all launch material.
/// Reconciliation can therefore report or terminalize only the generation
/// already owned by the runtime ledger; it cannot reinterpret that identity
/// using a newer caller policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedCreateReconcileRequest {
    schema: String,
    schema_version: u16,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
}

impl ManagedCreateReconcileRequest {
    pub fn new(
        idempotency_key: impl Into<String>,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_CREATE_RECONCILE_SCHEMA.to_string(),
            schema_version: MANAGED_CREATE_RECONCILE_SCHEMA_VERSION,
            idempotency_key: idempotency_key.into(),
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
        };
        request.validate()?;
        Ok(request)
    }

    #[must_use]
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_CREATE_RECONCILE_SCHEMA
            || self.schema_version != MANAGED_CREATE_RECONCILE_SCHEMA_VERSION
        {
            return Err(RuntimeContractError::new(
                "managed create reconcile request has an unsupported schema",
            ));
        }
        validate_identifier(
            &self.idempotency_key,
            "managed create reconcile idempotency key",
        )?;
        validate_identifier(&self.session_id, "managed create reconcile session id")?;
        validate_identifier(&self.workspace_id, "managed create reconcile workspace id")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCreateReconcileAuthorityUnavailable {
    pub code: String,
    pub message: String,
}

/// One complete projection of the permanent create-ledger state.
///
/// `AbandonedBeforeCompletion` is a terminal ledger tombstone, not permission
/// to reuse its logical session identity. A replacement always uses a fresh
/// session and idempotency key.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedCreateReconcileBrokerResponse {
    NotFound,
    Completed(Box<ManagedCreateReceipt>),
    Pending,
    AbandonedBeforeCompletion,
    Retired,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
}

impl ManagedCreateReconcileBrokerResponse {
    #[must_use]
    pub fn authority_unavailable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable {
            code: code.into(),
            message: message.into(),
        })
    }

    pub fn validate_against(
        &self,
        request: &ManagedCreateReconcileRequest,
    ) -> Result<(), RuntimeContractError> {
        if let Self::Completed(receipt) = self {
            receipt.validate()?;
            if receipt.idempotency_key() != request.idempotency_key()
                || receipt.session_id() != request.session_id()
                || receipt.workspace_id() != request.workspace_id()
            {
                return Err(RuntimeContractError::new(
                    "managed create reconcile receipt changed identity",
                ));
            }
        }
        Ok(())
    }
}

/// One bounded create/reconcile/terminal-advance operation.
///
/// The embedded request deliberately still names the source logical identity.
/// Only the runtime ledger may choose and persist a successor identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedCreateAdvanceRequest {
    schema: String,
    schema_version: u16,
    request: ManagedCreateRequest,
}

impl ManagedCreateAdvanceRequest {
    pub fn new(request: ManagedCreateRequest) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_CREATE_ADVANCE_SCHEMA.to_string(),
            schema_version: MANAGED_CREATE_ADVANCE_SCHEMA_VERSION,
            request,
        };
        request.validate()?;
        Ok(request)
    }

    /// Requires a deterministic replacement root even when the source's
    /// immutable create policy is unchanged. The runtime attempts that target
    /// before source lookup and uses the exact source only for fenced cleanup.
    pub fn replace_current(request: ManagedCreateRequest) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_CREATE_REPLACE_CURRENT_SCHEMA.to_string(),
            schema_version: MANAGED_CREATE_REPLACE_CURRENT_SCHEMA_VERSION,
            request,
        };
        request.validate()?;
        Ok(request)
    }

    #[must_use]
    pub fn request(&self) -> &ManagedCreateRequest {
        &self.request
    }

    #[must_use]
    pub fn into_request(self) -> ManagedCreateRequest {
        self.request
    }

    #[must_use]
    pub fn replaces_current(&self) -> bool {
        self.schema == MANAGED_CREATE_REPLACE_CURRENT_SCHEMA
            && self.schema_version == MANAGED_CREATE_REPLACE_CURRENT_SCHEMA_VERSION
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let advances = self.schema == MANAGED_CREATE_ADVANCE_SCHEMA
            && self.schema_version == MANAGED_CREATE_ADVANCE_SCHEMA_VERSION;
        let replaces = self.schema == MANAGED_CREATE_REPLACE_CURRENT_SCHEMA
            && self.schema_version == MANAGED_CREATE_REPLACE_CURRENT_SCHEMA_VERSION;
        if !advances && !replaces {
            return Err(RuntimeContractError::new(
                "managed create advance request has an unsupported schema",
            ));
        }
        self.request.validate()
    }
}

/// Result of one ledger-authoritative create/reconcile/advance composition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedCreateAdvanceBrokerResponse {
    Current(Box<ManagedCreateReceipt>),
    Advanced(Box<ManagedCreateReceipt>),
    Pending,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
    Refused(ManagedCreateFailure),
}

impl ManagedCreateAdvanceBrokerResponse {
    #[must_use]
    pub fn authority_unavailable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable {
            code: code.into(),
            message: message.into(),
        })
    }

    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Rejected,
            code: code.into(),
            message: message.into(),
        })
    }

    #[must_use]
    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Retryable,
            code: code.into(),
            message: message.into(),
        })
    }

    pub fn validate_against(
        &self,
        request: &ManagedCreateAdvanceRequest,
    ) -> Result<(), RuntimeContractError> {
        let source = request.request();
        match self {
            Self::Current(receipt) => {
                receipt.validate()?;
                if receipt.idempotency_key() != source.idempotency_key()
                    || receipt.session_id() != source.session_id()
                    || receipt.workspace_id() != source.workspace_id()
                    || receipt.provider_id() != source.provider_id()
                    || !request.replaces_current()
                        && receipt.permission_mode() != source.permission_mode()
                {
                    return Err(RuntimeContractError::new(
                        "managed create advance source receipt changed identity",
                    ));
                }
            }
            Self::Advanced(receipt) => {
                receipt.validate()?;
                if receipt.idempotency_key() == source.idempotency_key()
                    || receipt.session_id() == source.session_id()
                    || receipt.workspace_id() != source.workspace_id()
                    || receipt.provider_id() != source.provider_id()
                    || !request.replaces_current()
                        && receipt.permission_mode() != source.permission_mode()
                {
                    return Err(RuntimeContractError::new(
                        "managed create advance successor receipt changed identity",
                    ));
                }
            }
            Self::Pending | Self::AuthorityUnavailable(_) | Self::Refused(_) => {}
        }
        Ok(())
    }
}

/// Legacy durable result of closing one managed-create successor chain.
///
/// This v1 shape is frozen for clients that predate ordered lineage receipts.
/// `root` is the caller identity and `effective` is the selected tail.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedCreateChainStopReceipt {
    schema: String,
    schema_version: u16,
    root: ManagedCreateReconcileRequest,
    effective: ManagedCreateReconcileRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stop_receipt: Option<ManagedStopReceipt>,
}

impl ManagedCreateChainStopReceipt {
    pub fn closed(
        root: ManagedCreateReconcileRequest,
        effective: ManagedCreateReconcileRequest,
    ) -> Result<Self, RuntimeContractError> {
        Self::new(root, effective, None)
    }

    pub fn stopped(
        root: ManagedCreateReconcileRequest,
        effective: ManagedCreateReconcileRequest,
        stop_receipt: ManagedStopReceipt,
    ) -> Result<Self, RuntimeContractError> {
        Self::new(root, effective, Some(stop_receipt))
    }

    fn new(
        root: ManagedCreateReconcileRequest,
        effective: ManagedCreateReconcileRequest,
        stop_receipt: Option<ManagedStopReceipt>,
    ) -> Result<Self, RuntimeContractError> {
        let receipt = Self {
            schema: MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA.to_string(),
            schema_version: MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_VERSION,
            root,
            effective,
            stop_receipt,
        };
        receipt.validate()?;
        Ok(receipt)
    }

    #[must_use]
    pub fn root(&self) -> &ManagedCreateReconcileRequest {
        &self.root
    }

    #[must_use]
    pub fn effective(&self) -> &ManagedCreateReconcileRequest {
        &self.effective
    }

    #[must_use]
    pub fn stop_receipt(&self) -> Option<&ManagedStopReceipt> {
        self.stop_receipt.as_ref()
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA
            || self.schema_version != MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_VERSION
        {
            return Err(RuntimeContractError::new(
                "managed create chain-stop receipt has an unsupported schema",
            ));
        }
        self.root.validate()?;
        self.effective.validate()?;
        if self.effective.workspace_id() != self.root.workspace_id() {
            return Err(RuntimeContractError::new(
                "managed create chain-stop receipt changed workspace identity",
            ));
        }
        if let Some(stop) = &self.stop_receipt {
            stop.validate()?;
            if stop.session_id() != self.effective.session_id()
                || stop.workspace_id() != self.effective.workspace_id()
            {
                return Err(RuntimeContractError::new(
                    "managed create chain-stop receipt changed effective stop identity",
                ));
            }
        }
        Ok(())
    }

    pub fn validate_against(
        &self,
        root: &ManagedCreateReconcileRequest,
    ) -> Result<(), RuntimeContractError> {
        self.validate()?;
        if &self.root != root {
            return Err(RuntimeContractError::new(
                "managed create chain-stop receipt changed root identity",
            ));
        }
        Ok(())
    }
}

/// Durable v2 result containing the complete ordered identity path closed by
/// one managed-create chain-stop operation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedCreateChainStopReceiptV2 {
    schema: String,
    schema_version: u16,
    chain: Vec<ManagedCreateReconcileRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stop_receipt: Option<ManagedStopReceipt>,
}

impl ManagedCreateChainStopReceiptV2 {
    pub fn closed(chain: Vec<ManagedCreateReconcileRequest>) -> Result<Self, RuntimeContractError> {
        Self::new(chain, None)
    }

    pub fn stopped(
        chain: Vec<ManagedCreateReconcileRequest>,
        stop_receipt: ManagedStopReceipt,
    ) -> Result<Self, RuntimeContractError> {
        Self::new(chain, Some(stop_receipt))
    }

    fn new(
        chain: Vec<ManagedCreateReconcileRequest>,
        stop_receipt: Option<ManagedStopReceipt>,
    ) -> Result<Self, RuntimeContractError> {
        let receipt = Self {
            schema: MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_V2.to_string(),
            schema_version: MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_VERSION_V2,
            chain,
            stop_receipt,
        };
        receipt.validate()?;
        Ok(receipt)
    }

    #[must_use]
    pub fn root(&self) -> &ManagedCreateReconcileRequest {
        self.chain
            .first()
            .expect("validated managed create chain-stop receipt has a root")
    }

    #[must_use]
    pub fn effective(&self) -> &ManagedCreateReconcileRequest {
        self.chain
            .last()
            .expect("validated managed create chain-stop receipt has an effective identity")
    }

    #[must_use]
    pub fn chain(&self) -> &[ManagedCreateReconcileRequest] {
        &self.chain
    }

    #[must_use]
    pub fn stop_receipt(&self) -> Option<&ManagedStopReceipt> {
        self.stop_receipt.as_ref()
    }

    pub fn legacy_projection(
        &self,
        requested: &ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainStopReceipt, RuntimeContractError> {
        self.validate_against(requested)?;
        let effective = self.effective().clone();
        match self.stop_receipt.clone() {
            Some(stop_receipt) => {
                ManagedCreateChainStopReceipt::stopped(requested.clone(), effective, stop_receipt)
            }
            None => ManagedCreateChainStopReceipt::closed(requested.clone(), effective),
        }
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_V2
            || self.schema_version != MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_VERSION_V2
        {
            return Err(RuntimeContractError::new(
                "managed create chain-stop receipt has an unsupported schema",
            ));
        }
        let root = self.chain.first().ok_or_else(|| {
            RuntimeContractError::new("managed create chain-stop receipt has an empty chain")
        })?;
        if self.chain.len() > MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES {
            return Err(RuntimeContractError::new(
                "managed create chain-stop receipt exceeded the identity limit",
            ));
        }
        root.validate()?;
        let mut identities = BTreeSet::new();
        for identity in &self.chain {
            identity.validate()?;
            if identity.workspace_id() != root.workspace_id() {
                return Err(RuntimeContractError::new(
                    "managed create chain-stop receipt changed workspace identity",
                ));
            }
            if !identities.insert((identity.idempotency_key(), identity.session_id())) {
                return Err(RuntimeContractError::new(
                    "managed create chain-stop receipt repeated an identity",
                ));
            }
        }
        let effective = self
            .chain
            .last()
            .expect("non-empty managed create chain-stop receipt has an effective identity");
        if let Some(stop) = &self.stop_receipt {
            stop.validate()?;
            if stop.session_id() != effective.session_id()
                || stop.workspace_id() != effective.workspace_id()
            {
                return Err(RuntimeContractError::new(
                    "managed create chain-stop receipt changed effective stop identity",
                ));
            }
        }
        Ok(())
    }

    pub fn validate_against(
        &self,
        requested: &ManagedCreateReconcileRequest,
    ) -> Result<(), RuntimeContractError> {
        self.validate()?;
        if !self.chain.iter().any(|identity| identity == requested) {
            return Err(RuntimeContractError::new(
                "managed create chain-stop receipt omitted the requested identity",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedCreateChainStopBrokerResponse {
    Completed(Box<ManagedCreateChainStopReceipt>),
    NotFound,
    Pending,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
    Refused(ManagedCreateFailure),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedCreateChainStopBrokerResponseV2 {
    Completed(Box<ManagedCreateChainStopReceiptV2>),
    NotFound,
    Pending,
    AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable),
    Refused(ManagedCreateFailure),
}

impl ManagedCreateChainStopBrokerResponse {
    #[must_use]
    pub fn authority_unavailable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable {
            code: code.into(),
            message: message.into(),
        })
    }

    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Rejected,
            code: code.into(),
            message: message.into(),
        })
    }

    pub fn validate_against(
        &self,
        root: &ManagedCreateReconcileRequest,
    ) -> Result<(), RuntimeContractError> {
        root.validate()?;
        if let Self::Completed(receipt) = self {
            receipt.validate_against(root)?;
        }
        Ok(())
    }
}

impl ManagedCreateChainStopBrokerResponseV2 {
    #[must_use]
    pub fn authority_unavailable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::AuthorityUnavailable(ManagedCreateReconcileAuthorityUnavailable {
            code: code.into(),
            message: message.into(),
        })
    }

    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Rejected,
            code: code.into(),
            message: message.into(),
        })
    }

    pub fn validate_against(
        &self,
        root: &ManagedCreateReconcileRequest,
    ) -> Result<(), RuntimeContractError> {
        root.validate()?;
        if let Self::Completed(receipt) = self {
            receipt.validate_against(root)?;
        }
        Ok(())
    }

    pub fn legacy_projection(
        &self,
        requested: &ManagedCreateReconcileRequest,
    ) -> Result<ManagedCreateChainStopBrokerResponse, RuntimeContractError> {
        Ok(match self {
            Self::Completed(receipt) => ManagedCreateChainStopBrokerResponse::Completed(Box::new(
                receipt.legacy_projection(requested)?,
            )),
            Self::NotFound => ManagedCreateChainStopBrokerResponse::NotFound,
            Self::Pending => ManagedCreateChainStopBrokerResponse::Pending,
            Self::AuthorityUnavailable(authority) => {
                ManagedCreateChainStopBrokerResponse::AuthorityUnavailable(authority.clone())
            }
            Self::Refused(failure) => {
                ManagedCreateChainStopBrokerResponse::Refused(failure.clone())
            }
        })
    }
}

impl ManagedCreateBrokerResponse {
    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Rejected,
            code: code.into(),
            message: message.into(),
        })
    }

    #[must_use]
    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedCreateFailure {
            disposition: ManagedCreateFailureDisposition::Retryable,
            code: code.into(),
            message: message.into(),
        })
    }
}

/// One exact-generation, provider-neutral lifecycle observation delivered by
/// a managed provider adapter directly to Hmux. The runtime broker mints the
/// short-lived managed authorization proof; neither the adapter nor an app
/// server ever receives it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentStateReportRequest {
    schema: String,
    schema_version: u16,
    expected_fence: SessionFence,
    report: AgentStateReport,
}

impl ManagedAgentStateReportRequest {
    pub fn new(
        expected_fence: SessionFence,
        report: AgentStateReport,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_AGENT_STATE_REPORT_SCHEMA.to_string(),
            schema_version: if report.causality.is_some() {
                MANAGED_AGENT_STATE_REPORT_CAUSAL_SCHEMA_VERSION
            } else {
                MANAGED_AGENT_STATE_REPORT_SCHEMA_VERSION
            },
            expected_fence,
            report,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn into_parts(self) -> (SessionFence, AgentStateReport) {
        (self.expected_fence, self.report)
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let expected_version = if self.report.causality.is_some() {
            MANAGED_AGENT_STATE_REPORT_CAUSAL_SCHEMA_VERSION
        } else {
            MANAGED_AGENT_STATE_REPORT_SCHEMA_VERSION
        };
        if self.schema != MANAGED_AGENT_STATE_REPORT_SCHEMA
            || self.schema_version != expected_version
        {
            return Err(RuntimeContractError::new(
                "managed agent state report has an unsupported schema",
            ));
        }
        validate_identifier(
            &self.expected_fence.session_id,
            "managed agent state report session id",
        )?;
        validate_identifier(
            &self.expected_fence.workspace_id,
            "managed agent state report workspace id",
        )?;
        if self.expected_fence.channel_epoch == 0 {
            return Err(RuntimeContractError::new(
                "managed agent state report channel epoch is invalid",
            ));
        }
        for (name, value) in [
            (
                "managed agent state report runner principal",
                self.expected_fence.runner_principal.as_str(),
            ),
            (
                "managed agent state report runner instance",
                self.expected_fence.runner_instance.as_str(),
            ),
            (
                "managed agent state report host instance id",
                self.expected_fence.host_instance_id.as_str(),
            ),
            (
                "managed agent state report terminal epoch",
                self.expected_fence.terminal_epoch.as_str(),
            ),
        ] {
            validate_identifier(value, name)?;
        }
        if self
            .report
            .conversation_identity
            .as_ref()
            .and_then(|identity| identity.expected_fence.as_ref())
            .is_some()
        {
            return Err(RuntimeContractError::new(
                "managed agent state report carries a duplicate conversation fence",
            ));
        }
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::AgentStateReport(self.report.clone()),
        }
        .validate(&FrameLimits::default())
        .map_err(|error| RuntimeContractError::new(error.to_string()))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentStateReportFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedAgentStateReportBrokerResponse {
    Completed(AgentStateReportOutcome),
    Refused(ManagedAgentStateReportFailure),
}

impl ManagedAgentStateReportBrokerResponse {
    #[must_use]
    pub fn completed(outcome: AgentStateReportOutcome) -> Self {
        Self::Completed(outcome)
    }

    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedAgentStateReportFailure {
            code: code.into(),
            message: message.into(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAttachRequest {
    schema: String,
    schema_version: u16,
    session_id: String,
    workspace_id: String,
}

impl ManagedAttachRequest {
    pub fn new(
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_ATTACH_SCHEMA.to_string(),
            schema_version: MANAGED_ATTACH_SCHEMA_VERSION,
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
        };
        request.validate()?;
        Ok(request)
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_ATTACH_SCHEMA
            || self.schema_version != MANAGED_ATTACH_SCHEMA_VERSION
        {
            return Err(RuntimeContractError::new(
                "managed attach request has an unsupported schema",
            ));
        }
        validate_identifier(&self.session_id, "managed attach session id")?;
        validate_identifier(&self.workspace_id, "managed attach workspace id")
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAttachReceipt {
    schema: String,
    schema_version: u16,
    transaction_id: String,
    session_id: String,
    workspace_id: String,
    manifest: hmux_session_protocol::discovery::DiscoveryManifest,
    authorization_proof_reference: String,
}

impl ManagedAttachReceipt {
    pub fn new(
        transaction_id: impl Into<String>,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
        manifest: hmux_session_protocol::discovery::DiscoveryManifest,
        authorization_proof_reference: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let receipt = Self {
            schema: MANAGED_ATTACH_SCHEMA.to_string(),
            schema_version: MANAGED_ATTACH_SCHEMA_VERSION,
            transaction_id: transaction_id.into(),
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
            manifest,
            authorization_proof_reference: authorization_proof_reference.into(),
        };
        receipt.validate()?;
        Ok(receipt)
    }

    #[must_use]
    pub fn transaction_id(&self) -> &str {
        &self.transaction_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn manifest(&self) -> &hmux_session_protocol::discovery::DiscoveryManifest {
        &self.manifest
    }

    #[must_use]
    pub fn authorization_proof_reference(&self) -> &str {
        &self.authorization_proof_reference
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_ATTACH_SCHEMA
            || self.schema_version != MANAGED_ATTACH_SCHEMA_VERSION
        {
            return Err(RuntimeContractError::new(
                "managed attach receipt has an unsupported schema",
            ));
        }
        validate_identifier(&self.transaction_id, "managed attach transaction id")?;
        validate_identifier(&self.session_id, "managed attach session id")?;
        validate_identifier(&self.workspace_id, "managed attach workspace id")?;
        if self.authorization_proof_reference.is_empty()
            || self.authorization_proof_reference.len() > MAX_AUTHORIZATION_REFERENCE_BYTES
            || self
                .authorization_proof_reference
                .chars()
                .any(char::is_control)
        {
            return Err(RuntimeContractError::new(
                "managed attach authorization proof reference is invalid",
            ));
        }
        let common = self.manifest.common();
        if !common.session_class.is_managed()
            || common.lifetime.session_id != self.session_id
            || common.lifetime.workspace_id != self.workspace_id
            || !matches!(
                self.manifest,
                hmux_session_protocol::discovery::DiscoveryManifest::Ready(_)
            )
        {
            return Err(RuntimeContractError::new(
                "managed attach receipt does not match a ready managed session",
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for ManagedAttachReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedAttachReceipt")
            .field("schema", &self.schema)
            .field("schema_version", &self.schema_version)
            .field("transaction_id", &self.transaction_id)
            .field("session_id", &self.session_id)
            .field("workspace_id", &self.workspace_id)
            .field("manifest", &"<redacted>")
            .field("authorization_proof_reference", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAttachFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedAttachBrokerResponse {
    Prepared(Box<ManagedAttachReceipt>),
    Refused(ManagedAttachFailure),
}

impl ManagedAttachBrokerResponse {
    #[must_use]
    pub fn prepared(receipt: ManagedAttachReceipt) -> Self {
        Self::Prepared(Box::new(receipt))
    }

    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedAttachFailure {
            code: code.into(),
            message: message.into(),
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedAttachDecision {
    Commit,
    Abort,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAttachFinalization {
    schema: String,
    schema_version: u16,
    transaction_id: String,
    decision: ManagedAttachDecision,
}

impl ManagedAttachFinalization {
    pub fn commit(transaction_id: impl Into<String>) -> Result<Self, RuntimeContractError> {
        Self::new(transaction_id, ManagedAttachDecision::Commit)
    }

    pub fn abort(transaction_id: impl Into<String>) -> Result<Self, RuntimeContractError> {
        Self::new(transaction_id, ManagedAttachDecision::Abort)
    }

    fn new(
        transaction_id: impl Into<String>,
        decision: ManagedAttachDecision,
    ) -> Result<Self, RuntimeContractError> {
        let finalization = Self {
            schema: MANAGED_ATTACH_SCHEMA.to_string(),
            schema_version: MANAGED_ATTACH_SCHEMA_VERSION,
            transaction_id: transaction_id.into(),
            decision,
        };
        finalization.validate()?;
        Ok(finalization)
    }

    #[must_use]
    pub fn transaction_id(&self) -> &str {
        &self.transaction_id
    }

    #[must_use]
    pub fn decision(&self) -> ManagedAttachDecision {
        self.decision
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_ATTACH_SCHEMA
            || self.schema_version != MANAGED_ATTACH_SCHEMA_VERSION
        {
            return Err(RuntimeContractError::new(
                "managed attach finalization has an unsupported schema",
            ));
        }
        validate_identifier(&self.transaction_id, "managed attach transaction id")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStopQuiescenceFence {
    terminal_epoch: String,
    runtime_revision: u64,
    /// The terminal output high-water captured alongside `runtime_revision`
    /// by one exact session inspection. It fences output after that decision;
    /// it need not equal the older output sequence carried by an unchanged
    /// semantic runtime projection.
    observed_through_output_seq: u64,
}

impl ManagedStopQuiescenceFence {
    pub fn new(
        terminal_epoch: impl Into<String>,
        runtime_revision: u64,
        observed_through_output_seq: u64,
    ) -> Result<Self, RuntimeContractError> {
        let fence = Self {
            terminal_epoch: terminal_epoch.into(),
            runtime_revision,
            observed_through_output_seq,
        };
        fence.validate()?;
        Ok(fence)
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn runtime_revision(&self) -> u64 {
        self.runtime_revision
    }

    #[must_use]
    pub fn observed_through_output_seq(&self) -> u64 {
        self.observed_through_output_seq
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_identifier(
            &self.terminal_epoch,
            "managed stop quiescence terminal epoch",
        )?;
        if self.runtime_revision == 0 {
            return Err(RuntimeContractError::new(
                "managed stop quiescence runtime revision must be positive",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStopConversationFence {
    provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

impl ManagedStopConversationFence {
    pub fn new(
        provider_id: impl Into<String>,
        conversation_id: Option<String>,
    ) -> Result<Self, RuntimeContractError> {
        let fence = Self {
            provider_id: provider_id.into(),
            conversation_id,
        };
        fence.validate()?;
        Ok(fence)
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn conversation_id(&self) -> Option<&str> {
        self.conversation_id.as_deref()
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_opaque_identity(&self.provider_id, "managed stop conversation provider id")?;
        if let Some(conversation_id) = self.conversation_id.as_deref() {
            validate_opaque_identity(
                conversation_id,
                "managed stop conversation opaque identifier",
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStopRequest {
    schema: String,
    schema_version: u16,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_runner_principal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_runner_instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_channel_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_host_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_terminal_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_quiescence: Option<ManagedStopQuiescenceFence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_conversation: Option<ManagedStopConversationFence>,
}

impl ManagedStopRequest {
    pub fn new(
        stop_id: impl Into<String>,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_STOP_SCHEMA.to_string(),
            schema_version: MANAGED_STOP_REQUEST_SCHEMA_VERSION_LEGACY,
            stop_id: stop_id.into(),
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
            expected_runner_principal: None,
            expected_runner_instance: None,
            expected_channel_epoch: None,
            expected_host_instance_id: None,
            expected_terminal_epoch: None,
            expected_quiescence: None,
            expected_conversation: None,
        };
        request.validate()?;
        Ok(request)
    }

    #[must_use]
    pub fn stop_id(&self) -> &str {
        &self.stop_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn with_expected_generation(
        mut self,
        host_instance_id: impl Into<String>,
        terminal_epoch: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.expected_host_instance_id = Some(host_instance_id.into());
        self.expected_terminal_epoch = Some(terminal_epoch.into());
        self.schema_version = MANAGED_STOP_REQUEST_SCHEMA_VERSION_FENCED;
        self.validate()?;
        Ok(self)
    }

    pub fn with_expected_fence(
        mut self,
        runner_principal: impl Into<String>,
        runner_instance: impl Into<String>,
        channel_epoch: u64,
        host_instance_id: impl Into<String>,
        terminal_epoch: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.expected_runner_principal = Some(runner_principal.into());
        self.expected_runner_instance = Some(runner_instance.into());
        self.expected_channel_epoch = Some(channel_epoch);
        self.expected_host_instance_id = Some(host_instance_id.into());
        self.expected_terminal_epoch = Some(terminal_epoch.into());
        self.schema_version = MANAGED_STOP_REQUEST_SCHEMA_VERSION_COMPLETE_FENCE;
        self.validate()?;
        Ok(self)
    }

    pub fn with_expected_quiescence(
        mut self,
        expected: ManagedStopQuiescenceFence,
    ) -> Result<Self, RuntimeContractError> {
        self.validate_complete_fence()?;
        if self.expected_terminal_epoch.as_deref() != Some(expected.terminal_epoch()) {
            return Err(RuntimeContractError::new(
                "managed stop quiescence fence changed the terminal epoch",
            ));
        }
        self.expected_quiescence = Some(expected);
        self.schema_version = if self.expected_conversation.is_some() {
            MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION
        } else {
            MANAGED_STOP_QUIESCENT_REQUEST_VERSION
        };
        self.validate()?;
        Ok(self)
    }

    pub fn with_expected_conversation(
        mut self,
        expected: ManagedStopConversationFence,
    ) -> Result<Self, RuntimeContractError> {
        self.validate_complete_fence()?;
        expected.validate()?;
        self.expected_conversation = Some(expected);
        self.schema_version = MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION;
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn expected_runner_principal(&self) -> Option<&str> {
        self.expected_runner_principal.as_deref()
    }

    #[must_use]
    pub fn expected_runner_instance(&self) -> Option<&str> {
        self.expected_runner_instance.as_deref()
    }

    #[must_use]
    pub fn expected_channel_epoch(&self) -> Option<u64> {
        self.expected_channel_epoch
    }

    #[must_use]
    pub fn expected_host_instance_id(&self) -> Option<&str> {
        self.expected_host_instance_id.as_deref()
    }

    #[must_use]
    pub fn expected_terminal_epoch(&self) -> Option<&str> {
        self.expected_terminal_epoch.as_deref()
    }

    #[must_use]
    pub fn expected_quiescence(&self) -> Option<&ManagedStopQuiescenceFence> {
        self.expected_quiescence.as_ref()
    }

    #[must_use]
    pub fn expected_conversation(&self) -> Option<&ManagedStopConversationFence> {
        self.expected_conversation.as_ref()
    }

    fn validate_complete_generation_fields(&self) -> Result<(), RuntimeContractError> {
        let runner_principal = self.expected_runner_principal.as_deref().ok_or_else(|| {
            RuntimeContractError::new("managed stop complete fence is missing runner principal")
        })?;
        let runner_instance = self.expected_runner_instance.as_deref().ok_or_else(|| {
            RuntimeContractError::new("managed stop complete fence is missing runner instance")
        })?;
        if self.expected_channel_epoch.is_none() {
            return Err(RuntimeContractError::new(
                "managed stop complete fence is missing channel epoch",
            ));
        }
        let host_instance_id = self.expected_host_instance_id.as_deref().ok_or_else(|| {
            RuntimeContractError::new("managed stop complete fence is missing host instance id")
        })?;
        let terminal_epoch = self.expected_terminal_epoch.as_deref().ok_or_else(|| {
            RuntimeContractError::new("managed stop complete fence is missing terminal epoch")
        })?;
        validate_identifier(runner_principal, "managed stop expected runner principal")?;
        validate_identifier(runner_instance, "managed stop expected runner instance")?;
        validate_identifier(host_instance_id, "managed stop expected host instance id")?;
        validate_identifier(terminal_epoch, "managed stop expected terminal epoch")
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_STOP_SCHEMA {
            return Err(RuntimeContractError::new(
                "managed stop request has an unsupported schema",
            ));
        }
        validate_identifier(&self.stop_id, "managed stop id")?;
        validate_identifier(&self.session_id, "managed stop session id")?;
        validate_identifier(&self.workspace_id, "managed stop workspace id")?;
        match self.schema_version {
            MANAGED_STOP_REQUEST_SCHEMA_VERSION_COMPLETE_FENCE
            | MANAGED_STOP_QUIESCENT_REQUEST_VERSION => {
                let runner_principal =
                    self.expected_runner_principal.as_deref().ok_or_else(|| {
                        RuntimeContractError::new(
                            "managed stop complete fence is missing runner principal",
                        )
                    })?;
                let runner_instance =
                    self.expected_runner_instance.as_deref().ok_or_else(|| {
                        RuntimeContractError::new(
                            "managed stop complete fence is missing runner instance",
                        )
                    })?;
                if self.expected_channel_epoch.is_none() {
                    return Err(RuntimeContractError::new(
                        "managed stop complete fence is missing channel epoch",
                    ));
                }
                let host_instance_id =
                    self.expected_host_instance_id.as_deref().ok_or_else(|| {
                        RuntimeContractError::new(
                            "managed stop complete fence is missing host instance id",
                        )
                    })?;
                let terminal_epoch = self.expected_terminal_epoch.as_deref().ok_or_else(|| {
                    RuntimeContractError::new(
                        "managed stop complete fence is missing terminal epoch",
                    )
                })?;
                validate_identifier(runner_principal, "managed stop expected runner principal")?;
                validate_identifier(runner_instance, "managed stop expected runner instance")?;
                validate_identifier(host_instance_id, "managed stop expected host instance id")?;
                validate_identifier(terminal_epoch, "managed stop expected terminal epoch")?;
                if self.expected_conversation.is_some() {
                    return Err(RuntimeContractError::new(
                        "managed stop conversation fence does not match its schema version",
                    ));
                }
                match (self.schema_version, &self.expected_quiescence) {
                    (MANAGED_STOP_REQUEST_SCHEMA_VERSION_COMPLETE_FENCE, None) => Ok(()),
                    (MANAGED_STOP_QUIESCENT_REQUEST_VERSION, Some(expected)) => {
                        expected.validate()?;
                        if expected.terminal_epoch() != terminal_epoch {
                            return Err(RuntimeContractError::new(
                                "managed stop quiescence fence changed the terminal epoch",
                            ));
                        }
                        Ok(())
                    }
                    _ => Err(RuntimeContractError::new(
                        "managed stop quiescence does not match its schema version",
                    )),
                }
            }
            MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION => {
                let conversation = self.expected_conversation.as_ref().ok_or_else(|| {
                    RuntimeContractError::new("managed stop conversation fence is missing")
                })?;
                conversation.validate()?;
                self.validate_complete_generation_fields()?;
                if let Some(expected) = &self.expected_quiescence {
                    expected.validate()?;
                    if self.expected_terminal_epoch.as_deref() != Some(expected.terminal_epoch()) {
                        return Err(RuntimeContractError::new(
                            "managed stop quiescence fence changed the terminal epoch",
                        ));
                    }
                }
                Ok(())
            }
            MANAGED_STOP_REQUEST_SCHEMA_VERSION_FENCED => match (
                self.expected_runner_principal.as_deref(),
                self.expected_runner_instance.as_deref(),
                self.expected_channel_epoch,
                self.expected_host_instance_id.as_deref(),
                self.expected_terminal_epoch.as_deref(),
                self.expected_quiescence.as_ref(),
                self.expected_conversation.as_ref(),
            ) {
                (None, None, None, Some(host_instance_id), Some(terminal_epoch), None, None) => {
                    validate_identifier(
                        host_instance_id,
                        "managed stop expected host instance id",
                    )?;
                    validate_identifier(terminal_epoch, "managed stop expected terminal epoch")
                }
                _ => Err(RuntimeContractError::new(
                    "managed stop expected generation does not match its schema version",
                )),
            },
            MANAGED_STOP_REQUEST_SCHEMA_VERSION_LEGACY => match (
                self.expected_runner_principal.as_deref(),
                self.expected_runner_instance.as_deref(),
                self.expected_channel_epoch,
                self.expected_host_instance_id.as_deref(),
                self.expected_terminal_epoch.as_deref(),
                self.expected_quiescence.as_ref(),
                self.expected_conversation.as_ref(),
            ) {
                (None, None, None, None, None, None, None) => Ok(()),
                _ => Err(RuntimeContractError::new(
                    "managed stop expected generation does not match its schema version",
                )),
            },
            _ => Err(RuntimeContractError::new(
                "managed stop request has an unsupported schema",
            )),
        }
    }

    /// Requires the complete runner, Host, and terminal generation fence used
    /// by destructive managed-stop brokers. Legacy v1/v2 packets remain
    /// decodable for wire compatibility, but must not cross that boundary.
    pub fn validate_complete_fence(&self) -> Result<(), RuntimeContractError> {
        self.validate()?;
        if !matches!(
            self.schema_version,
            MANAGED_STOP_REQUEST_SCHEMA_VERSION_COMPLETE_FENCE
                | MANAGED_STOP_QUIESCENT_REQUEST_VERSION
                | MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION
        ) {
            return Err(RuntimeContractError::new(
                "managed stop complete fence is required",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedStopOutcome {
    Stopped,
    AlreadyExited,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStopReceipt {
    schema: String,
    schema_version: u16,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: u64,
    host_instance_id: String,
    terminal_epoch: String,
    outcome: ManagedStopOutcome,
    exit_reason: String,
}

impl ManagedStopReceipt {
    pub fn from_request(
        request: &ManagedStopRequest,
        outcome: ManagedStopOutcome,
        exit_reason: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        request.validate()?;
        let receipt = Self {
            schema: MANAGED_STOP_SCHEMA.to_string(),
            schema_version: MANAGED_STOP_RECEIPT_SCHEMA_VERSION_COMPLETE_FENCE,
            stop_id: request.stop_id().to_string(),
            session_id: request.session_id().to_string(),
            workspace_id: request.workspace_id().to_string(),
            runner_principal: request
                .expected_runner_principal()
                .ok_or_else(|| {
                    RuntimeContractError::new("managed stop receipt requires runner principal")
                })?
                .to_string(),
            runner_instance: request
                .expected_runner_instance()
                .ok_or_else(|| {
                    RuntimeContractError::new("managed stop receipt requires runner instance")
                })?
                .to_string(),
            channel_epoch: request.expected_channel_epoch().ok_or_else(|| {
                RuntimeContractError::new("managed stop receipt requires channel epoch")
            })?,
            host_instance_id: request
                .expected_host_instance_id()
                .ok_or_else(|| {
                    RuntimeContractError::new("managed stop receipt requires Host instance id")
                })?
                .to_string(),
            terminal_epoch: request
                .expected_terminal_epoch()
                .ok_or_else(|| {
                    RuntimeContractError::new("managed stop receipt requires terminal epoch")
                })?
                .to_string(),
            outcome,
            exit_reason: exit_reason.into(),
        };
        receipt.validate()?;
        Ok(receipt)
    }

    #[must_use]
    pub fn stop_id(&self) -> &str {
        &self.stop_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn runner_principal(&self) -> &str {
        &self.runner_principal
    }

    #[must_use]
    pub fn runner_instance(&self) -> &str {
        &self.runner_instance
    }

    #[must_use]
    pub fn channel_epoch(&self) -> u64 {
        self.channel_epoch
    }

    #[must_use]
    pub fn host_instance_id(&self) -> &str {
        &self.host_instance_id
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn outcome(&self) -> ManagedStopOutcome {
        self.outcome
    }

    #[must_use]
    pub fn exit_reason(&self) -> &str {
        &self.exit_reason
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_STOP_SCHEMA
            || self.schema_version != MANAGED_STOP_RECEIPT_SCHEMA_VERSION_COMPLETE_FENCE
        {
            return Err(RuntimeContractError::new(
                "managed stop receipt has an unsupported schema",
            ));
        }
        validate_identifier(&self.stop_id, "managed stop id")?;
        validate_identifier(&self.session_id, "managed stop session id")?;
        validate_identifier(&self.workspace_id, "managed stop workspace id")?;
        validate_identifier(
            &self.runner_principal,
            "managed stop receipt runner principal",
        )?;
        validate_identifier(
            &self.runner_instance,
            "managed stop receipt runner instance",
        )?;
        validate_identifier(&self.host_instance_id, "managed stop host instance id")?;
        validate_identifier(&self.terminal_epoch, "managed stop terminal epoch")?;
        if self.exit_reason.is_empty()
            || self.exit_reason.len() > MAX_STOP_REASON_BYTES
            || self.exit_reason.chars().any(char::is_control)
        {
            return Err(RuntimeContractError::new(
                "managed stop exit reason is invalid",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStopFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedStopReconcileRequest {
    schema: String,
    schema_version: u16,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    expected_runner_principal: String,
    expected_runner_instance: String,
    expected_channel_epoch: u64,
    expected_host_instance_id: String,
    expected_terminal_epoch: String,
}

impl ManagedStopReconcileRequest {
    pub fn from_stop_request(request: &ManagedStopRequest) -> Result<Self, RuntimeContractError> {
        request.validate_complete_fence()?;
        let missing_fence =
            || RuntimeContractError::new("managed stop reconcile requires a complete source fence");
        let request = Self {
            schema: MANAGED_STOP_RECONCILE_SCHEMA.to_string(),
            schema_version: MANAGED_STOP_RECONCILE_SCHEMA_VERSION_COMPLETE_FENCE,
            stop_id: request.stop_id().to_string(),
            session_id: request.session_id().to_string(),
            workspace_id: request.workspace_id().to_string(),
            expected_runner_principal: request
                .expected_runner_principal()
                .ok_or_else(missing_fence)?
                .to_string(),
            expected_runner_instance: request
                .expected_runner_instance()
                .ok_or_else(missing_fence)?
                .to_string(),
            expected_channel_epoch: request.expected_channel_epoch().ok_or_else(missing_fence)?,
            expected_host_instance_id: request
                .expected_host_instance_id()
                .ok_or_else(missing_fence)?
                .to_string(),
            expected_terminal_epoch: request
                .expected_terminal_epoch()
                .ok_or_else(missing_fence)?
                .to_string(),
        };
        request.validate()?;
        Ok(request)
    }

    pub fn from_stop_receipt(receipt: &ManagedStopReceipt) -> Result<Self, RuntimeContractError> {
        receipt.validate()?;
        let request = Self {
            schema: MANAGED_STOP_RECONCILE_SCHEMA.to_string(),
            schema_version: MANAGED_STOP_RECONCILE_SCHEMA_VERSION_COMPLETE_FENCE,
            stop_id: receipt.stop_id().to_string(),
            session_id: receipt.session_id().to_string(),
            workspace_id: receipt.workspace_id().to_string(),
            expected_runner_principal: receipt.runner_principal().to_string(),
            expected_runner_instance: receipt.runner_instance().to_string(),
            expected_channel_epoch: receipt.channel_epoch(),
            expected_host_instance_id: receipt.host_instance_id().to_string(),
            expected_terminal_epoch: receipt.terminal_epoch().to_string(),
        };
        request.validate()?;
        Ok(request)
    }

    #[must_use]
    pub fn stop_id(&self) -> &str {
        &self.stop_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn expected_runner_principal(&self) -> &str {
        &self.expected_runner_principal
    }

    #[must_use]
    pub fn expected_runner_instance(&self) -> &str {
        &self.expected_runner_instance
    }

    #[must_use]
    pub fn expected_channel_epoch(&self) -> u64 {
        self.expected_channel_epoch
    }

    #[must_use]
    pub fn expected_host_instance_id(&self) -> &str {
        &self.expected_host_instance_id
    }

    #[must_use]
    pub fn expected_terminal_epoch(&self) -> &str {
        &self.expected_terminal_epoch
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_STOP_RECONCILE_SCHEMA
            || self.schema_version != MANAGED_STOP_RECONCILE_SCHEMA_VERSION_COMPLETE_FENCE
        {
            return Err(RuntimeContractError::new(
                "managed stop reconcile request has an unsupported schema",
            ));
        }
        validate_identifier(&self.stop_id, "managed stop reconcile id")?;
        validate_identifier(&self.session_id, "managed stop reconcile session id")?;
        validate_identifier(&self.workspace_id, "managed stop reconcile workspace id")?;
        validate_identifier(
            &self.expected_runner_principal,
            "managed stop reconcile runner principal",
        )?;
        validate_identifier(
            &self.expected_runner_instance,
            "managed stop reconcile runner instance",
        )?;
        validate_identifier(
            &self.expected_host_instance_id,
            "managed stop reconcile host instance id",
        )?;
        validate_identifier(
            &self.expected_terminal_epoch,
            "managed stop reconcile terminal epoch",
        )?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedStopBrokerResponse {
    Completed(Box<ManagedStopReceipt>),
    Refused(ManagedStopFailure),
}

impl ManagedStopBrokerResponse {
    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedStopFailure {
            code: code.into(),
            message: message.into(),
        })
    }
}

/// Minimal destructive authority for a daemon-independent managed rehost.
/// v1 loads the replacement launch from the exact source generation. v2 may
/// select a complete non-secret provider launch, including new state roots and
/// an exact-resume recipe, and journals it before source retirement. v3 also
/// pins the target runtime build confirmed by a rollout preview. v4 carries an
/// intentional fresh launch and no conversation identity through the same
/// journal.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostRequest {
    schema: String,
    schema_version: u16,
    operation_id: String,
    source: ManagedStopRequest,
    confirmed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    require_socket_owner_absent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_provider_id: Option<String>,
    /// Selects the exact replacement conversation. The runtime reads the
    /// source Host projection only when this selection is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_launch_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_target_build_id: Option<String>,
    /// Complete, non-secret replacement launch selection. Its presence moves
    /// the request to v2 so an older runtime refuses it before source stop
    /// instead of silently reusing the source provider-state roots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replacement: Option<ManagedRehostReplacement>,
}

/// Provider-neutral replacement state persisted by the remote runtime before
/// the source generation is retired. Assignments are path-only provider state
/// roots; removals carry only bounded environment names. Credential bytes and
/// provider-specific account concepts remain outside Hmux.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostReplacement {
    provider_id: String,
    permission_mode: PermissionMode,
    provider_cwd: PathBuf,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default, skip_serializing_if = "TerminalEnvironment::is_empty")]
    terminal_environment: TerminalEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_reference: Option<String>,
    #[serde(default, skip_serializing_if = "ProviderStateEnvironment::is_empty")]
    provider_state_environment: ProviderStateEnvironment,
    rehost: ManagedRehostRecipe,
    #[serde(default, skip_serializing_if = "ManagedRehostLaunch::is_exact_resume")]
    launch: ManagedRehostLaunch,
}

/// The one launch decision carried by a managed replacement. Exact rehost and
/// fresh start cannot coexist in a parsed request.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManagedRehostLaunch {
    #[default]
    ExactResume,
    Fresh {
        command: Vec<String>,
    },
}

impl ManagedRehostLaunch {
    #[must_use]
    pub fn is_exact_resume(&self) -> bool {
        matches!(self, Self::ExactResume)
    }

    #[must_use]
    pub fn fresh_command(&self) -> Option<&[String]> {
        match self {
            Self::ExactResume => None,
            Self::Fresh { command } => Some(command),
        }
    }

    fn validate(&self) -> Result<(), RuntimeContractError> {
        let Self::Fresh { command } = self else {
            return Ok(());
        };
        validate_command(command, "managed fresh replacement")?;
        if command
            .iter()
            .any(|argument| argument.contains(MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER))
        {
            return Err(RuntimeContractError::new(
                "managed fresh replacement cannot contain a conversation placeholder",
            ));
        }
        Ok(())
    }
}

impl ManagedRehostReplacement {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider_id: impl Into<String>,
        permission_mode: PermissionMode,
        provider_cwd: impl Into<PathBuf>,
        initial_rows: u16,
        initial_columns: u16,
        terminal_environment: TerminalEnvironment,
        launch_reference: Option<String>,
        provider_state_environment: ProviderStateEnvironment,
        rehost: ManagedRehostRecipe,
    ) -> Result<Self, RuntimeContractError> {
        let replacement = Self {
            provider_id: provider_id.into(),
            permission_mode,
            provider_cwd: provider_cwd.into(),
            initial_rows,
            initial_columns,
            terminal_environment,
            launch_reference,
            provider_state_environment,
            rehost,
            launch: ManagedRehostLaunch::ExactResume,
        };
        replacement.validate()?;
        Ok(replacement)
    }

    #[must_use]
    pub fn launch_reference(&self) -> Option<&str> {
        self.launch_reference.as_deref()
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn permission_mode(&self) -> PermissionMode {
        self.permission_mode
    }

    #[must_use]
    pub fn provider_cwd(&self) -> &Path {
        &self.provider_cwd
    }

    #[must_use]
    pub fn initial_rows(&self) -> u16 {
        self.initial_rows
    }

    #[must_use]
    pub fn initial_columns(&self) -> u16 {
        self.initial_columns
    }

    #[must_use]
    pub fn terminal_environment(&self) -> &TerminalEnvironment {
        &self.terminal_environment
    }

    #[must_use]
    pub fn provider_state_environment(&self) -> &ProviderStateEnvironment {
        &self.provider_state_environment
    }

    #[must_use]
    pub fn rehost(&self) -> &ManagedRehostRecipe {
        &self.rehost
    }

    pub fn with_fresh_command(
        mut self,
        command: Vec<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.launch = ManagedRehostLaunch::Fresh { command };
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn launch(&self) -> &ManagedRehostLaunch {
        &self.launch
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_identifier(&self.provider_id, "managed rehost replacement provider id")?;
        if !self.provider_cwd.is_absolute() {
            return Err(RuntimeContractError::new(
                "managed rehost replacement provider cwd must be absolute",
            ));
        }
        if self.initial_rows == 0 || self.initial_columns == 0 {
            return Err(RuntimeContractError::new(
                "managed rehost replacement terminal dimensions must be non-zero",
            ));
        }
        self.terminal_environment.validate()?;
        if let Some(reference) = self.launch_reference.as_deref() {
            validate_opaque_identity(reference, "managed rehost replacement launch reference")?;
        }
        self.provider_state_environment.validate()?;
        self.rehost.validate()?;
        self.launch.validate()?;
        if self.rehost.launch_reference() != self.launch_reference.as_deref() {
            return Err(RuntimeContractError::new(
                "managed rehost replacement recipe launch reference changed",
            ));
        }
        Ok(())
    }
}

impl ManagedRehostRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        operation_id: impl Into<String>,
        source_session_id: impl Into<String>,
        source_workspace_id: impl Into<String>,
        runner_principal: impl Into<String>,
        runner_instance: impl Into<String>,
        channel_epoch: u64,
        host_instance_id: impl Into<String>,
        terminal_epoch: impl Into<String>,
        confirmed: bool,
    ) -> Result<Self, RuntimeContractError> {
        let operation_id = operation_id.into();
        if operation_id.len() > MAX_MANAGED_REHOST_OPERATION_ID_BYTES {
            return Err(RuntimeContractError::new(
                "managed rehost operation id is too large",
            ));
        }
        let source = ManagedStopRequest::new(
            format!("managed_rehost_stop_{operation_id}"),
            source_session_id,
            source_workspace_id,
        )?
        .with_expected_fence(
            runner_principal,
            runner_instance,
            channel_epoch,
            host_instance_id,
            terminal_epoch,
        )?;
        let request = Self {
            schema: MANAGED_REHOST_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_SCHEMA_VERSION,
            operation_id,
            source,
            confirmed,
            require_socket_owner_absent: false,
            expected_provider_id: None,
            expected_conversation_id: None,
            expected_launch_reference: None,
            expected_target_build_id: None,
            replacement: None,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn with_expected_provider_id(
        mut self,
        provider_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.expected_provider_id = Some(provider_id.into());
        self.validate()?;
        Ok(self)
    }

    pub fn with_expected_conversation_id(
        mut self,
        conversation_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.expected_conversation_id = Some(conversation_id.into());
        self.validate()?;
        Ok(self)
    }

    pub fn with_expected_launch_reference(
        mut self,
        launch_reference: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.expected_launch_reference = Some(launch_reference.into());
        self.validate()?;
        Ok(self)
    }

    /// Selects replacement provider-state mutations explicitly. Switching from
    /// a scoped profile to the runtime default carries explicit state-root
    /// removals; an empty environment does not prove provider-default state.
    /// `None` retains v1 same-launch behavior.
    pub fn with_replacement(
        mut self,
        replacement: ManagedRehostReplacement,
    ) -> Result<Self, RuntimeContractError> {
        replacement.validate()?;
        if !replacement
            .provider_state_environment()
            .removals()
            .is_empty()
        {
            self.schema = MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA.to_string();
            self.schema_version = MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION;
        } else if replacement.launch().is_exact_resume() {
            self.schema = MANAGED_REHOST_REPLACEMENT_SCHEMA.to_string();
            self.schema_version = MANAGED_REHOST_REPLACEMENT_SCHEMA_VERSION;
        } else {
            self.schema = MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA.to_string();
            self.schema_version = MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA_VERSION;
        }
        self.replacement = Some(replacement);
        self.validate()?;
        Ok(self)
    }

    /// Apply last. Older brokers reject v7 rather than force-retiring a source
    /// whose Host could not verify the guards.
    /// Fence a fresh source at its inspected idle state and require the Host
    /// to still have no conversation when admitting retirement.
    pub fn with_fresh_source_quiescence(
        mut self,
        expected: ManagedStopQuiescenceFence,
    ) -> Result<Self, RuntimeContractError> {
        if !self.is_fresh_replacement() {
            return Err(RuntimeContractError::new(
                "fresh source guard requires a fresh replacement",
            ));
        }
        let provider_id = self.expected_provider_id.clone().ok_or_else(|| {
            RuntimeContractError::new("fresh source guard requires an expected provider")
        })?;
        self.source = self
            .source
            .with_expected_quiescence(expected)?
            .with_expected_conversation(ManagedStopConversationFence::new(provider_id, None)?)?;
        self.schema = MANAGED_REHOST_GUARDED_FRESH_SCHEMA.to_string();
        self.schema_version = MANAGED_REHOST_GUARDED_FRESH_SCHEMA_VERSION;
        self.validate()?;
        Ok(self)
    }

    pub fn with_expected_target_build_id(
        mut self,
        build_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        self.expected_target_build_id = Some(build_id.into());
        if self.replacement.as_ref().is_some_and(|replacement| {
            !replacement
                .provider_state_environment()
                .removals()
                .is_empty()
        }) {
            self.schema = MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA.to_string();
            self.schema_version = MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION;
        } else if !self.is_fresh_replacement() {
            self.schema = MANAGED_REHOST_TARGET_BUILD_SCHEMA.to_string();
            self.schema_version = MANAGED_REHOST_TARGET_BUILD_SCHEMA_VERSION;
        }
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    /// Apply last, after the complete replacement selection. Older brokers
    /// reject v6 before retirement instead of ignoring its admission guard.
    pub fn requiring_socket_owner_absence(mut self) -> Result<Self, RuntimeContractError> {
        self.require_socket_owner_absent = true;
        self.schema = MANAGED_REHOST_SOCKET_OWNER_ABSENT_SCHEMA.to_string();
        self.schema_version = MANAGED_REHOST_SOCKET_OWNER_ABSENT_SCHEMA_VERSION;
        self.validate()?;
        Ok(self)
    }

    #[must_use]
    pub fn requires_socket_owner_absent(&self) -> bool {
        self.require_socket_owner_absent
    }

    #[must_use]
    pub fn source(&self) -> &ManagedStopRequest {
        &self.source
    }

    #[must_use]
    pub fn confirmed(&self) -> bool {
        self.confirmed
    }

    #[must_use]
    pub fn expected_provider_id(&self) -> Option<&str> {
        self.expected_provider_id.as_deref()
    }

    #[must_use]
    pub fn expected_conversation_id(&self) -> Option<&str> {
        self.expected_conversation_id.as_deref()
    }

    #[must_use]
    pub fn expected_launch_reference(&self) -> Option<&str> {
        self.expected_launch_reference.as_deref()
    }

    #[must_use]
    pub fn expected_target_build_id(&self) -> Option<&str> {
        self.expected_target_build_id.as_deref()
    }

    #[must_use]
    pub fn replacement(&self) -> Option<&ManagedRehostReplacement> {
        self.replacement.as_ref()
    }

    #[must_use]
    pub fn is_fresh_replacement(&self) -> bool {
        self.replacement
            .as_ref()
            .is_some_and(|replacement| !replacement.launch().is_exact_resume())
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let v1 = self.schema == MANAGED_REHOST_SCHEMA
            && self.schema_version == MANAGED_REHOST_SCHEMA_VERSION
            && self.replacement.is_none()
            && self.expected_target_build_id.is_none();
        let v2 = self.schema == MANAGED_REHOST_REPLACEMENT_SCHEMA
            && self.schema_version == MANAGED_REHOST_REPLACEMENT_SCHEMA_VERSION
            && self.replacement.as_ref().is_some_and(|replacement| {
                replacement
                    .provider_state_environment()
                    .removals()
                    .is_empty()
            })
            && self.expected_target_build_id.is_none();
        let v3 = self.schema == MANAGED_REHOST_TARGET_BUILD_SCHEMA
            && self.schema_version == MANAGED_REHOST_TARGET_BUILD_SCHEMA_VERSION
            && self.replacement.as_ref().is_some_and(|replacement| {
                replacement
                    .provider_state_environment()
                    .removals()
                    .is_empty()
            })
            && self.expected_target_build_id.is_some();
        let v4 = self.schema == MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA
            && self.schema_version == MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA_VERSION
            && self.replacement.as_ref().is_some_and(|replacement| {
                replacement
                    .provider_state_environment()
                    .removals()
                    .is_empty()
            });
        let v5 = self.schema == MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA
            && self.schema_version == MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION
            && self.replacement.as_ref().is_some_and(|replacement| {
                !replacement
                    .provider_state_environment()
                    .removals()
                    .is_empty()
            });
        let v6 = self.schema == MANAGED_REHOST_SOCKET_OWNER_ABSENT_SCHEMA
            && self.schema_version == MANAGED_REHOST_SOCKET_OWNER_ABSENT_SCHEMA_VERSION
            && self.require_socket_owner_absent
            && self.expected_conversation_id.is_some()
            && !self.is_fresh_replacement();
        let v7 = self.schema == MANAGED_REHOST_GUARDED_FRESH_SCHEMA
            && self.schema_version == MANAGED_REHOST_GUARDED_FRESH_SCHEMA_VERSION
            && self.is_fresh_replacement()
            && self.expected_provider_id.is_some()
            && self.expected_conversation_id.is_none()
            && self.source.expected_quiescence().is_some()
            && self.source.expected_conversation().is_some_and(|expected| {
                Some(expected.provider_id()) == self.expected_provider_id()
                    && expected.conversation_id().is_none()
            });
        if (!v1 && !v2 && !v3 && !v4 && !v5 && !v6 && !v7)
            || (self.require_socket_owner_absent && !v6)
            || ((self.source.expected_quiescence().is_some()
                || self.source.expected_conversation().is_some())
                && !v7)
        {
            return Err(RuntimeContractError::new(
                "managed rehost request has an unsupported schema",
            ));
        }
        validate_identifier(&self.operation_id, "managed rehost operation id")?;
        if self.operation_id.len() > MAX_MANAGED_REHOST_OPERATION_ID_BYTES {
            return Err(RuntimeContractError::new(
                "managed rehost operation id is too large",
            ));
        }
        self.source.validate_complete_fence()?;
        if let Some(provider_id) = self.expected_provider_id.as_deref() {
            validate_opaque_identity(provider_id, "managed rehost expected provider id")?;
        }
        if let Some(conversation_id) = self.expected_conversation_id.as_deref() {
            validate_opaque_identity(conversation_id, "managed rehost expected conversation id")?;
        }
        if let Some(reference) = self.expected_launch_reference.as_deref() {
            validate_opaque_identity(reference, "managed rehost expected launch reference")?;
        }
        if let Some(build_id) = self.expected_target_build_id.as_deref() {
            validate_opaque_identity(build_id, "managed rehost expected target build id")?;
        }
        if let Some(replacement) = self.replacement.as_ref() {
            replacement.validate()?;
        }
        let replacement_launch = self
            .replacement
            .as_ref()
            .map(ManagedRehostReplacement::launch);
        if v4
            && (self.expected_conversation_id.is_some()
                || replacement_launch.is_none_or(ManagedRehostLaunch::is_exact_resume))
        {
            return Err(RuntimeContractError::new(
                "managed fresh replacement requires a fresh launch without conversation identity",
            ));
        }
        if v5
            && self.expected_conversation_id.is_some()
            && replacement_launch.is_some_and(|launch| !launch.is_exact_resume())
        {
            return Err(RuntimeContractError::new(
                "managed fresh replacement requires a fresh launch without conversation identity",
            ));
        }
        if (v2 || v3) && replacement_launch.is_some_and(|launch| !launch.is_exact_resume()) {
            return Err(RuntimeContractError::new(
                "managed exact rehost cannot carry a fresh launch",
            ));
        }
        Ok(())
    }
}

/// Replays or resumes only an already-journaled managed rehost. It deliberately
/// omits replacement paths: after admission the runtime-owned journal is the
/// sole replacement authority. Provider, conversation, and launch fields are
/// optional compatibility hints and never authorize or block reconciliation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostReconcileRequest {
    schema: String,
    schema_version: u16,
    operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<ManagedStopRequest>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    source_session_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    source_workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Optional equality hint only. The runtime-owned journal remains the
    /// replacement authority, so response-loss recovery must work without it.
    expected_replacement_launch_reference: Option<String>,
}

impl ManagedRehostReconcileRequest {
    pub fn new(
        operation_id: impl Into<String>,
        source: ManagedStopRequest,
        expected_provider_id: impl Into<String>,
        expected_conversation_id: impl Into<String>,
        expected_replacement_launch_reference: Option<String>,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_REHOST_RECONCILE_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_RECONCILE_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            source: Some(source),
            source_session_id: String::new(),
            source_workspace_id: String::new(),
            expected_provider_id: Some(expected_provider_id.into()),
            expected_conversation_id: Some(expected_conversation_id.into()),
            expected_replacement_launch_reference,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn without_client_hints(
        operation_id: impl Into<String>,
        source: ManagedStopRequest,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_REHOST_RECONCILE_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_RECONCILE_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            source: Some(source),
            source_session_id: String::new(),
            source_workspace_id: String::new(),
            expected_provider_id: None,
            expected_conversation_id: None,
            expected_replacement_launch_reference: None,
        };
        request.validate()?;
        Ok(request)
    }

    /// Selects an already-journaled operation using only its durable identity.
    /// The source generation fence lives in the journaled canonical payload and
    /// is deliberately not repeated by a response-loss retry.
    pub fn by_operation_identity(
        operation_id: impl Into<String>,
        source_session_id: impl Into<String>,
        source_workspace_id: impl Into<String>,
    ) -> Result<Self, RuntimeContractError> {
        let request = Self {
            schema: MANAGED_REHOST_RECONCILE_IDENTITY_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_RECONCILE_IDENTITY_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            source: None,
            source_session_id: source_session_id.into(),
            source_workspace_id: source_workspace_id.into(),
            expected_provider_id: None,
            expected_conversation_id: None,
            expected_replacement_launch_reference: None,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn from_rehost_request(
        request: &ManagedRehostRequest,
    ) -> Result<Self, RuntimeContractError> {
        request.validate()?;
        Self::without_client_hints(request.operation_id.clone(), request.source.clone())
    }

    #[must_use]
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    #[must_use]
    pub fn source(&self) -> Option<&ManagedStopRequest> {
        self.source.as_ref()
    }

    #[must_use]
    pub fn source_session_id(&self) -> &str {
        self.source.as_ref().map_or(
            self.source_session_id.as_str(),
            ManagedStopRequest::session_id,
        )
    }

    #[must_use]
    pub fn source_workspace_id(&self) -> &str {
        self.source.as_ref().map_or(
            self.source_workspace_id.as_str(),
            ManagedStopRequest::workspace_id,
        )
    }

    #[must_use]
    pub fn expected_provider_id(&self) -> Option<&str> {
        self.expected_provider_id.as_deref()
    }

    #[must_use]
    pub fn expected_conversation_id(&self) -> Option<&str> {
        self.expected_conversation_id.as_deref()
    }

    #[must_use]
    pub fn expected_replacement_launch_reference(&self) -> Option<&str> {
        self.expected_replacement_launch_reference.as_deref()
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let fenced = self.schema == MANAGED_REHOST_RECONCILE_SCHEMA
            && self.schema_version == MANAGED_REHOST_RECONCILE_SCHEMA_VERSION
            && self.source.is_some()
            && self.source_session_id.is_empty()
            && self.source_workspace_id.is_empty();
        let identity_only = self.schema == MANAGED_REHOST_RECONCILE_IDENTITY_SCHEMA
            && self.schema_version == MANAGED_REHOST_RECONCILE_IDENTITY_SCHEMA_VERSION
            && self.source.is_none()
            && !self.source_session_id.is_empty()
            && !self.source_workspace_id.is_empty();
        if !fenced && !identity_only {
            return Err(RuntimeContractError::new(
                "managed rehost reconcile request has an unsupported schema",
            ));
        }
        validate_identifier(&self.operation_id, "managed rehost reconcile operation id")?;
        if self.operation_id.len() > MAX_MANAGED_REHOST_OPERATION_ID_BYTES {
            return Err(RuntimeContractError::new(
                "managed rehost reconcile operation id is too long",
            ));
        }
        if let Some(source) = self.source.as_ref() {
            source.validate_complete_fence()?;
            if source.stop_id() != format!("managed_rehost_stop_{}", self.operation_id) {
                return Err(RuntimeContractError::new(
                    "managed rehost reconcile source stop id changed",
                ));
            }
        } else {
            validate_identifier(
                &self.source_session_id,
                "managed rehost reconcile source session id",
            )?;
            validate_identifier(
                &self.source_workspace_id,
                "managed rehost reconcile source workspace id",
            )?;
        }
        if let Some(provider_id) = self.expected_provider_id.as_deref() {
            validate_identifier(provider_id, "managed rehost reconcile provider id")?;
        }
        if let Some(conversation_id) = self.expected_conversation_id.as_deref() {
            validate_opaque_identity(conversation_id, "managed rehost reconcile conversation id")?;
        }
        if let Some(reference) = self.expected_replacement_launch_reference.as_deref() {
            validate_opaque_identity(reference, "managed rehost reconcile launch reference")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostReceipt {
    schema: String,
    schema_version: u16,
    operation_id: String,
    #[serde(
        serialize_with = "serialize_managed_stop_receipt_for_rehost",
        deserialize_with = "deserialize_managed_stop_receipt_for_rehost"
    )]
    source_stop_receipt: ManagedStopReceipt,
    #[serde(
        serialize_with = "serialize_managed_create_receipt_for_rehost",
        deserialize_with = "deserialize_managed_create_receipt_for_rehost"
    )]
    replacement_receipt: ManagedCreateReceipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_reference: Option<String>,
    replayed: bool,
}

fn canonical_u64_decimal(value: &str) -> Option<u64> {
    let parsed = value.parse::<u64>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn serialize_managed_stop_receipt_for_rehost<S>(
    receipt: &ManagedStopReceipt,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let mut value = serde_json::to_value(receipt).map_err(serde::ser::Error::custom)?;
    value["channelEpoch"] = serde_json::Value::String(receipt.channel_epoch().to_string());
    value.serialize(serializer)
}

fn deserialize_managed_stop_receipt_for_rehost<'de, D>(
    deserializer: D,
) -> Result<ManagedStopReceipt, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut value = serde_json::Value::deserialize(deserializer)?;
    let encoded = value
        .get("channelEpoch")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            serde::de::Error::custom(
                "managed rehost source channelEpoch must be a canonical decimal string",
            )
        })?;
    let epoch = canonical_u64_decimal(encoded).ok_or_else(|| {
        serde::de::Error::custom(
            "managed rehost source channelEpoch must be a canonical decimal u64 string",
        )
    })?;
    value["channelEpoch"] = serde_json::Value::Number(epoch.into());
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

fn serialize_managed_create_receipt_for_rehost<S>(
    receipt: &ManagedCreateReceipt,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let mut value = serde_json::to_value(receipt).map_err(serde::ser::Error::custom)?;
    let fence = receipt.generation_fence().ok_or_else(|| {
        serde::ser::Error::custom("managed rehost replacement receipt has no generation fence")
    })?;
    value["generationFence"]["channelEpoch"] =
        serde_json::Value::String(fence.channel_epoch().to_string());
    value.serialize(serializer)
}

fn deserialize_managed_create_receipt_for_rehost<'de, D>(
    deserializer: D,
) -> Result<ManagedCreateReceipt, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut value = serde_json::Value::deserialize(deserializer)?;
    let encoded = value
        .get("generationFence")
        .and_then(|fence| fence.get("channelEpoch"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            serde::de::Error::custom(
                "managed rehost replacement channelEpoch must be a canonical decimal string",
            )
        })?;
    let epoch = canonical_u64_decimal(encoded).ok_or_else(|| {
        serde::de::Error::custom(
            "managed rehost replacement channelEpoch must be a canonical decimal u64 string",
        )
    })?;
    value["generationFence"]["channelEpoch"] = serde_json::Value::Number(epoch.into());
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

impl ManagedRehostReceipt {
    pub fn new(
        request: &ManagedRehostRequest,
        source_stop_receipt: ManagedStopReceipt,
        replacement_receipt: ManagedCreateReceipt,
        conversation_id: impl Into<String>,
        launch_reference: Option<String>,
        replayed: bool,
    ) -> Result<Self, RuntimeContractError> {
        let receipt = Self {
            schema: MANAGED_REHOST_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_SCHEMA_VERSION,
            operation_id: request.operation_id.clone(),
            source_stop_receipt,
            replacement_receipt,
            conversation_id: Some(conversation_id.into()),
            launch_reference,
            replayed,
        };
        receipt.validate_against(request)?;
        Ok(receipt)
    }

    pub fn new_fresh(
        request: &ManagedRehostRequest,
        source_stop_receipt: ManagedStopReceipt,
        replacement_receipt: ManagedCreateReceipt,
        launch_reference: Option<String>,
        replayed: bool,
    ) -> Result<Self, RuntimeContractError> {
        let receipt = Self {
            schema: MANAGED_REHOST_FRESH_RECEIPT_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_FRESH_RECEIPT_SCHEMA_VERSION,
            operation_id: request.operation_id.clone(),
            source_stop_receipt,
            replacement_receipt,
            conversation_id: None,
            launch_reference,
            replayed,
        };
        receipt.validate_against(request)?;
        Ok(receipt)
    }

    #[must_use]
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    #[must_use]
    pub fn source_stop_receipt(&self) -> &ManagedStopReceipt {
        &self.source_stop_receipt
    }

    #[must_use]
    pub fn replacement_receipt(&self) -> &ManagedCreateReceipt {
        &self.replacement_receipt
    }

    #[must_use]
    pub fn conversation_id(&self) -> Option<&str> {
        self.conversation_id.as_deref()
    }

    #[must_use]
    pub fn launch_reference(&self) -> Option<&str> {
        self.launch_reference.as_deref()
    }

    #[must_use]
    pub fn replayed(&self) -> bool {
        self.replayed
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let exact = self.schema == MANAGED_REHOST_SCHEMA
            && self.schema_version == MANAGED_REHOST_SCHEMA_VERSION
            && self.conversation_id.is_some();
        let fresh = self.schema == MANAGED_REHOST_FRESH_RECEIPT_SCHEMA
            && self.schema_version == MANAGED_REHOST_FRESH_RECEIPT_SCHEMA_VERSION
            && self.conversation_id.is_none();
        if !exact && !fresh {
            return Err(RuntimeContractError::new(
                "managed rehost receipt has an unsupported schema",
            ));
        }
        validate_identifier(&self.operation_id, "managed rehost receipt operation id")?;
        self.source_stop_receipt.validate()?;
        self.replacement_receipt.validate()?;
        if self.replacement_receipt.generation_fence().is_none() {
            return Err(RuntimeContractError::new(
                "managed rehost replacement receipt has no generation fence",
            ));
        }
        if let Some(conversation_id) = self.conversation_id.as_deref() {
            validate_opaque_identity(conversation_id, "managed rehost conversation id")?;
        }
        if let Some(reference) = self.launch_reference.as_deref() {
            validate_opaque_identity(reference, "managed rehost launch reference")?;
        }
        if self.source_stop_receipt.session_id() == self.replacement_receipt.session_id()
            || self.source_stop_receipt.workspace_id() != self.replacement_receipt.workspace_id()
        {
            return Err(RuntimeContractError::new(
                "managed rehost receipt changed source or replacement identity",
            ));
        }
        Ok(())
    }

    pub fn validate_against(
        &self,
        request: &ManagedRehostRequest,
    ) -> Result<(), RuntimeContractError> {
        self.validate()?;
        request.validate()?;
        if self.operation_id != request.operation_id
            || self.source_stop_receipt.stop_id() != request.source.stop_id()
            || self.source_stop_receipt.session_id() != request.source.session_id()
            || self.source_stop_receipt.workspace_id() != request.source.workspace_id()
            || request.is_fresh_replacement() != self.conversation_id.is_none()
        {
            return Err(RuntimeContractError::new(
                "managed rehost receipt does not match the operation identity",
            ));
        }
        // Once the runtime says this receipt is a journal replay, the durable
        // operation + source session/workspace owns every destructive input.
        // A retrying client may have stale or changed build/fence/hint state.
        if self.replayed {
            return Ok(());
        }
        if self.source_stop_receipt.runner_principal()
            != request
                .source
                .expected_runner_principal()
                .unwrap_or_default()
            || self.source_stop_receipt.runner_instance()
                != request
                    .source
                    .expected_runner_instance()
                    .unwrap_or_default()
            || Some(self.source_stop_receipt.channel_epoch())
                != request.source.expected_channel_epoch()
            || self.source_stop_receipt.host_instance_id()
                != request
                    .source
                    .expected_host_instance_id()
                    .unwrap_or_default()
            || self.source_stop_receipt.terminal_epoch()
                != request.source.expected_terminal_epoch().unwrap_or_default()
        {
            return Err(RuntimeContractError::new(
                "managed rehost receipt does not match the exact admitted source",
            ));
        }
        if request
            .expected_provider_id
            .as_deref()
            .is_some_and(|expected| expected != self.replacement_receipt.provider_id())
            || request
                .expected_conversation_id
                .as_deref()
                .is_some_and(|expected| Some(expected) != self.conversation_id.as_deref())
            || request.replacement.is_none()
                && request.expected_launch_reference != self.launch_reference
                && request.expected_launch_reference.is_some()
            || request.replacement.as_ref().is_some_and(|replacement| {
                replacement.launch_reference.as_deref() != self.launch_reference.as_deref()
            })
        {
            return Err(RuntimeContractError::new(
                "managed rehost receipt does not match the exact request",
            ));
        }
        Ok(())
    }

    pub fn validate_against_reconcile(
        &self,
        request: &ManagedRehostReconcileRequest,
    ) -> Result<(), RuntimeContractError> {
        self.validate()?;
        request.validate()?;
        if self.operation_id != request.operation_id()
            || self.source_stop_receipt.session_id() != request.source_session_id()
            || self.source_stop_receipt.workspace_id() != request.source_workspace_id()
        {
            return Err(RuntimeContractError::new(
                "managed rehost receipt does not match the reconciliation operation identity",
            ));
        }
        if let Some(source) = request.source() {
            if self.source_stop_receipt.stop_id() != source.stop_id()
                || self.source_stop_receipt.runner_principal()
                    != source.expected_runner_principal().unwrap_or_default()
                || self.source_stop_receipt.runner_instance()
                    != source.expected_runner_instance().unwrap_or_default()
                || Some(self.source_stop_receipt.channel_epoch()) != source.expected_channel_epoch()
                || self.source_stop_receipt.host_instance_id()
                    != source.expected_host_instance_id().unwrap_or_default()
                || self.source_stop_receipt.terminal_epoch()
                    != source.expected_terminal_epoch().unwrap_or_default()
            {
                return Err(RuntimeContractError::new(
                    "managed rehost receipt does not match the reconciled source generation",
                ));
            }
        }
        Ok(())
    }
}

/// Complete generation projected for clients that cannot safely represent a
/// JavaScript-sized `u64`. `channelEpoch` is always the canonical base-10 u64
/// spelling and never a JSON number.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostGeneration {
    session_id: String,
    workspace_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
}

impl ManagedRehostGeneration {
    fn from_source(receipt: &ManagedStopReceipt) -> Result<Self, RuntimeContractError> {
        receipt.validate()?;
        let generation = Self {
            session_id: receipt.session_id().to_string(),
            workspace_id: receipt.workspace_id().to_string(),
            runner_principal: receipt.runner_principal().to_string(),
            runner_instance: receipt.runner_instance().to_string(),
            channel_epoch: receipt.channel_epoch().to_string(),
            host_instance_id: receipt.host_instance_id().to_string(),
            terminal_epoch: receipt.terminal_epoch().to_string(),
        };
        generation.validate()?;
        Ok(generation)
    }

    fn from_replacement(receipt: &ManagedCreateReceipt) -> Result<Self, RuntimeContractError> {
        receipt.validate()?;
        let fence = receipt.generation_fence().ok_or_else(|| {
            RuntimeContractError::new("managed rehost replacement receipt has no generation fence")
        })?;
        let generation = Self {
            session_id: receipt.session_id().to_string(),
            workspace_id: receipt.workspace_id().to_string(),
            runner_principal: fence.runner_principal().to_string(),
            runner_instance: fence.runner_instance().to_string(),
            channel_epoch: fence.channel_epoch().to_string(),
            host_instance_id: fence.host_instance_id().to_string(),
            terminal_epoch: fence.terminal_epoch().to_string(),
        };
        generation.validate()?;
        Ok(generation)
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn runner_principal(&self) -> &str {
        &self.runner_principal
    }

    #[must_use]
    pub fn runner_instance(&self) -> &str {
        &self.runner_instance
    }

    #[must_use]
    pub fn channel_epoch(&self) -> &str {
        &self.channel_epoch
    }

    #[must_use]
    pub fn host_instance_id(&self) -> &str {
        &self.host_instance_id
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        validate_identifier(&self.session_id, "managed rehost generation session id")?;
        validate_identifier(&self.workspace_id, "managed rehost generation workspace id")?;
        validate_identifier(
            &self.runner_principal,
            "managed rehost generation runner principal",
        )?;
        validate_identifier(
            &self.runner_instance,
            "managed rehost generation runner instance",
        )?;
        if canonical_u64_decimal(&self.channel_epoch).is_none() {
            return Err(RuntimeContractError::new(
                "managed rehost generation channel epoch is not a canonical decimal u64 string",
            ));
        }
        validate_identifier(
            &self.host_instance_id,
            "managed rehost generation Host instance id",
        )?;
        validate_identifier(
            &self.terminal_epoch,
            "managed rehost generation terminal epoch",
        )
    }
}

/// Final provider-neutral launch coordinate retained by a managed rehost edge.
/// The provider and permission mode remain sibling resolution fields; this
/// value distinguishes known provider-default/referenced launches and
/// fresh/exact conversation selections.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRehostLaunchIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

impl ManagedRehostLaunchIdentity {
    pub fn new(
        launch_reference: Option<String>,
        conversation_id: Option<String>,
    ) -> Result<Self, RuntimeContractError> {
        let identity = Self {
            launch_reference,
            conversation_id,
        };
        identity.validate()?;
        Ok(identity)
    }

    #[must_use]
    pub fn launch_reference(&self) -> Option<&str> {
        self.launch_reference.as_deref()
    }

    #[must_use]
    pub fn conversation_id(&self) -> Option<&str> {
        self.conversation_id.as_deref()
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if let Some(reference) = self.launch_reference.as_deref() {
            validate_opaque_identity(reference, "managed rehost resolution launch reference")?;
        }
        if let Some(conversation_id) = self.conversation_id.as_deref() {
            validate_opaque_identity(conversation_id, "managed rehost resolution conversation id")?;
        }
        Ok(())
    }
}

/// Durable retired-source to latest-known managed generation mapping. A chain
/// can contain several exact rehosts; every adjacent fence is validated before
/// the final generation is exposed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostResolution {
    schema: String,
    schema_version: u16,
    state: String,
    operation_ids: Vec<String>,
    source_generation: ManagedRehostGeneration,
    current_generation: ManagedRehostGeneration,
    provider_id: String,
    permission_mode: PermissionMode,
    /// Missing when the prepared launch identity was not retained, including
    /// legacy and adapter-owned edges. An empty object is the known
    /// provider-default/fresh identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_identity: Option<ManagedRehostLaunchIdentity>,
}

impl ManagedRehostResolution {
    pub fn from_receipts(
        operation_id: impl Into<String>,
        source: &ManagedStopReceipt,
        replacement: &ManagedCreateReceipt,
    ) -> Result<Self, RuntimeContractError> {
        Self::from_receipts_with_launch_identity(operation_id, source, replacement, None)
    }

    pub fn from_receipts_with_launch_identity(
        operation_id: impl Into<String>,
        source: &ManagedStopReceipt,
        replacement: &ManagedCreateReceipt,
        launch_identity: Option<ManagedRehostLaunchIdentity>,
    ) -> Result<Self, RuntimeContractError> {
        let resolution = Self {
            schema: MANAGED_REHOST_RESOLUTION_SCHEMA.to_string(),
            schema_version: MANAGED_REHOST_RESOLUTION_SCHEMA_VERSION,
            state: "resolved".to_string(),
            operation_ids: vec![operation_id.into()],
            source_generation: ManagedRehostGeneration::from_source(source)?,
            current_generation: ManagedRehostGeneration::from_replacement(replacement)?,
            provider_id: replacement.provider_id().to_string(),
            permission_mode: replacement.permission_mode(),
            launch_identity,
        };
        resolution.validate()?;
        Ok(resolution)
    }

    pub fn append(
        &mut self,
        operation_id: impl Into<String>,
        source: &ManagedStopReceipt,
        replacement: &ManagedCreateReceipt,
    ) -> Result<(), RuntimeContractError> {
        let next_source = ManagedRehostGeneration::from_source(source)?;
        if self.current_generation != next_source {
            return Err(RuntimeContractError::new(
                "managed rehost resolution chain changed generation",
            ));
        }
        self.operation_ids.push(operation_id.into());
        self.current_generation = ManagedRehostGeneration::from_replacement(replacement)?;
        self.provider_id = replacement.provider_id().to_string();
        self.permission_mode = replacement.permission_mode();
        self.launch_identity = None;
        self.validate()
    }

    /// Appends one already-validated durable successor edge.
    ///
    /// Compacted successor indexes retain the public resolution contract, not
    /// private stop/create receipts. Joining two resolution edges here keeps
    /// the exact adjacent-generation check in the contract type instead of
    /// making each storage reader reconstruct it independently.
    pub fn append_resolution(
        &mut self,
        next: &ManagedRehostResolution,
    ) -> Result<(), RuntimeContractError> {
        self.validate()?;
        next.validate()?;
        if self.current_generation != next.source_generation {
            return Err(RuntimeContractError::new(
                "managed rehost resolution chain changed generation",
            ));
        }
        self.operation_ids
            .extend(next.operation_ids.iter().cloned());
        self.current_generation = next.current_generation.clone();
        self.provider_id = next.provider_id.clone();
        self.permission_mode = next.permission_mode;
        self.launch_identity = next.launch_identity.clone();
        self.validate()
    }

    /// Enriches an otherwise identical durable resolution with an additive
    /// launch identity. This lets a retained journal repair an unknown
    /// compacted edge while still failing closed when known identities disagree.
    pub fn merge_compatible(
        &mut self,
        other: &ManagedRehostResolution,
    ) -> Result<bool, RuntimeContractError> {
        self.validate()?;
        other.validate()?;
        if self.schema != other.schema
            || self.schema_version != other.schema_version
            || self.state != other.state
            || self.operation_ids != other.operation_ids
            || self.source_generation != other.source_generation
            || self.current_generation != other.current_generation
            || self.provider_id != other.provider_id
            || self.permission_mode != other.permission_mode
        {
            return Err(RuntimeContractError::new(
                "managed rehost resolutions changed durable lineage",
            ));
        }
        match other.launch_identity.as_ref() {
            Some(incoming) => self.merge_launch_identity(incoming),
            None => Ok(false),
        }
    }

    /// Adds the separately retained launch coordinate to an exact lineage
    /// projection. A known coordinate is immutable once observed.
    pub fn merge_launch_identity(
        &mut self,
        incoming: &ManagedRehostLaunchIdentity,
    ) -> Result<bool, RuntimeContractError> {
        incoming.validate()?;
        match self.launch_identity.as_ref() {
            Some(current) if current != incoming => Err(RuntimeContractError::new(
                "managed rehost resolution launch identity changed",
            )),
            None => {
                self.launch_identity = Some(incoming.clone());
                Ok(true)
            }
            Some(_) => Ok(false),
        }
    }

    /// Projects only the v1 successor lineage. Launch identity has a separate
    /// forward-compatible durable index so older v1 writers cannot erase it
    /// while rewriting a shared lineage shard.
    #[must_use]
    pub fn lineage_projection(&self) -> Self {
        let mut projection = self.clone();
        projection.launch_identity = None;
        projection
    }

    #[must_use]
    pub fn operation_ids(&self) -> &[String] {
        &self.operation_ids
    }

    #[must_use]
    pub fn source_generation(&self) -> &ManagedRehostGeneration {
        &self.source_generation
    }

    #[must_use]
    pub fn current_generation(&self) -> &ManagedRehostGeneration {
        &self.current_generation
    }

    #[must_use]
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    #[must_use]
    pub fn permission_mode(&self) -> PermissionMode {
        self.permission_mode
    }

    #[must_use]
    pub fn launch_identity(&self) -> Option<&ManagedRehostLaunchIdentity> {
        self.launch_identity.as_ref()
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        if self.schema != MANAGED_REHOST_RESOLUTION_SCHEMA
            || self.schema_version != MANAGED_REHOST_RESOLUTION_SCHEMA_VERSION
            || self.state != "resolved"
            || self.operation_ids.is_empty()
            || self.operation_ids.len() > 256
        {
            return Err(RuntimeContractError::new(
                "managed rehost resolution has an unsupported schema",
            ));
        }
        for operation_id in &self.operation_ids {
            validate_identifier(operation_id, "managed rehost resolution operation id")?;
            if operation_id.len() > MAX_MANAGED_REHOST_OPERATION_ID_BYTES {
                return Err(RuntimeContractError::new(
                    "managed rehost resolution operation id is too large",
                ));
            }
        }
        self.source_generation.validate()?;
        self.current_generation.validate()?;
        validate_identifier(&self.provider_id, "managed rehost resolution provider id")?;
        if let Some(identity) = self.launch_identity.as_ref() {
            identity.validate()?;
        }
        if self.source_generation.workspace_id != self.current_generation.workspace_id
            || self.source_generation.session_id == self.current_generation.session_id
        {
            return Err(RuntimeContractError::new(
                "managed rehost resolution changed workspace or retained the source session",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRehostFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "payload", rename_all = "snake_case")]
pub enum ManagedRehostBrokerResponse {
    Completed(Box<ManagedRehostReceipt>),
    Refused(ManagedRehostFailure),
}

impl ManagedRehostBrokerResponse {
    #[must_use]
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused(ManagedRehostFailure {
            code: code.into(),
            message: message.into(),
        })
    }
}

pub fn read_standalone_create_request(
    reader: &mut impl Read,
) -> Result<StandaloneCreateRequest, RuntimeContractError> {
    let request: StandaloneCreateRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn write_standalone_create_response(
    writer: &mut impl Write,
    response: &StandaloneCreateBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn read_managed_attach_request(
    reader: &mut impl Read,
) -> Result<ManagedAttachRequest, RuntimeContractError> {
    let request: ManagedAttachRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn read_managed_agent_state_report_request(
    reader: &mut impl Read,
) -> Result<ManagedAgentStateReportRequest, RuntimeContractError> {
    let request: ManagedAgentStateReportRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn read_managed_create_request(
    reader: &mut impl Read,
) -> Result<ManagedCreateRequest, RuntimeContractError> {
    let request: ManagedCreateRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn write_managed_create_response(
    writer: &mut impl Write,
    response: &ManagedCreateBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn read_managed_create_reconcile_request(
    reader: &mut impl Read,
) -> Result<ManagedCreateReconcileRequest, RuntimeContractError> {
    let request: ManagedCreateReconcileRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn write_managed_create_reconcile_response(
    writer: &mut impl Write,
    response: &ManagedCreateReconcileBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn read_managed_create_advance_request(
    reader: &mut impl Read,
) -> Result<ManagedCreateAdvanceRequest, RuntimeContractError> {
    let request: ManagedCreateAdvanceRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn write_managed_create_advance_response(
    writer: &mut impl Write,
    response: &ManagedCreateAdvanceBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn read_managed_create_chain_stop_request(
    reader: &mut impl Read,
) -> Result<ManagedCreateReconcileRequest, RuntimeContractError> {
    read_managed_create_reconcile_request(reader)
}

pub fn write_managed_create_chain_stop_response(
    writer: &mut impl Write,
    response: &ManagedCreateChainStopBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn write_managed_create_chain_stop_response_v2(
    writer: &mut impl Write,
    response: &ManagedCreateChainStopBrokerResponseV2,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn write_managed_attach_response(
    writer: &mut impl Write,
    response: &ManagedAttachBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn write_managed_agent_state_report_response(
    writer: &mut impl Write,
    response: &ManagedAgentStateReportBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn read_managed_stop_request(
    reader: &mut impl Read,
) -> Result<ManagedStopRequest, RuntimeContractError> {
    let request: ManagedStopRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn read_managed_stop_reconcile_request(
    reader: &mut impl Read,
) -> Result<ManagedStopReconcileRequest, RuntimeContractError> {
    let request: ManagedStopReconcileRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn write_managed_stop_response(
    writer: &mut impl Write,
    response: &ManagedStopBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn read_managed_rehost_request(
    reader: &mut impl Read,
) -> Result<ManagedRehostRequest, RuntimeContractError> {
    let request: ManagedRehostRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn read_managed_rehost_reconcile_request(
    reader: &mut impl Read,
) -> Result<ManagedRehostReconcileRequest, RuntimeContractError> {
    let request: ManagedRehostReconcileRequest = read_json_frame(reader)?;
    request.validate()?;
    Ok(request)
}

pub fn write_managed_rehost_response(
    writer: &mut impl Write,
    response: &ManagedRehostBrokerResponse,
) -> Result<(), RuntimeContractError> {
    write_json_frame(writer, response)
}

pub fn read_managed_attach_finalization(
    reader: &mut impl Read,
    expected_transaction_id: &str,
) -> Result<ManagedAttachFinalization, RuntimeContractError> {
    let finalization: ManagedAttachFinalization = read_json_frame(reader)?;
    finalization.validate()?;
    if finalization.transaction_id != expected_transaction_id {
        return Err(RuntimeContractError::new(
            "managed attach finalization transaction does not match preparation",
        ));
    }
    Ok(finalization)
}

pub fn write_managed_attach_finalization(
    writer: &mut impl Write,
    finalization: &ManagedAttachFinalization,
) -> Result<(), RuntimeContractError> {
    finalization.validate()?;
    write_json_frame(writer, finalization)
}

fn validate_identifier(value: &str, name: &str) -> Result<(), RuntimeContractError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.chars().any(char::is_control)
    {
        return Err(RuntimeContractError::new(format!("{name} is invalid")));
    }
    Ok(())
}

fn validate_opaque_identity(value: &str, name: &str) -> Result<(), RuntimeContractError> {
    validate_identifier(value, name)?;
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
    }) {
        return Err(RuntimeContractError::new(format!("{name} is invalid")));
    }
    Ok(())
}

fn validate_command(command: &[String], name: &str) -> Result<(), RuntimeContractError> {
    if command.is_empty()
        || command.len() > MAX_COMMAND_ARGUMENTS
        || command.iter().any(|argument| {
            argument.is_empty()
                || argument.len() > MAX_COMMAND_ARGUMENT_BYTES
                || argument.contains('\0')
        })
    {
        return Err(RuntimeContractError::new(format!(
            "{name} command is invalid"
        )));
    }
    Ok(())
}

pub fn write_json_frame(
    writer: &mut impl Write,
    value: &impl Serialize,
) -> Result<(), RuntimeContractError> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| RuntimeContractError::new(format!("could not encode frame: {error}")))?;
    if payload.is_empty() || payload.len() > MAX_BROKER_FRAME_BYTES {
        return Err(RuntimeContractError::new(
            "standalone create broker frame is too large",
        ));
    }
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush())
        .map_err(|error| RuntimeContractError::new(format!("could not write frame: {error}")))
}

pub fn read_json_frame<T: DeserializeOwned>(
    reader: &mut impl Read,
) -> Result<T, RuntimeContractError> {
    let mut declared = [0_u8; 4];
    reader.read_exact(&mut declared).map_err(|error| {
        RuntimeContractError::new(format!("could not read frame length: {error}"))
    })?;
    let length = u32::from_be_bytes(declared) as usize;
    if length == 0 || length > MAX_BROKER_FRAME_BYTES {
        return Err(RuntimeContractError::new(
            "standalone create broker frame length is invalid",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| RuntimeContractError::new(format!("could not read frame: {error}")))?;
    serde_json::from_slice(&payload)
        .map_err(|error| RuntimeContractError::new(format!("could not decode frame: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_agent_state_report_broker_preserves_the_exact_source_fence() {
        let fence = SessionFence {
            workspace_id: "workspace-1".into(),
            session_id: "session-1".into(),
            runner_principal: "local-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 7,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        };
        let request = ManagedAgentStateReportRequest::new(
            fence.clone(),
            AgentStateReport {
                request_id: "turn-0199aaaa-bbbb-7ac2".into(),
                identity_only: false,
                activity: hmux_session_protocol::AgentRuntimeActivity::Working,
                attention: hmux_session_protocol::AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: Some(hmux_session_protocol::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
                conversation_identity: Some(
                    hmux_session_protocol::ProviderConversationIdentityReport {
                        provider_id: "codex".into(),
                        conversation_id: "conversation-1".into(),
                        previous_conversation_id: None,
                        expected_fence: None,
                    },
                ),
                expected_observation: None,
            },
        )
        .unwrap();
        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["schemaVersion"], 1);
        assert!(encoded["report"].get("causality").is_none());
        assert!(encoded.get("sessionId").is_none());
        assert!(encoded.get("workspaceId").is_none());
        assert!(
            encoded["report"]["conversation_identity"]
                .get("expected_fence")
                .is_none()
        );
        assert_eq!(encoded["expectedFence"]["channel_epoch"], "7");
        assert_eq!(
            encoded["report"]["working_ttl_ms"],
            hmux_session_protocol::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS.to_string()
        );

        let mut framed = Vec::new();
        write_json_frame(&mut framed, &request).unwrap();
        assert_eq!(
            read_managed_agent_state_report_request(&mut framed.as_slice()).unwrap(),
            request
        );

        let mut causal = request.clone();
        causal.report.causality = Some(hmux_session_protocol::AgentStateReportCausality {
            sequence: 17,
            work_id: Some("current-work".into()),
        });
        assert!(
            causal.validate().is_err(),
            "v1 must not silently erase causality"
        );
        causal.schema_version = MANAGED_AGENT_STATE_REPORT_CAUSAL_SCHEMA_VERSION;
        causal.validate().unwrap();
        let mut causal_frame = Vec::new();
        write_json_frame(&mut causal_frame, &causal).unwrap();
        assert_eq!(
            read_managed_agent_state_report_request(&mut causal_frame.as_slice()).unwrap(),
            causal
        );
        causal.report.causality = None;
        assert!(
            causal.validate().is_err(),
            "v2 requires its causal envelope"
        );

        let mut malformed = encoded;
        malformed["expectedFence"]["channel_epoch"] = serde_json::json!(7);
        let mut malformed_frame = Vec::new();
        write_json_frame(&mut malformed_frame, &malformed).unwrap();
        assert!(read_managed_agent_state_report_request(&mut malformed_frame.as_slice()).is_err());
    }

    #[test]
    fn viewport_projection_selects_one_exact_base_profile() {
        assert!(terminal_capability_request_is_consistent(&[]));
        assert!(!terminal_capability_request_is_consistent(&[
            TERMINAL_INPUT_INTENT_CAPABILITY.to_string()
        ]));
        assert!(terminal_capability_request_is_consistent(&[
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            AGENT_PROMPT_CAPABILITY.to_string(),
        ]));
        let binary_only = vec![TERMINAL_STATE_BINARY_CAPABILITY.to_string()];
        assert!(!terminal_capability_request_is_consistent(&binary_only));
        assert_eq!(selected_terminal_base_protocol_minor(&binary_only), None);

        let viewport_only = vec![TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string()];
        assert!(!terminal_capability_request_is_consistent(&viewport_only));
        assert_eq!(selected_terminal_base_protocol_minor(&viewport_only), None);

        let base_surface = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_INPUT_INTENT_CAPABILITY.to_string(),
        ];
        assert!(terminal_capability_request_is_consistent(&base_surface));
        let mut initial_prompt_surface = base_surface[..2].to_vec();
        initial_prompt_surface.push(AGENT_PROMPT_CAPABILITY.to_string());
        initial_prompt_surface.push(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY.to_string());
        assert!(terminal_capability_request_is_consistent(
            &initial_prompt_surface
        ));
        initial_prompt_surface.pop();
        initial_prompt_surface.pop();
        initial_prompt_surface.push(LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY.to_string());
        assert!(terminal_capability_request_is_consistent(
            &initial_prompt_surface
        ));
        let process_observed_without_targeted = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY.to_string(),
        ];
        assert!(!terminal_capability_request_is_consistent(
            &process_observed_without_targeted
        ));
        assert_eq!(
            selected_terminal_base_protocol_minor(&base_surface),
            Some(TERMINAL_STATE_BASE_PROTOCOL_MINOR)
        );
        assert!(!terminal_viewport_multipart_permitted(&base_surface));
        assert!(!terminal_viewport_wheel_permitted(&base_surface));
        for capability in [
            TERMINAL_INPUT_INTENT_CAPABILITY,
            TERMINAL_DEFAULT_COLORS_CAPABILITY,
        ] {
            assert!(terminal_capability_permitted_for_agent_prompt(
                None, capability,
            ));
            assert!(terminal_capability_permitted_for_agent_prompt(
                Some(AgentPromptCapabilitySelection::Targeted),
                capability,
            ));
            assert!(terminal_capability_permitted_for_agent_prompt(
                Some(AgentPromptCapabilitySelection::LegacyFresh),
                capability,
            ));
        }
        for (selection, capability, permitted) in [
            (None, AGENT_PROMPT_CAPABILITY, false),
            (None, LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, false),
            (None, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY, false),
            (
                Some(AgentPromptCapabilitySelection::Targeted),
                AGENT_PROMPT_CAPABILITY,
                true,
            ),
            (
                Some(AgentPromptCapabilitySelection::Targeted),
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
                false,
            ),
            (
                Some(AgentPromptCapabilitySelection::Targeted),
                PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
                true,
            ),
            (
                Some(AgentPromptCapabilitySelection::LegacyFresh),
                AGENT_PROMPT_CAPABILITY,
                false,
            ),
            (
                Some(AgentPromptCapabilitySelection::LegacyFresh),
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
                true,
            ),
            (
                Some(AgentPromptCapabilitySelection::LegacyFresh),
                PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
                false,
            ),
        ] {
            assert_eq!(
                terminal_capability_permitted_for_agent_prompt(selection, capability),
                permitted,
            );
        }

        let current_client = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_INPUT_INTENT_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_MULTIPART_CAPABILITY.to_string(),
        ];
        assert_eq!(
            selected_terminal_base_protocol_minor(&current_client),
            Some(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            "multipart must not raise the envelope minor of pre-existing record kinds",
        );
        assert!(terminal_viewport_multipart_permitted(&current_client));
        assert!(!terminal_viewport_wheel_permitted(&current_client));

        let wheel_client = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_WHEEL_CAPABILITY.to_string(),
        ];
        assert!(terminal_viewport_wheel_permitted(&wheel_client));
        assert!(!terminal_viewport_multipart_permitted(&wheel_client));
        assert_eq!(
            selected_terminal_base_protocol_minor(&wheel_client),
            Some(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            "wheel permission must not raise the envelope minor of ordinary records",
        );

        let all_minor_five_records = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_WHEEL_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_MULTIPART_CAPABILITY.to_string(),
        ];
        assert!(terminal_viewport_wheel_permitted(&all_minor_five_records));
        assert!(terminal_viewport_multipart_permitted(
            &all_minor_five_records
        ));
        assert_eq!(
            selected_terminal_base_protocol_minor(&all_minor_five_records),
            Some(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
        );

        let colors_without_writer = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_DEFAULT_COLORS_CAPABILITY.to_string(),
        ];
        assert!(terminal_capability_request_is_consistent(
            &colors_without_writer
        ));
        assert!(!terminal_default_colors_permitted(&colors_without_writer));

        let color_writer = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_INPUT_INTENT_CAPABILITY.to_string(),
            TERMINAL_DEFAULT_COLORS_CAPABILITY.to_string(),
        ];
        assert!(terminal_default_colors_permitted(&color_writer));
        assert_eq!(
            selected_terminal_base_protocol_minor(&color_writer),
            Some(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            "default colors must not raise the envelope minor of existing records",
        );
    }

    use std::io::Cursor;

    fn retirement_policy() -> SessionRetirementPolicy {
        SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
            grace_period_ms: 5_000,
        }
    }

    fn terminal_default_colors() -> TerminalDefaultColors {
        TerminalDefaultColors::new(0x12_34_56, 0x65_43_21).unwrap()
    }

    #[test]
    fn request_round_trips_through_the_bounded_private_frame() {
        let request = StandaloneCreateRequest::shell(PathBuf::from("/tmp/work"), 24, 80).unwrap();
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &request).unwrap();

        let decoded = read_standalone_create_request(&mut Cursor::new(bytes)).unwrap();

        assert_eq!(decoded, request);
    }

    #[test]
    fn terminal_default_colors_round_trip_through_create_and_resurrection() {
        let request = StandaloneCreateRequest::shell("/tmp/work", 24, 80)
            .unwrap()
            .with_retirement_policy(retirement_policy())
            .unwrap()
            .with_terminal_default_colors(terminal_default_colors())
            .unwrap();
        let request_json = serde_json::to_value(&request).unwrap();
        assert_eq!(request_json["schema"], BROKER_SCHEMA_V3);
        assert_eq!(request_json["schemaVersion"], BROKER_SCHEMA_VERSION_V3);
        assert_eq!(
            request_json["terminalDefaultColors"]["backgroundRgb"],
            0x65_43_21
        );
        let mut encoded = Vec::new();
        write_json_frame(&mut encoded, &request).unwrap();
        assert_eq!(
            read_standalone_create_request(&mut Cursor::new(encoded)).unwrap(),
            request
        );

        let recipe = StandaloneResurrectionRecipe::new("dev", "/tmp/work", Vec::new(), 24, 80, 1)
            .unwrap()
            .with_retirement_policy(retirement_policy())
            .unwrap()
            .with_terminal_default_colors(terminal_default_colors())
            .unwrap();
        let recipe_json = serde_json::to_value(&recipe).unwrap();
        assert_eq!(recipe_json["schema"], RESURRECTION_SCHEMA_V3);
        assert_eq!(recipe_json["schemaVersion"], RESURRECTION_SCHEMA_VERSION_V3);
        let decoded: StandaloneResurrectionRecipe = serde_json::from_value(recipe_json).unwrap();
        decoded.validate().unwrap();
        assert_eq!(decoded, recipe);
    }

    #[test]
    fn standalone_create_retirement_policy_upgrades_roundtrips_and_downgrades_exactly() {
        let legacy = StandaloneCreateRequest::shell("/tmp/work", 24, 80).unwrap();
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert_eq!(legacy_json["schema"], BROKER_SCHEMA_V1);
        assert_eq!(legacy_json["schemaVersion"], BROKER_SCHEMA_VERSION_V1);
        assert!(legacy_json.get("retirementPolicy").is_none());

        let opted_in = legacy
            .clone()
            .with_retirement_policy(retirement_policy())
            .unwrap();
        let opted_in_json = serde_json::to_value(&opted_in).unwrap();
        assert_eq!(opted_in_json["schema"], BROKER_SCHEMA_V2);
        assert_eq!(opted_in_json["schemaVersion"], BROKER_SCHEMA_VERSION_V2);
        assert_eq!(opted_in.retirement_policy(), Some(retirement_policy()));
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &opted_in).unwrap();
        assert_eq!(
            read_standalone_create_request(&mut Cursor::new(bytes)).unwrap(),
            opted_in
        );

        let opted_out = opted_in.with_retirement_policy_option(None).unwrap();
        assert_eq!(opted_out, legacy);
        let opted_out_json = serde_json::to_value(&opted_out).unwrap();
        assert_eq!(opted_out_json["schema"], BROKER_SCHEMA_V1);
        assert_eq!(opted_out_json["schemaVersion"], BROKER_SCHEMA_VERSION_V1);
        assert!(opted_out_json.get("retirementPolicy").is_none());
    }

    #[test]
    fn standalone_create_retirement_schema_pairs_fail_closed() {
        let base = serde_json::json!({
            "providerCwd": "/tmp",
            "sessionName": "dev",
            "command": [],
            "initialRows": 24,
            "initialColumns": 80
        });
        let policy = serde_json::json!({
            "kind": "after_graceful_last_client_departure_v1",
            "grace_period_ms": "5000"
        });
        let cases = [
            serde_json::json!({
                "schema": BROKER_SCHEMA_V1,
                "schemaVersion": BROKER_SCHEMA_VERSION_V1,
                "retirementPolicy": policy,
                "providerCwd": base["providerCwd"],
                "sessionName": base["sessionName"],
                "command": base["command"],
                "initialRows": base["initialRows"],
                "initialColumns": base["initialColumns"]
            }),
            serde_json::json!({
                "schema": BROKER_SCHEMA_V2,
                "schemaVersion": BROKER_SCHEMA_VERSION_V2,
                "providerCwd": base["providerCwd"],
                "sessionName": base["sessionName"],
                "command": base["command"],
                "initialRows": base["initialRows"],
                "initialColumns": base["initialColumns"]
            }),
            serde_json::json!({
                "schema": BROKER_SCHEMA_V2,
                "schemaVersion": BROKER_SCHEMA_VERSION_V1,
                "retirementPolicy": {
                    "kind": "after_graceful_last_client_departure_v1",
                    "grace_period_ms": "5000"
                },
                "providerCwd": base["providerCwd"],
                "sessionName": base["sessionName"],
                "command": base["command"],
                "initialRows": base["initialRows"],
                "initialColumns": base["initialColumns"]
            }),
            serde_json::json!({
                "schema": BROKER_SCHEMA_V2,
                "schemaVersion": BROKER_SCHEMA_VERSION_V2,
                "retirementPolicy": {
                    "kind": "after_graceful_last_client_departure_v1",
                    "grace_period_ms": "999"
                },
                "providerCwd": base["providerCwd"],
                "sessionName": base["sessionName"],
                "command": base["command"],
                "initialRows": base["initialRows"],
                "initialColumns": base["initialColumns"]
            }),
        ];
        for value in cases {
            let request: StandaloneCreateRequest = serde_json::from_value(value).unwrap();
            assert!(request.validate().is_err());
        }

        for policy in [
            serde_json::json!({
                "kind": "after_graceful_last_client_departure_v2",
                "grace_period_ms": "5000"
            }),
            serde_json::json!({
                "kind": "after_graceful_last_client_departure_v1",
                "grace_period_ms": "5000",
                "transport_loss_is_departure": true
            }),
        ] {
            let mut value = serde_json::json!({
                "schema": BROKER_SCHEMA_V2,
                "schemaVersion": BROKER_SCHEMA_VERSION_V2,
                "providerCwd": "/tmp",
                "sessionName": "dev",
                "command": [],
                "initialRows": 24,
                "initialColumns": 80
            });
            value["retirementPolicy"] = policy;
            assert!(serde_json::from_value::<StandaloneCreateRequest>(value).is_err());
        }
    }

    #[test]
    fn recovery_identity_is_additive_private_and_requires_a_named_target() {
        let legacy: StandaloneCreateRequest = serde_json::from_value(serde_json::json!({
            "schema": BROKER_SCHEMA_V1,
            "schemaVersion": BROKER_SCHEMA_VERSION_V1,
            "providerCwd": "/tmp",
            "sessionName": "legacy",
            "command": [],
            "initialRows": 24,
            "initialColumns": 80
        }))
        .unwrap();
        legacy.validate().unwrap();
        assert!(legacy.recovery_identity().is_none());

        let predecessor = PresentationCheckpointPredecessor::new(
            "standalone_source01",
            "runner",
            "runner-1",
            1,
            "host-source",
            "terminal-source",
        )
        .unwrap();
        let identity =
            StandaloneRecoveryCreateIdentity::new("standalone_target01", "private-proof")
                .unwrap()
                .with_source_predecessor(predecessor.clone())
                .unwrap();
        let request =
            StandaloneCreateRequest::new("/tmp", Some("recovery".into()), Vec::new(), 24, 80)
                .unwrap()
                .with_recovery_identity(identity.clone())
                .unwrap();
        let decoded: StandaloneCreateRequest =
            serde_json::from_value(serde_json::to_value(&request).unwrap()).unwrap();
        assert_eq!(decoded.recovery_identity(), Some(&identity));
        let mut expected_public = serde_json::to_value(&request).unwrap();
        expected_public
            .as_object_mut()
            .unwrap()
            .remove("recoveryIdentity");
        let public = request.clone().without_recovery_identity();
        assert!(public.recovery_identity().is_none());
        assert_eq!(serde_json::to_value(public).unwrap(), expected_public);
        assert_eq!(
            decoded
                .recovery_identity()
                .map(StandaloneRecoveryCreateIdentity::recipe_requirement),
            Some(StandaloneRecipeRequirement::Existing)
        );
        assert!(
            serde_json::to_value(&request).unwrap()["recoveryIdentity"]
                .get("recipeRequirement")
                .is_none(),
            "the fail-closed compatibility default must preserve the old wire shape"
        );
        assert_eq!(
            decoded
                .recovery_identity()
                .and_then(StandaloneRecoveryCreateIdentity::source_predecessor),
            Some(&predecessor)
        );
        let configured = request
            .clone()
            .with_retirement_policy_option(Some(retirement_policy()))
            .unwrap();
        assert_eq!(configured.recovery_identity(), Some(&identity));
        assert_eq!(configured.retirement_policy(), Some(retirement_policy()));
        let disabled = configured.with_retirement_policy_option(None).unwrap();
        assert_eq!(disabled.recovery_identity(), Some(&identity));
        assert_eq!(disabled.retirement_policy(), None);
        assert_eq!(
            serde_json::to_value(&disabled).unwrap()["schema"],
            BROKER_SCHEMA_V1
        );
        assert!(!format!("{request:?}").contains("private-proof"));
        let deterministic_fresh =
            StandaloneRecoveryCreateIdentity::new("standalone_fresh01", "fresh-private-proof")
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::InitializeIfAbsent);
        let deterministic_fresh_wire = serde_json::to_value(&deterministic_fresh).unwrap();
        assert_eq!(
            deterministic_fresh_wire["recipeRequirement"],
            "initialize_if_absent"
        );
        assert_eq!(
            serde_json::from_value::<StandaloneRecoveryCreateIdentity>(deterministic_fresh_wire)
                .unwrap()
                .recipe_requirement(),
            StandaloneRecipeRequirement::InitializeIfAbsent
        );
        assert!(!format!("{deterministic_fresh:?}").contains("fresh-private-proof"));
        let request_bound =
            StandaloneRecoveryCreateIdentity::new("standalone_bound01", "bound-private-proof")
                .unwrap()
                .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound);
        let request_bound_wire = serde_json::to_value(&request_bound).unwrap();
        assert_eq!(request_bound_wire["recipeRequirement"], "request_bound");
        assert_eq!(
            serde_json::from_value::<StandaloneRecoveryCreateIdentity>(request_bound_wire)
                .unwrap()
                .recipe_requirement(),
            StandaloneRecipeRequirement::RequestBound
        );
        assert!(
            StandaloneCreateRequest::shell("/tmp", 24, 80)
                .unwrap()
                .with_recovery_identity(identity)
                .is_err()
        );
    }

    #[test]
    fn receipt_debug_redacts_launch_owner_proof() {
        let receipt = StandaloneCreateReceipt::new(
            "standalone_1",
            "workspace_1",
            "shell-1",
            "/tmp/discovery",
            "launch_owner_secret",
        )
        .unwrap();

        let rendered = format!("{receipt:?}");

        assert!(!rendered.contains("launch_owner_secret"));
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn request_rejects_relative_cwd_and_zero_geometry() {
        assert!(StandaloneCreateRequest::shell("relative", 24, 80).is_err());
        assert!(StandaloneCreateRequest::shell("/tmp", 0, 80).is_err());
    }

    #[test]
    fn resurrection_recipe_preserves_shell_vs_explicit_command_policy() {
        let shell = StandaloneResurrectionRecipe::new("dev", "/tmp", Vec::new(), 24, 80, 1)
            .unwrap()
            .with_terminal_environment(
                TerminalEnvironment::new(BTreeMap::from([(
                    "NO_COLOR".to_string(),
                    Some("1".to_string()),
                )]))
                .unwrap(),
            )
            .unwrap();
        let explicit = StandaloneResurrectionRecipe::new(
            "build",
            "/tmp",
            vec!["cargo".into(), "test".into()],
            24,
            80,
            2,
        )
        .unwrap();

        assert!(shell.command().is_empty());
        assert_eq!(
            shell.terminal_environment().values().get("NO_COLOR"),
            Some(&Some("1".to_string()))
        );
        assert_eq!(
            shell.resurrection_replay_policy(),
            StandaloneResurrectionReplayPolicy::SafeInteractiveShell
        );
        assert!(!shell.requires_operator_confirmation());
        assert_eq!(explicit.command(), ["cargo", "test"]);
        assert_eq!(explicit.created_unix_ms(), 2);
        assert!(explicit.requires_operator_confirmation());

        let exact_shell = StandaloneResurrectionRecipe::new(
            "exact-shell",
            "/tmp",
            vec!["/bin/sh".into()],
            24,
            80,
            3,
        )
        .unwrap()
        .with_resurrection_replay_policy(StandaloneResurrectionReplayPolicy::SafeInteractiveShell)
        .unwrap();
        assert!(!exact_shell.requires_operator_confirmation());
        assert!(
            serde_json::to_value(&exact_shell)
                .unwrap()
                .get("resurrectionReplayPolicy")
                .is_some()
        );
    }

    #[test]
    fn resurrection_policy_is_additive_for_existing_recipe_json() {
        let explicit: StandaloneResurrectionRecipe = serde_json::from_value(serde_json::json!({
            "schema": "hmux-standalone-resurrection-v1",
            "schemaVersion": 1,
            "sessionName": "legacy-explicit",
            "providerCwd": "/tmp",
            "command": ["cargo", "test"],
            "initialRows": 24,
            "initialColumns": 80,
            "createdUnixMs": 1
        }))
        .unwrap();
        explicit.validate().unwrap();

        assert_eq!(
            explicit.resurrection_replay_policy(),
            StandaloneResurrectionReplayPolicy::ConfirmExplicitCommand
        );
        assert!(explicit.requires_operator_confirmation());
        assert!(
            StandaloneResurrectionRecipe::new(
                "unsafe-shell",
                "/tmp",
                vec!["/bin/sh".into(), "-c".into(), "echo unsafe".into()],
                24,
                80,
                1,
            )
            .unwrap()
            .with_resurrection_replay_policy(
                StandaloneResurrectionReplayPolicy::SafeInteractiveShell,
            )
            .is_err()
        );
    }

    #[test]
    fn resurrection_retirement_policy_upgrades_roundtrips_and_downgrades_exactly() {
        let legacy =
            StandaloneResurrectionRecipe::new("dev", "/tmp", Vec::new(), 24, 80, 1).unwrap();
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert_eq!(legacy_json["schema"], RESURRECTION_SCHEMA_V1);
        assert_eq!(legacy_json["schemaVersion"], RESURRECTION_SCHEMA_VERSION_V1);
        assert!(legacy_json.get("retirementPolicy").is_none());

        let opted_in = legacy
            .clone()
            .with_retirement_policy(retirement_policy())
            .unwrap();
        let opted_in_json = serde_json::to_value(&opted_in).unwrap();
        assert_eq!(opted_in_json["schema"], RESURRECTION_SCHEMA_V2);
        assert_eq!(
            opted_in_json["schemaVersion"],
            RESURRECTION_SCHEMA_VERSION_V2
        );
        assert_eq!(opted_in.retirement_policy(), Some(retirement_policy()));
        let decoded: StandaloneResurrectionRecipe = serde_json::from_value(opted_in_json).unwrap();
        decoded.validate().unwrap();
        assert_eq!(decoded, opted_in);

        let opted_out = opted_in.with_retirement_policy_option(None).unwrap();
        assert_eq!(opted_out, legacy);
        let opted_out_json = serde_json::to_value(&opted_out).unwrap();
        assert_eq!(opted_out_json["schema"], RESURRECTION_SCHEMA_V1);
        assert_eq!(
            opted_out_json["schemaVersion"],
            RESURRECTION_SCHEMA_VERSION_V1
        );
        assert!(opted_out_json.get("retirementPolicy").is_none());
    }

    #[test]
    fn resurrection_retirement_schema_pairs_fail_closed() {
        let cases = [
            serde_json::json!({
                "schema": RESURRECTION_SCHEMA_V1,
                "schemaVersion": RESURRECTION_SCHEMA_VERSION_V1,
                "sessionName": "dev",
                "providerCwd": "/tmp",
                "command": [],
                "initialRows": 24,
                "initialColumns": 80,
                "retirementPolicy": {
                    "kind": "after_graceful_last_client_departure_v1",
                    "grace_period_ms": "5000"
                },
                "createdUnixMs": 1
            }),
            serde_json::json!({
                "schema": RESURRECTION_SCHEMA_V2,
                "schemaVersion": RESURRECTION_SCHEMA_VERSION_V2,
                "sessionName": "dev",
                "providerCwd": "/tmp",
                "command": [],
                "initialRows": 24,
                "initialColumns": 80,
                "createdUnixMs": 1
            }),
            serde_json::json!({
                "schema": RESURRECTION_SCHEMA_V2,
                "schemaVersion": RESURRECTION_SCHEMA_VERSION_V1,
                "sessionName": "dev",
                "providerCwd": "/tmp",
                "command": [],
                "initialRows": 24,
                "initialColumns": 80,
                "retirementPolicy": {
                    "kind": "after_graceful_last_client_departure_v1",
                    "grace_period_ms": "5000"
                },
                "createdUnixMs": 1
            }),
            serde_json::json!({
                "schema": RESURRECTION_SCHEMA_V2,
                "schemaVersion": RESURRECTION_SCHEMA_VERSION_V2,
                "sessionName": "dev",
                "providerCwd": "/tmp",
                "command": [],
                "initialRows": 24,
                "initialColumns": 80,
                "retirementPolicy": {
                    "kind": "after_graceful_last_client_departure_v1",
                    "grace_period_ms": "300001"
                },
                "createdUnixMs": 1
            }),
        ];
        for value in cases {
            let recipe: StandaloneResurrectionRecipe = serde_json::from_value(value).unwrap();
            assert!(recipe.validate().is_err());
        }

        let unknown = serde_json::json!({
            "schema": RESURRECTION_SCHEMA_V2,
            "schemaVersion": RESURRECTION_SCHEMA_VERSION_V2,
            "sessionName": "dev",
            "providerCwd": "/tmp",
            "command": [],
            "initialRows": 24,
            "initialColumns": 80,
            "retirementPolicy": {
                "kind": "after_graceful_last_client_departure_v2",
                "grace_period_ms": "5000"
            },
            "createdUnixMs": 1
        });
        assert!(serde_json::from_value::<StandaloneResurrectionRecipe>(unknown).is_err());
    }

    #[test]
    fn interactive_profile_removes_only_inherited_no_color() {
        let policy = interactive_terminal_environment_policy(&TerminalEnvironment::default());

        assert_eq!(
            policy.set().get("TERM").map(String::as_str),
            Some(DEFAULT_INTERACTIVE_TERM)
        );
        assert_eq!(
            policy.set().get("COLORTERM").map(String::as_str),
            Some(DEFAULT_INTERACTIVE_COLORTERM)
        );
        assert!(policy.remove().contains("NO_COLOR"));
        assert!(!policy.set().contains_key("FORCE_COLOR"));
        assert!(!policy.remove().contains("FORCE_COLOR"));
    }

    #[test]
    fn explicit_terminal_overrides_win_over_the_profile() {
        let overrides = TerminalEnvironment::new(BTreeMap::from([
            ("TERM".to_string(), Some("screen-256color".to_string())),
            ("COLORTERM".to_string(), None),
            ("NO_COLOR".to_string(), Some("1".to_string())),
        ]))
        .unwrap();

        let policy = interactive_terminal_environment_policy(&overrides);

        assert_eq!(
            policy.set().get("TERM").map(String::as_str),
            Some("screen-256color")
        );
        assert!(policy.remove().contains("COLORTERM"));
        assert_eq!(policy.set().get("NO_COLOR").map(String::as_str), Some("1"));
        assert!(!policy.remove().contains("NO_COLOR"));
    }

    #[test]
    fn terminal_environment_rejects_unrelated_variables() {
        let error = TerminalEnvironment::new(BTreeMap::from([(
            "PATH".to_string(),
            Some("/tmp/bin".to_string()),
        )]))
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "unsupported terminal environment override: PATH"
        );
    }

    #[test]
    fn frame_rejects_an_unbounded_declared_length_before_allocation() {
        let mut bytes = Cursor::new(((MAX_BROKER_FRAME_BYTES + 1) as u32).to_be_bytes());

        let error = read_json_frame::<StandaloneCreateRequest>(&mut bytes).unwrap_err();

        assert_eq!(
            error.to_string(),
            "standalone create broker frame length is invalid"
        );
    }

    #[test]
    fn managed_attach_transaction_requires_matching_finalization() {
        let request = ManagedAttachRequest::new("session_1", "workspace_1").unwrap();
        let mut request_bytes = Vec::new();
        write_json_frame(&mut request_bytes, &request).unwrap();
        assert_eq!(
            read_managed_attach_request(&mut Cursor::new(request_bytes)).unwrap(),
            request
        );

        let commit = ManagedAttachFinalization::commit("transaction_1").unwrap();
        let mut finalization_bytes = Vec::new();
        write_managed_attach_finalization(&mut finalization_bytes, &commit).unwrap();
        let error = read_managed_attach_finalization(
            &mut Cursor::new(finalization_bytes),
            "transaction_other",
        )
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "managed attach finalization transaction does not match preparation"
        );
    }

    #[test]
    fn managed_create_round_trips_a_framed_multibyte_startup_prompt() {
        let prompt = format!("--prompt={}a", "한".repeat((16 * 1024) / 3));
        let request = ManagedCreateRequest::new(
            "spawn_1",
            "session_1",
            "workspace_1",
            "provider",
            PermissionMode::Default,
            "/tmp/work",
            vec!["provider".into(), prompt],
            24,
            80,
        )
        .unwrap();
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &request).unwrap();
        assert_eq!(
            read_managed_create_request(&mut Cursor::new(bytes)).unwrap(),
            request
        );
        for invalid in ["x".repeat(32 * 1024 + 1), "before\0after".into()] {
            assert!(validate_command(&["provider".into(), invalid], "fixture").is_err());
        }
    }

    #[test]
    fn managed_create_round_trips_identity_without_echoing_launch_material_in_receipt() {
        let request = ManagedCreateRequest::new(
            "spawn_1",
            "session_1",
            "workspace_1",
            "codex",
            PermissionMode::BypassApprovals,
            "/tmp/work",
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "secret-launch-material".into(),
            ],
            24,
            80,
        )
        .unwrap()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new("codex", "conversation-1").unwrap(),
        )
        .unwrap();
        let mut request_bytes = Vec::new();
        write_json_frame(&mut request_bytes, &request).unwrap();
        assert_eq!(
            read_managed_create_request(&mut Cursor::new(request_bytes)).unwrap(),
            request
        );
        assert_eq!(
            request
                .conversation_identity()
                .map(ProviderConversationIdentitySeed::conversation_id),
            Some("conversation-1")
        );
        assert!(ProviderConversationIdentitySeed::new("codex", "unsafe;command").is_err());

        let receipt = ManagedCreateReceipt::new(
            "spawn_1",
            "session_1",
            "workspace_1",
            "codex",
            PermissionMode::BypassApprovals,
            "/tmp/discovery",
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new("principal_1", "runner_1", 7, "host_1", "terminal_1")
                .unwrap(),
        )
        .unwrap();
        let encoded = serde_json::to_string(&receipt).unwrap();
        assert!(!encoded.contains("secret-launch-material"));
        assert!(!encoded.contains("credential"));
        assert!(!encoded.contains("CODEX_HOME"));
        assert_eq!(receipt.outcome(), ManagedCreateOutcome::Created);
        let fence = receipt.generation_fence().unwrap();
        assert_eq!(fence.channel_epoch(), 7);
        assert_eq!(fence.terminal_epoch(), "terminal_1");
        assert!(fence.matches_generation("principal_1", "runner_1", "7", "host_1", "terminal_1"));
        assert!(!fence.matches_generation(
            "principal_1",
            "runner_1",
            "7",
            "host_1",
            "terminal_successor"
        ));

        let decoded: ManagedCreateReceipt = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, receipt);

        let legacy = ManagedCreateReceipt::new(
            "spawn_legacy",
            "session_legacy",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/discovery",
            ManagedCreateOutcome::Reused,
        )
        .unwrap();
        assert!(legacy.generation_fence().is_none());
        let legacy_json = serde_json::to_string(&legacy).unwrap();
        let decoded_legacy: ManagedCreateReceipt = serde_json::from_str(&legacy_json).unwrap();
        assert_eq!(decoded_legacy, legacy);
    }

    #[test]
    fn managed_create_reconcile_is_identity_only_and_rejects_a_changed_receipt() {
        let request =
            ManagedCreateReconcileRequest::new("spawn_1", "session_1", "workspace_1").unwrap();
        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded.as_object().unwrap().len(), 5);
        assert!(encoded.get("requestDigest").is_none());
        assert!(encoded.get("providerId").is_none());
        let mut changed = encoded.clone();
        changed
            .as_object_mut()
            .unwrap()
            .insert("requestDigest".into(), serde_json::json!("caller-hint"));
        assert!(serde_json::from_value::<ManagedCreateReconcileRequest>(changed).is_err());
        let mut request_bytes = Vec::new();
        write_json_frame(&mut request_bytes, &request).unwrap();
        assert_eq!(
            read_managed_create_reconcile_request(&mut Cursor::new(request_bytes)).unwrap(),
            request
        );

        let changed = ManagedCreateReceipt::new(
            "spawn_1",
            "another_session",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/discovery",
            ManagedCreateOutcome::Created,
        )
        .unwrap();
        let response = ManagedCreateReconcileBrokerResponse::Completed(Box::new(changed));
        assert!(response.validate_against(&request).is_err());
    }

    #[test]
    fn managed_create_advance_retargets_only_ledger_owned_identity() {
        assert_eq!(
            MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
            "internal-hmux-managed-create-advance-v3"
        );
        let source = ManagedCreateRequest::new(
            "spawn_1",
            "session_1",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into(), "resume".into(), "conversation-1".into()],
            24,
            80,
        )
        .unwrap()
        .with_terminal_environment(
            TerminalEnvironment::new(BTreeMap::from([(
                "TERM".into(),
                Some("xterm-256color".into()),
            )]))
            .unwrap(),
        )
        .unwrap();
        let target = source
            .retarget_identity("spawn_successor", "session_successor")
            .unwrap();
        let mut source_json = serde_json::to_value(&source).unwrap();
        let mut target_json = serde_json::to_value(&target).unwrap();
        for key in ["idempotencyKey", "sessionId"] {
            source_json.as_object_mut().unwrap().remove(key);
            target_json.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(target_json, source_json);

        let replacement = ManagedCreateAdvanceRequest::replace_current(source.clone()).unwrap();
        assert!(replacement.replaces_current());
        let replacement_json = serde_json::to_value(&replacement).unwrap();
        assert_eq!(
            replacement_json["schema"],
            "hmux-managed-create-replace-current-v1"
        );
        assert_eq!(replacement_json["schemaVersion"], 1);
        assert!(replacement_json.get("replaceCurrent").is_none());
        let mut replacement_bytes = Vec::new();
        write_json_frame(&mut replacement_bytes, &replacement).unwrap();
        assert_eq!(
            read_managed_create_advance_request(&mut Cursor::new(replacement_bytes)).unwrap(),
            replacement
        );

        let policy_drift_receipt = ManagedCreateReceipt::new(
            target.idempotency_key(),
            target.session_id(),
            target.workspace_id(),
            target.provider_id(),
            PermissionMode::BypassApprovals,
            "/tmp/discovery",
            ManagedCreateOutcome::Created,
        )
        .unwrap();
        let policy_drift =
            ManagedCreateAdvanceBrokerResponse::Advanced(Box::new(policy_drift_receipt));
        assert!(policy_drift.validate_against(&replacement).is_ok());
        assert!(
            policy_drift
                .validate_against(&ManagedCreateAdvanceRequest::new(source.clone()).unwrap())
                .is_err()
        );

        let request = ManagedCreateAdvanceRequest::new(source).unwrap();
        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["schema"], "hmux-managed-create-advance-v2");
        assert_eq!(encoded["schemaVersion"], 2);
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &request).unwrap();
        assert_eq!(
            read_managed_create_advance_request(&mut Cursor::new(bytes)).unwrap(),
            request
        );

        let mut stale = encoded;
        stale["schema"] = "hmux-managed-create-advance-v1".into();
        stale["schemaVersion"] = 1.into();
        let stale: ManagedCreateAdvanceRequest = serde_json::from_value(stale).unwrap();
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &stale).unwrap();
        assert!(
            read_managed_create_advance_request(&mut Cursor::new(bytes)).is_err(),
            "the v2 destructive route must never accept the legacy request schema",
        );
    }

    #[test]
    fn managed_create_chain_stop_v1_retains_legacy_shape_and_exact_stop_identity() {
        let root = ManagedCreateReconcileRequest::new("create_root", "session_root", "workspace_1")
            .unwrap();
        let effective = ManagedCreateReconcileRequest::new(
            "create_successor",
            "session_successor",
            "workspace_1",
        )
        .unwrap();
        let stop = ManagedStopRequest::new(
            "stop_successor",
            effective.session_id(),
            effective.workspace_id(),
        )
        .unwrap()
        .with_expected_fence("principal_1", "runner_1", 7, "host_1", "terminal_1")
        .unwrap();
        let stop_receipt = ManagedStopReceipt::from_request(
            &stop,
            ManagedStopOutcome::Stopped,
            "managed_provider_stop",
        )
        .unwrap();
        let receipt = ManagedCreateChainStopReceipt::stopped(
            root.clone(),
            effective.clone(),
            stop_receipt.clone(),
        )
        .unwrap();
        receipt.validate_against(&root).unwrap();
        assert_eq!(receipt.root(), &root);
        assert_eq!(receipt.effective(), &effective);
        assert_eq!(receipt.stop_receipt(), Some(&stop_receipt));
        assert_eq!(
            ManagedStopReconcileRequest::from_stop_receipt(&stop_receipt).unwrap(),
            ManagedStopReconcileRequest::from_stop_request(&stop).unwrap(),
            "a durable stop receipt must reconstruct the same exact reconcile authority",
        );

        let response = ManagedCreateChainStopBrokerResponse::Completed(Box::new(receipt));
        response.validate_against(&root).unwrap();
        let encoded = serde_json::to_value(&response).unwrap();
        assert_eq!(
            encoded["payload"]["schema"],
            MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA
        );
        assert_eq!(encoded["payload"]["root"]["idempotencyKey"], "create_root");
        assert_eq!(
            encoded["payload"]["effective"]["sessionId"],
            "session_successor"
        );
        assert_eq!(
            encoded["payload"]["stopReceipt"]["sessionId"],
            "session_successor"
        );

        assert!(encoded["payload"].get("chain").is_none());

        let closed = ManagedCreateChainStopReceipt::closed(root.clone(), root.clone()).unwrap();
        assert!(closed.stop_receipt().is_none());
        assert!(
            closed
                .validate_against(
                    &ManagedCreateReconcileRequest::new(
                        "another_create",
                        "session_root",
                        "workspace_1",
                    )
                    .unwrap(),
                )
                .is_err()
        );
    }

    #[test]
    fn managed_create_chain_stop_v2_retains_ordered_chain_and_projects_to_v1() {
        let ancestor = ManagedCreateReconcileRequest::new(
            "create_ancestor",
            "session_ancestor",
            "workspace_1",
        )
        .unwrap();
        let requested = ManagedCreateReconcileRequest::new(
            "create_requested",
            "session_requested",
            "workspace_1",
        )
        .unwrap();
        let effective = ManagedCreateReconcileRequest::new(
            "create_effective",
            "session_effective",
            "workspace_1",
        )
        .unwrap();
        let stop = ManagedStopRequest::new(
            "stop_successor",
            effective.session_id(),
            effective.workspace_id(),
        )
        .unwrap()
        .with_expected_fence("principal_1", "runner_1", 7, "host_1", "terminal_1")
        .unwrap();
        let stop_receipt = ManagedStopReceipt::from_request(
            &stop,
            ManagedStopOutcome::Stopped,
            "managed_provider_stop",
        )
        .unwrap();
        let receipt = ManagedCreateChainStopReceiptV2::stopped(
            vec![ancestor.clone(), requested.clone(), effective.clone()],
            stop_receipt.clone(),
        )
        .unwrap();
        receipt.validate_against(&requested).unwrap();
        assert_eq!(
            receipt.chain(),
            &[ancestor.clone(), requested.clone(), effective.clone()]
        );

        let response = ManagedCreateChainStopBrokerResponseV2::Completed(Box::new(receipt));
        response.validate_against(&requested).unwrap();
        let encoded = serde_json::to_value(&response).unwrap();
        assert_eq!(
            encoded["payload"]["schema"],
            MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_V2
        );
        assert_eq!(
            encoded["payload"]["schemaVersion"],
            MANAGED_CREATE_CHAIN_STOP_RECEIPT_SCHEMA_VERSION_V2
        );
        assert_eq!(
            encoded["payload"]["chain"][0]["idempotencyKey"],
            "create_ancestor"
        );
        assert_eq!(
            encoded["payload"]["chain"][1]["sessionId"],
            "session_requested"
        );
        assert_eq!(
            encoded["payload"]["chain"][2]["sessionId"],
            "session_effective"
        );
        assert!(encoded["payload"].get("root").is_none());
        assert!(encoded["payload"].get("effective").is_none());

        let legacy = response.legacy_projection(&requested).unwrap();
        let ManagedCreateChainStopBrokerResponse::Completed(legacy) = legacy else {
            panic!("completed v2 response must project to completed v1 response");
        };
        assert_eq!(legacy.root(), &requested);
        assert_eq!(legacy.effective(), &effective);
        assert_eq!(legacy.stop_receipt(), Some(&stop_receipt));

        assert!(
            serde_json::from_value::<ManagedCreateChainStopReceipt>(encoded["payload"].clone())
                .is_err()
        );
        let legacy_encoded = serde_json::to_value(&legacy).unwrap();
        assert!(serde_json::from_value::<ManagedCreateChainStopReceiptV2>(legacy_encoded).is_err());

        let outside =
            ManagedCreateReconcileRequest::new("create_outside", "session_outside", "workspace_1")
                .unwrap();
        assert!(response.validate_against(&outside).is_err());
    }

    #[test]
    fn managed_create_chain_stop_v2_bounds_the_ordered_chain() {
        let chain = (0..=MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES)
            .map(|index| {
                ManagedCreateReconcileRequest::new(
                    format!("create_{index}"),
                    format!("session_{index}"),
                    "workspace_1",
                )
                .unwrap()
            })
            .collect();

        assert!(ManagedCreateChainStopReceiptV2::closed(chain).is_err());
    }

    #[test]
    fn managed_create_chain_stop_v2_maximum_chain_fits_one_broker_frame() {
        fn maximum_escaped_identifier(seed: u16) -> String {
            (0..MAX_IDENTIFIER_BYTES)
                .map(|bit| {
                    if bit < u16::BITS as usize && seed & (1_u16 << bit) != 0 {
                        '"'
                    } else {
                        '\\'
                    }
                })
                .collect()
        }

        let workspace_id = maximum_escaped_identifier(512);
        let chain = (0..MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES)
            .map(|index| {
                ManagedCreateReconcileRequest::new(
                    maximum_escaped_identifier(index as u16),
                    maximum_escaped_identifier(256 + index as u16),
                    workspace_id.clone(),
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        let effective = chain.last().unwrap();
        let stop = ManagedStopRequest::new(
            maximum_escaped_identifier(640),
            effective.session_id(),
            effective.workspace_id(),
        )
        .unwrap()
        .with_expected_fence(
            maximum_escaped_identifier(641),
            maximum_escaped_identifier(642),
            u64::MAX,
            maximum_escaped_identifier(643),
            maximum_escaped_identifier(644),
        )
        .unwrap();
        let stop_receipt = ManagedStopReceipt::from_request(
            &stop,
            ManagedStopOutcome::Stopped,
            "\\".repeat(MAX_STOP_REASON_BYTES),
        )
        .unwrap();
        let response = ManagedCreateChainStopBrokerResponseV2::Completed(Box::new(
            ManagedCreateChainStopReceiptV2::stopped(chain, stop_receipt).unwrap(),
        ));

        let mut frame = Vec::new();
        write_managed_create_chain_stop_response_v2(&mut frame, &response).unwrap();
        let payload_bytes = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(payload_bytes, frame.len() - 4);
        assert!(payload_bytes <= MAX_BROKER_FRAME_BYTES);
    }

    #[test]
    fn remote_managed_create_requires_complete_fence_stop_before_launch() {
        let create = ManagedCreateRequest::new(
            "remote-create",
            "remote-session",
            "remote-workspace",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
        .unwrap();
        let stop = ManagedStopRequest::new("remote-stop", "remote-session", "remote-workspace")
            .unwrap()
            .with_expected_fence(
                "remote-principal",
                "remote-runner",
                7,
                "remote-host",
                "remote-terminal",
            )
            .unwrap();

        let create = serde_json::to_value(create).unwrap();
        let stop = serde_json::to_value(stop).unwrap();
        assert_eq!(create["schema"], "hmux-managed-create-v3");
        assert_eq!(create["schemaVersion"], 3);
        assert_eq!(stop["schemaVersion"], 3);
        assert_eq!(create["requiredManagedStopRequestVersion"], 3);

        let mut downgraded = create;
        downgraded["schemaVersion"] = serde_json::Value::from(1);
        let mut encoded = Vec::new();
        write_json_frame(&mut encoded, &downgraded).unwrap();
        assert!(read_managed_create_request(&mut Cursor::new(encoded)).is_err());
    }

    #[test]
    fn managed_create_can_require_conversation_fenced_stop_before_launch() {
        let create = ManagedCreateRequest::new(
            "conversation-create",
            "conversation-session",
            "conversation-workspace",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        .expect("a current create must negotiate its eventual v5 stop before launch");

        let encoded = serde_json::to_value(&create).unwrap();
        assert_eq!(encoded["schema"], "hmux-managed-create-v3");
        assert_eq!(encoded["schemaVersion"], 3);
        assert_eq!(encoded["requiredManagedStopRequestVersion"], 5);
        assert!(create.requires_managed_stop_lifecycle_contract());
    }

    #[test]
    fn persisted_quiescent_rehost_recipe_remains_decodable_for_ledger_upgrade() {
        let current = ManagedCreateRequest::new(
            "quiescent-create",
            "quiescent-session",
            "quiescent-workspace",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "codex".into(),
                    "resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let source = ManagedRehostSourceRecipe::from_create_request(&current)
            .unwrap()
            .unwrap();
        let mut persisted = serde_json::to_value(source).unwrap();
        persisted["requiredManagedStopRequestVersion"] =
            MANAGED_STOP_QUIESCENT_REQUEST_VERSION.into();
        let persisted: ManagedRehostSourceRecipe = serde_json::from_value(persisted).unwrap();

        persisted
            .validate()
            .expect("a persisted v4 source recipe must remain valid during ledger upgrade");
        assert_eq!(
            persisted.required_managed_stop_request_version(),
            MANAGED_STOP_QUIESCENT_REQUEST_VERSION
        );

        let mut fresh = serde_json::to_value(current).unwrap();
        fresh["requiredManagedStopRequestVersion"] = MANAGED_STOP_QUIESCENT_REQUEST_VERSION.into();
        let fresh: ManagedCreateRequest = serde_json::from_value(fresh).unwrap();
        assert_eq!(
            fresh.validate().unwrap_err().to_string(),
            "managed create request has an unsupported schema",
            "quiescent compatibility belongs only to retained source recipes",
        );
    }

    #[test]
    fn managed_create_carries_only_an_exact_presentation_predecessor_identity() {
        let base = ManagedCreateRequest::new(
            "spawn_2",
            "session_2",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into(), "resume".into(), "conversation-1".into()],
            24,
            80,
        )
        .unwrap();
        assert!(
            serde_json::to_value(&base)
                .unwrap()
                .get("presentationPredecessor")
                .is_none()
        );
        let predecessor = PresentationCheckpointPredecessor::new(
            "session_1",
            "local-user",
            "runner_1",
            1,
            "host_1",
            "terminal_1",
        )
        .unwrap();
        let request = base
            .with_presentation_predecessor(predecessor.clone())
            .unwrap();
        let mut encoded = Vec::new();
        write_json_frame(&mut encoded, &request).unwrap();

        let decoded = read_managed_create_request(&mut Cursor::new(encoded)).unwrap();

        assert_eq!(decoded, request);
        assert_eq!(decoded.presentation_predecessor(), Some(&predecessor));
        assert!(
            ManagedCreateRequest::new(
                "spawn_same",
                "session_1",
                "workspace_1",
                "codex",
                PermissionMode::Default,
                "/tmp/work",
                vec!["codex".into()],
                24,
                80,
            )
            .unwrap()
            .with_presentation_predecessor(predecessor)
            .is_err()
        );
    }

    #[test]
    fn managed_provider_state_environment_upgrades_only_the_private_request_schema() {
        let legacy = ManagedCreateRequest::new(
            "spawn_legacy",
            "session_legacy",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap();
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert_eq!(legacy_json["schema"], "hmux-managed-create-v1");
        assert!(legacy_json.get("providerStateEnvironment").is_none());

        let profile_path = "/tmp/hebbian-accounts/codex-crispy";
        let state_path = "/tmp/canonical-codex-state";
        let environment = ProviderStateEnvironment::new(BTreeMap::from([
            ("CODEX_HOME".to_string(), profile_path.to_string()),
            ("CODEX_SQLITE_HOME".to_string(), state_path.to_string()),
        ]))
        .unwrap();
        let request = ManagedCreateRequest::new(
            "spawn_profile",
            "session_profile",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(environment.clone())
        .unwrap();
        let request_json = serde_json::to_value(&request).unwrap();
        assert_eq!(request_json["schema"], "hmux-managed-create-v2");
        assert_eq!(request.provider_state_environment(), &environment);

        let mut request_bytes = Vec::new();
        write_json_frame(&mut request_bytes, &request).unwrap();
        assert_eq!(
            read_managed_create_request(&mut Cursor::new(request_bytes)).unwrap(),
            request
        );

        let receipt = ManagedCreateReceipt::new(
            "spawn_profile",
            "session_profile",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/discovery",
            ManagedCreateOutcome::Created,
        )
        .unwrap();
        let receipt_json = serde_json::to_string(&receipt).unwrap();
        assert!(!receipt_json.contains(profile_path));
        assert!(!receipt_json.contains(state_path));
        assert!(!receipt_json.contains("providerStateEnvironment"));

        let required = request
            .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
            .unwrap();
        let required_json = serde_json::to_value(&required).unwrap();
        assert_eq!(required_json["schema"], "hmux-managed-create-v3");
        assert_eq!(required_json["schemaVersion"], 3);
        assert_eq!(required.provider_state_environment(), &environment);
        assert_eq!(required.required_managed_stop_request_version(), Some(3));
        let requirement_first = legacy
            .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
            .unwrap()
            .with_provider_state_environment(environment.clone())
            .unwrap();
        assert_eq!(
            serde_json::to_value(&requirement_first).unwrap()["schema"],
            "hmux-managed-create-v3"
        );
        assert_eq!(requirement_first.provider_state_environment(), &environment);
    }

    #[test]
    fn managed_default_colors_round_trip_without_changing_create_identity() {
        let legacy = ManagedCreateRequest::new(
            "spawn_colors",
            "session_colors",
            "workspace_1",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap();
        let configured = legacy
            .clone()
            .with_terminal_default_colors(terminal_default_colors())
            .unwrap();
        let configured_json = serde_json::to_value(&configured).unwrap();
        assert_eq!(
            configured_json["schema"],
            MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA
        );
        assert_eq!(
            configured_json["schemaVersion"],
            MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION
        );
        let mut encoded = Vec::new();
        write_json_frame(&mut encoded, &configured).unwrap();
        assert_eq!(
            read_managed_create_request(&mut Cursor::new(encoded)).unwrap(),
            configured
        );
        let mut downgraded = configured_json;
        downgraded["schema"] = MANAGED_CREATE_SCHEMA.into();
        downgraded["schemaVersion"] = MANAGED_CREATE_SCHEMA_VERSION.into();
        let downgraded: ManagedCreateRequest = serde_json::from_value(downgraded).unwrap();
        assert!(
            downgraded.validate().is_err(),
            "older schemas must not admit the additive presentation field"
        );
        assert_eq!(
            configured.canonical_create_identity_json().unwrap(),
            legacy.canonical_create_identity_json().unwrap(),
            "presentation defaults must not invalidate an idempotent retry"
        );
    }

    #[test]
    fn provider_state_environment_rejects_secrets_reserved_keys_and_non_paths() {
        for (key, value) in [
            ("OPENAI_API_KEY", "/tmp/not-a-secret"),
            ("AUTH_TOKEN", "/tmp/not-a-secret"),
            ("HMUX_SESSION_ID", "/tmp/session"),
            ("TERM", "/tmp/term"),
            ("CODEX_HOME", "relative/profile"),
        ] {
            let error = ProviderStateEnvironment::new(BTreeMap::from([(
                key.to_string(),
                value.to_string(),
            )]))
            .unwrap_err();
            assert!(
                error.to_string().starts_with("provider state environment"),
                "{key}: {error}"
            );
        }
        for key in ["PATH", "HOME", "HMUX_SESSION_ID", "TERM"] {
            assert!(
                ProviderStateEnvironment::from_mutations(
                    BTreeMap::new(),
                    BTreeSet::from([key.to_string()]),
                )
                .is_err(),
                "accepted removal of {key}"
            );
        }
        assert!(
            ProviderStateEnvironment::from_mutations(
                BTreeMap::new(),
                BTreeSet::from(["GOOGLE_APPLICATION_CREDENTIALS".to_string()]),
            )
            .is_ok(),
            "provider adapters must be able to remove provider-specific selectors without changing Hmux",
        );
    }

    #[test]
    fn provider_state_environment_bounds_composed_removals_without_provider_assumptions() {
        let supported = (0..MAX_PROVIDER_STATE_ENVIRONMENT_ENTRIES)
            .map(|index| format!("PROVIDER_SELECTOR_{index}"))
            .collect();
        assert!(ProviderStateEnvironment::from_mutations(BTreeMap::new(), supported).is_ok());

        let oversized = (0..=MAX_PROVIDER_STATE_ENVIRONMENT_ENTRIES)
            .map(|index| format!("PROVIDER_SELECTOR_{index}"))
            .collect();
        assert!(ProviderStateEnvironment::from_mutations(BTreeMap::new(), oversized).is_err());
    }

    #[test]
    fn provider_state_removals_round_trip_and_upgrade_destructive_schemas() {
        let set_only = ProviderStateEnvironment::new(BTreeMap::from([(
            "CODEX_HOME".to_string(),
            "/tmp/codex-home".to_string(),
        )]))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&set_only).unwrap(),
            serde_json::json!({ "CODEX_HOME": "/tmp/codex-home" }),
            "the shipped set-only wire shape must remain unchanged"
        );

        let removals = BTreeSet::from(["CODEX_HOME".to_string(), "CODEX_SQLITE_HOME".to_string()]);
        let provider_default =
            ProviderStateEnvironment::from_mutations(BTreeMap::new(), removals.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&provider_default).unwrap(),
            serde_json::json!({ "CODEX_HOME": null, "CODEX_SQLITE_HOME": null })
        );
        assert_eq!(
            serde_json::from_value::<ProviderStateEnvironment>(
                serde_json::to_value(&provider_default).unwrap()
            )
            .unwrap(),
            provider_default
        );
        assert!(
            ProviderStateEnvironment::from_mutations(
                BTreeMap::from([("CODEX_HOME".into(), "/tmp/codex-home".into())]),
                BTreeSet::from(["CODEX_HOME".into()]),
            )
            .is_err()
        );
        let selected = ProviderStateEnvironment::from_mutations(
            BTreeMap::from([("CODEX_HOME".into(), "/tmp/codex-home".into())]),
            BTreeSet::from([
                "CODEX_ACCESS_TOKEN".into(),
                "CODEX_API_KEY".into(),
                "OPENAI_API_KEY".into(),
            ]),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(selected).unwrap(),
            serde_json::json!({
                "CODEX_ACCESS_TOKEN": null,
                "CODEX_API_KEY": null,
                "CODEX_HOME": "/tmp/codex-home",
                "OPENAI_API_KEY": null,
            })
        );

        let create = ManagedCreateRequest::new(
            "removal-create",
            "removal-session",
            "removal-workspace",
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(provider_default.clone())
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "codex".into(),
                    "resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let create_json = serde_json::to_value(&create).unwrap();
        assert_eq!(
            create_json["schema"],
            MANAGED_CREATE_PROVIDER_STATE_REMOVAL_SCHEMA
        );
        assert_eq!(
            create.required_host_capabilities().collect::<BTreeSet<_>>(),
            BTreeSet::from([
                MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
                PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY,
            ])
        );
        let mut downgraded_create = create_json;
        downgraded_create["schema"] = MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA.into();
        downgraded_create["schemaVersion"] =
            MANAGED_CREATE_TERMINAL_DEFAULT_COLORS_SCHEMA_VERSION.into();
        assert!(
            serde_json::from_value::<ManagedCreateRequest>(downgraded_create)
                .unwrap()
                .validate()
                .is_err(),
            "an old create schema must not silently inherit removed state roots"
        );

        let source = ManagedRehostSourceRecipe::from_create_request(&create)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&source).unwrap()["schema"],
            MANAGED_REHOST_SOURCE_RECIPE_PROVIDER_STATE_REMOVAL_SCHEMA
        );

        let replacement = ManagedRehostReplacement::new(
            "codex",
            PermissionMode::Default,
            "/tmp/work",
            24,
            80,
            TerminalEnvironment::default(),
            None,
            provider_default,
            source.rehost().clone(),
        )
        .unwrap();
        let rehost = ManagedRehostRequest::new(
            "removal-rehost",
            "source-session",
            "removal-workspace",
            "principal",
            "runner",
            1,
            "source-host",
            "source-terminal",
            true,
        )
        .unwrap()
        .with_replacement(replacement)
        .unwrap()
        .with_expected_target_build_id("target-build")
        .unwrap();
        let rehost_json = serde_json::to_value(&rehost).unwrap();
        assert_eq!(
            rehost_json["schema"],
            MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA
        );
        let mut downgraded_rehost = rehost_json;
        downgraded_rehost["schema"] = MANAGED_REHOST_TARGET_BUILD_SCHEMA.into();
        downgraded_rehost["schemaVersion"] = MANAGED_REHOST_TARGET_BUILD_SCHEMA_VERSION.into();
        assert!(
            serde_json::from_value::<ManagedRehostRequest>(downgraded_rehost)
                .unwrap()
                .validate()
                .is_err(),
            "an old rehost schema must refuse replacement removals before source stop"
        );
    }

    #[test]
    fn managed_stop_round_trips_exact_identity_and_bounded_outcome() {
        let legacy_request =
            ManagedStopRequest::new("stop_legacy", "session_1", "workspace_1").unwrap();
        assert!(legacy_request.validate_complete_fence().is_err());
        let mut legacy_bytes = Vec::new();
        write_json_frame(&mut legacy_bytes, &legacy_request).unwrap();
        assert_eq!(
            serde_json::to_value(&legacy_request).unwrap()["schemaVersion"],
            1
        );
        let legacy_round_trip = read_managed_stop_request(&mut Cursor::new(legacy_bytes)).unwrap();
        assert_eq!(legacy_round_trip, legacy_request);
        assert_eq!(legacy_round_trip.expected_host_instance_id(), None);
        assert_eq!(legacy_round_trip.expected_terminal_epoch(), None);

        let request = ManagedStopRequest::new("stop_1", "session_1", "workspace_1")
            .unwrap()
            .with_expected_generation("host_1", "terminal_1")
            .unwrap();
        assert!(request.validate_complete_fence().is_err());
        assert_eq!(request.expected_host_instance_id(), Some("host_1"));
        assert_eq!(request.expected_terminal_epoch(), Some("terminal_1"));
        assert_eq!(serde_json::to_value(&request).unwrap()["schemaVersion"], 2);
        let mut request_bytes = Vec::new();
        write_json_frame(&mut request_bytes, &request).unwrap();
        assert_eq!(
            read_managed_stop_request(&mut Cursor::new(request_bytes)).unwrap(),
            request
        );

        let complete = ManagedStopRequest::new("stop_2", "session_1", "workspace_1")
            .unwrap()
            .with_expected_fence("principal_1", "runner_1", 7, "host_1", "terminal_1")
            .unwrap();
        complete.validate_complete_fence().unwrap();
        assert_eq!(complete.expected_runner_principal(), Some("principal_1"));
        assert_eq!(complete.expected_runner_instance(), Some("runner_1"));
        assert_eq!(complete.expected_channel_epoch(), Some(7));
        assert_eq!(serde_json::to_value(&complete).unwrap()["schemaVersion"], 3);
        let mut complete_bytes = Vec::new();
        write_json_frame(&mut complete_bytes, &complete).unwrap();
        assert_eq!(
            read_managed_stop_request(&mut Cursor::new(complete_bytes)).unwrap(),
            complete
        );

        let quiescent = complete
            .clone()
            .with_expected_quiescence(ManagedStopQuiescenceFence::new("terminal_1", 5, 13).unwrap())
            .unwrap();
        quiescent.validate_complete_fence().unwrap();
        assert_eq!(
            serde_json::to_value(&quiescent).unwrap()["schemaVersion"],
            MANAGED_STOP_QUIESCENT_REQUEST_VERSION
        );
        assert_eq!(
            quiescent
                .expected_quiescence()
                .map(ManagedStopQuiescenceFence::runtime_revision),
            Some(5)
        );
        let mut quiescent_bytes = Vec::new();
        write_json_frame(&mut quiescent_bytes, &quiescent).unwrap();
        assert_eq!(
            read_managed_stop_request(&mut Cursor::new(quiescent_bytes)).unwrap(),
            quiescent
        );

        let fresh_conversation = ManagedStopConversationFence::new("codex", None).unwrap();
        let fresh_fenced = complete
            .clone()
            .with_expected_conversation(fresh_conversation.clone())
            .unwrap();
        fresh_fenced.validate_complete_fence().unwrap();
        let fresh_json = serde_json::to_value(&fresh_fenced).unwrap();
        assert_eq!(
            fresh_json["schemaVersion"],
            MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION
        );
        assert_eq!(fresh_json["expectedConversation"]["providerId"], "codex");
        assert!(
            fresh_json["expectedConversation"]
                .get("conversationId")
                .is_none(),
            "a present conversation fence with no id represents exact absence"
        );
        let mut fresh_bytes = Vec::new();
        write_json_frame(&mut fresh_bytes, &fresh_fenced).unwrap();
        assert_eq!(
            read_managed_stop_request(&mut Cursor::new(fresh_bytes)).unwrap(),
            fresh_fenced
        );

        let resume_conversation =
            ManagedStopConversationFence::new("codex", Some("conversation_1".into())).unwrap();
        let conversation_then_quiescence = complete
            .clone()
            .with_expected_conversation(resume_conversation.clone())
            .unwrap()
            .with_expected_quiescence(ManagedStopQuiescenceFence::new("terminal_1", 5, 13).unwrap())
            .unwrap();
        let quiescence_then_conversation = complete
            .clone()
            .with_expected_quiescence(ManagedStopQuiescenceFence::new("terminal_1", 5, 13).unwrap())
            .unwrap()
            .with_expected_conversation(resume_conversation)
            .unwrap();
        assert_eq!(conversation_then_quiescence, quiescence_then_conversation);
        assert_eq!(
            serde_json::to_value(&conversation_then_quiescence).unwrap()["schemaVersion"],
            MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION
        );
        assert_eq!(
            conversation_then_quiescence
                .expected_conversation()
                .and_then(ManagedStopConversationFence::conversation_id),
            Some("conversation_1")
        );

        let reconciliation = ManagedStopReconcileRequest::from_stop_request(&complete).unwrap();
        assert_eq!(
            serde_json::to_value(&reconciliation).unwrap()["schemaVersion"],
            2
        );
        let mut reconciliation_bytes = Vec::new();
        write_json_frame(&mut reconciliation_bytes, &reconciliation).unwrap();
        assert_eq!(
            read_managed_stop_reconcile_request(&mut Cursor::new(reconciliation_bytes)).unwrap(),
            reconciliation
        );

        let mut downgraded = serde_json::to_value(&request).unwrap();
        downgraded["schemaVersion"] = serde_json::Value::from(1);
        let mut downgraded_bytes = Vec::new();
        write_json_frame(&mut downgraded_bytes, &downgraded).unwrap();
        assert!(
            read_managed_stop_request(&mut Cursor::new(downgraded_bytes)).is_err(),
            "generation fences must never be accepted under the legacy schema"
        );

        let receipt = ManagedStopReceipt::from_request(
            &complete,
            ManagedStopOutcome::Stopped,
            "provider terminated by Hmux Host",
        )
        .unwrap();
        assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
        assert_eq!(receipt.session_id(), "session_1");
        assert_eq!(serde_json::to_value(&receipt).unwrap()["schemaVersion"], 2);
        assert!(
            ManagedStopReceipt::from_request(
                &complete,
                ManagedStopOutcome::Stopped,
                "invalid\nreason",
            )
            .is_err()
        );
    }

    #[test]
    fn managed_rehost_recipe_is_exact_nonsecret_create_time_authority() {
        let recipe = ManagedRehostRecipe::new(
            vec![
                "codex".into(),
                "resume".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ],
            Some("credential-reference-1".into()),
        )
        .unwrap();
        assert_eq!(
            recipe.render_command("conversation-1").unwrap(),
            ["codex", "resume", "conversation-1"]
        );
        assert!(ManagedRehostRecipe::new(vec!["codex".into(), "resume".into()], None).is_err());
        assert!(
            recipe
                .render_command("conversation; unexpected-command")
                .is_err()
        );

        let create = ManagedCreateRequest::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            PermissionMode::BypassApprovals,
            "/tmp",
            vec!["provider".into(), "--arbitrary-original-command".into()],
            31,
            109,
        )
        .unwrap()
        .with_terminal_environment(
            TerminalEnvironment::new(BTreeMap::from([(
                "TERM".to_string(),
                Some("xterm-256color".to_string()),
            )]))
            .unwrap(),
        )
        .unwrap()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                "CODEX_HOME".to_string(),
                "/tmp/codex-home".to_string(),
            )]))
            .unwrap(),
        )
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
        .unwrap()
        .with_managed_rehost_recipe(recipe)
        .unwrap();
        let source = ManagedRehostSourceRecipe::from_create_request(&create)
            .unwrap()
            .unwrap();
        let encoded = serde_json::to_string(&source).unwrap();
        assert!(!encoded.contains("arbitrary-original-command"));
        assert_eq!(source.permission_mode(), PermissionMode::BypassApprovals);
        assert_eq!((source.initial_rows(), source.initial_columns()), (31, 109));
        assert_eq!(
            source.terminal_environment().values()["TERM"].as_deref(),
            Some("xterm-256color")
        );
        assert_eq!(
            source.provider_state_environment().values()["CODEX_HOME"],
            "/tmp/codex-home"
        );

        for (schema, version) in [
            (MANAGED_CREATE_SCHEMA, MANAGED_CREATE_SCHEMA_VERSION),
            (
                MANAGED_CREATE_PROVIDER_STATE_SCHEMA,
                MANAGED_CREATE_PROVIDER_STATE_SCHEMA_VERSION,
            ),
            (
                MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA,
                MANAGED_CREATE_LIFECYCLE_REQUIREMENTS_SCHEMA_VERSION,
            ),
        ] {
            let mut downgraded = create.clone();
            downgraded.schema = schema.to_string();
            downgraded.schema_version = version;
            if version == MANAGED_CREATE_SCHEMA_VERSION {
                downgraded.provider_state_environment = ProviderStateEnvironment::default();
                downgraded.required_managed_stop_request_version = None;
            } else if version == MANAGED_CREATE_PROVIDER_STATE_SCHEMA_VERSION {
                downgraded.required_managed_stop_request_version = None;
            }
            assert!(
                downgraded.validate().is_err(),
                "schema {schema} must not carry v4 rehost authority"
            );
        }

        let colored = create
            .with_terminal_default_colors(terminal_default_colors())
            .unwrap();
        let colored_source = ManagedRehostSourceRecipe::from_create_request(&colored)
            .unwrap()
            .unwrap();
        assert_eq!(
            colored_source.terminal_default_colors(),
            Some(terminal_default_colors())
        );
        let colored_source_json = serde_json::to_value(&colored_source).unwrap();
        assert_eq!(
            colored_source_json["schema"],
            MANAGED_REHOST_SOURCE_RECIPE_TERMINAL_DEFAULT_COLORS_SCHEMA
        );
        let decoded: ManagedRehostSourceRecipe =
            serde_json::from_value(colored_source_json).unwrap();
        decoded.validate().unwrap();
        assert_eq!(decoded, colored_source);
    }

    #[test]
    fn socket_owner_guard_requires_a_versioned_exact_resume_request() {
        let base = ManagedRehostRequest::new(
            "operation-guard",
            "source-1",
            "workspace-1",
            "principal-1",
            "runner-1",
            1,
            "host-1",
            "terminal-1",
            true,
        )
        .unwrap();
        assert!(base.clone().requiring_socket_owner_absence().is_err());
        let base = base
            .with_expected_conversation_id("conversation-1")
            .unwrap();
        let guarded = base.clone().requiring_socket_owner_absence().unwrap();
        assert!(guarded.requires_socket_owner_absent());
        let mut frame = Vec::new();
        write_json_frame(&mut frame, &guarded).unwrap();
        assert_eq!(
            read_managed_rehost_request(&mut Cursor::new(frame)).unwrap(),
            guarded
        );
        let mut downgraded = guarded.clone();
        downgraded.schema = base.schema.clone();
        downgraded.schema_version = base.schema_version;
        assert!(downgraded.validate().is_err());
        let mut stripped = guarded;
        stripped.require_socket_owner_absent = false;
        assert!(stripped.validate().is_err());
        assert!(
            serde_json::to_value(base)
                .unwrap()
                .get("requireSocketOwnerAbsent")
                .is_none()
        );
    }

    #[test]
    fn managed_rehost_request_and_receipt_bind_both_generations() {
        let request = ManagedRehostRequest::new(
            "operation-1",
            "source-1",
            "workspace-1",
            "principal-1",
            "runner-1",
            u64::MAX,
            "host-source-1",
            "terminal-source-1",
            true,
        )
        .unwrap()
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id("conversation-1")
        .unwrap()
        .with_expected_launch_reference("credential+reference-1")
        .unwrap();
        let mut frame = Vec::new();
        write_json_frame(&mut frame, &request).unwrap();
        assert_eq!(
            read_managed_rehost_request(&mut Cursor::new(frame)).unwrap(),
            request
        );

        let source_stop = ManagedStopReceipt::from_request(
            request.source(),
            ManagedStopOutcome::Stopped,
            "managed source stopped",
        )
        .unwrap();
        let replacement = ManagedCreateReceipt::new(
            "replacement-create-1",
            "replacement-1",
            "workspace-1",
            "codex",
            PermissionMode::BypassApprovals,
            "/tmp/discovery",
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new(
                "principal-2",
                "runner-2",
                u64::MAX,
                "host-replacement-1",
                "terminal-replacement-1",
            )
            .unwrap(),
        )
        .unwrap();
        let receipt = ManagedRehostReceipt::new(
            &request,
            source_stop,
            replacement,
            "conversation-1",
            Some("credential+reference-1".into()),
            false,
        )
        .unwrap();
        assert_eq!(receipt.operation_id(), "operation-1");
        assert_eq!(receipt.conversation_id(), Some("conversation-1"));
        assert!(!receipt.replayed());
        let receipt_json = serde_json::to_value(&receipt).unwrap();
        assert_eq!(
            receipt_json["sourceStopReceipt"]["channelEpoch"],
            "18446744073709551615"
        );
        assert_eq!(
            receipt_json["replacementReceipt"]["generationFence"]["channelEpoch"],
            "18446744073709551615"
        );
        assert_eq!(
            serde_json::from_value::<ManagedRehostReceipt>(receipt_json.clone()).unwrap(),
            receipt
        );
        for invalid in [serde_json::json!(u64::MAX), serde_json::json!("01")] {
            let mut malformed = receipt_json.clone();
            malformed["sourceStopReceipt"]["channelEpoch"] = invalid;
            assert!(serde_json::from_value::<ManagedRehostReceipt>(malformed).is_err());
        }

        let resolution = ManagedRehostResolution::from_receipts_with_launch_identity(
            "operation-1",
            receipt.source_stop_receipt(),
            receipt.replacement_receipt(),
            Some(
                ManagedRehostLaunchIdentity::new(
                    receipt.launch_reference().map(str::to_string),
                    receipt.conversation_id().map(str::to_string),
                )
                .unwrap(),
            ),
        )
        .unwrap();
        let resolution_json = serde_json::to_value(&resolution).unwrap();
        assert_eq!(resolution_json["schema"], MANAGED_REHOST_RESOLUTION_SCHEMA);
        assert_eq!(resolution_json["state"], "resolved");
        assert_eq!(
            resolution_json["sourceGeneration"]["channelEpoch"],
            "18446744073709551615"
        );
        assert_eq!(
            resolution_json["currentGeneration"]["channelEpoch"],
            "18446744073709551615"
        );
        assert_eq!(
            resolution_json["launchIdentity"],
            serde_json::json!({
                "launchReference": "credential+reference-1",
                "conversationId": "conversation-1"
            })
        );

        let mut legacy_json = resolution_json;
        legacy_json
            .as_object_mut()
            .unwrap()
            .remove("launchIdentity");
        let legacy: ManagedRehostResolution = serde_json::from_value(legacy_json).unwrap();
        assert!(legacy.launch_identity().is_none());
        assert_eq!(
            serde_json::to_value(ManagedRehostLaunchIdentity::new(None, None).unwrap()).unwrap(),
            serde_json::json!({})
        );
        assert!(
            serde_json::from_value::<ManagedRehostLaunchIdentity>(
                serde_json::json!({ "launchReference": "../credential" })
            )
            .unwrap()
            .validate()
            .is_err()
        );
    }

    #[test]
    fn replayed_managed_rehost_receipt_uses_stable_journal_identity() {
        let admitted = ManagedRehostRequest::new(
            "operation-replay",
            "source-1",
            "workspace-1",
            "principal-admitted",
            "runner-admitted",
            7,
            "host-admitted",
            "terminal-admitted",
            true,
        )
        .unwrap()
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id("conversation-admitted")
        .unwrap();
        let source_stop = ManagedStopReceipt::from_request(
            admitted.source(),
            ManagedStopOutcome::Stopped,
            "managed source stopped",
        )
        .unwrap();
        let replacement = ManagedCreateReceipt::new(
            "replacement-create",
            "replacement-session",
            "workspace-1",
            "codex",
            PermissionMode::Default,
            "/tmp/discovery",
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new(
                "principal-target",
                "runner-target",
                9,
                "host-target",
                "terminal-target",
            )
            .unwrap(),
        )
        .unwrap();
        let replayed = ManagedRehostReceipt::new(
            &admitted,
            source_stop,
            replacement,
            "conversation-admitted",
            None,
            true,
        )
        .unwrap();
        let changed_replacement = ManagedRehostReplacement::new(
            "claude",
            PermissionMode::BypassApprovals,
            "/work/changed",
            33,
            101,
            TerminalEnvironment::default(),
            Some("launch-reference-changed".into()),
            ProviderStateEnvironment::new(BTreeMap::new()).unwrap(),
            ManagedRehostRecipe::new(
                vec![
                    "claude".into(),
                    "--resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                Some("launch-reference-changed".into()),
            )
            .unwrap(),
        )
        .unwrap();
        let changed_client = ManagedRehostRequest::new(
            admitted.operation_id(),
            admitted.source().session_id(),
            admitted.source().workspace_id(),
            "principal-changed",
            "runner-changed",
            99,
            "host-changed",
            "terminal-changed",
            true,
        )
        .unwrap()
        .with_expected_provider_id("claude")
        .unwrap()
        .with_expected_conversation_id("conversation-changed")
        .unwrap()
        .with_expected_launch_reference("launch-reference-changed")
        .unwrap()
        .with_replacement(changed_replacement)
        .unwrap()
        .with_expected_target_build_id("build-changed")
        .unwrap();

        replayed.validate_against(&changed_client).unwrap();
    }

    #[test]
    fn managed_rehost_v2_binds_replacement_state_and_rejects_silent_downgrade() {
        let replacement = ManagedRehostReplacement::new(
            "codex",
            PermissionMode::Default,
            "/work/repository",
            24,
            80,
            TerminalEnvironment::default(),
            Some("credential-target".into()),
            ProviderStateEnvironment::new(BTreeMap::from([(
                "CODEX_HOME".to_string(),
                "/home/agent/.dure/accounts/codex-target".to_string(),
            )]))
            .unwrap(),
            ManagedRehostRecipe::new(
                vec![
                    "/bin/sh".into(),
                    "-lc".into(),
                    format!("exec codex resume {MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER}"),
                ],
                Some("credential-target".into()),
            )
            .unwrap(),
        )
        .unwrap();
        let request = ManagedRehostRequest::new(
            "operation-v2",
            "source-1",
            "workspace-1",
            "principal-1",
            "runner-1",
            7,
            "host-1",
            "terminal-1",
            true,
        )
        .unwrap()
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id("conversation-v2")
        .unwrap()
        .with_replacement(replacement.clone())
        .unwrap();

        assert_eq!(request.replacement(), Some(&replacement));
        let reconcile = ManagedRehostReconcileRequest::without_client_hints(
            request.operation_id(),
            request.source().clone(),
        )
        .unwrap();
        assert_eq!(reconcile.expected_provider_id(), None);
        assert_eq!(reconcile.expected_conversation_id(), None);
        let reconcile_json = serde_json::to_value(&reconcile).unwrap();
        assert!(reconcile_json.get("expectedProviderId").is_none());
        assert!(reconcile_json.get("expectedConversationId").is_none());
        assert_eq!(
            serde_json::from_value::<ManagedRehostReconcileRequest>(reconcile_json).unwrap(),
            reconcile
        );
        let identity_reconcile = ManagedRehostReconcileRequest::by_operation_identity(
            request.operation_id(),
            request.source().session_id(),
            request.source().workspace_id(),
        )
        .unwrap();
        assert!(identity_reconcile.source().is_none());
        assert_eq!(identity_reconcile.source_session_id(), "source-1");
        assert_eq!(identity_reconcile.source_workspace_id(), "workspace-1");
        let identity_json = serde_json::to_value(&identity_reconcile).unwrap();
        assert!(identity_json.get("source").is_none());
        assert_eq!(
            serde_json::from_value::<ManagedRehostReconcileRequest>(identity_json).unwrap(),
            identity_reconcile
        );
        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["schema"], MANAGED_REHOST_REPLACEMENT_SCHEMA);
        assert_eq!(
            encoded["replacement"]["providerStateEnvironment"]["CODEX_HOME"],
            "/home/agent/.dure/accounts/codex-target"
        );
        let pinned = request
            .clone()
            .with_expected_target_build_id("build-confirmed")
            .unwrap();
        assert_eq!(pinned.expected_target_build_id(), Some("build-confirmed"));
        let pinned_json = serde_json::to_value(&pinned).unwrap();
        assert_eq!(pinned_json["schema"], MANAGED_REHOST_TARGET_BUILD_SCHEMA);
        assert_eq!(
            pinned_json["schemaVersion"],
            MANAGED_REHOST_TARGET_BUILD_SCHEMA_VERSION
        );
        assert_eq!(pinned_json["expectedTargetBuildId"], "build-confirmed");
        assert_eq!(
            serde_json::from_value::<ManagedRehostRequest>(pinned_json).unwrap(),
            pinned
        );

        let host_resolved = ManagedRehostRequest::new(
            "operation-v2-host-resolved",
            "source-1",
            "workspace-1",
            "principal-1",
            "runner-1",
            7,
            "host-1",
            "terminal-1",
            true,
        )
        .unwrap()
        .with_replacement(replacement)
        .unwrap();
        assert_eq!(host_resolved.expected_provider_id(), None);
        assert_eq!(host_resolved.expected_conversation_id(), None);

        let mut downgraded = encoded;
        downgraded["schema"] = serde_json::json!(MANAGED_REHOST_SCHEMA);
        downgraded["schemaVersion"] = serde_json::json!(MANAGED_REHOST_SCHEMA_VERSION);
        assert!(
            serde_json::from_value::<ManagedRehostRequest>(downgraded)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn managed_fresh_replacement_keeps_the_target_build_fence() {
        let replacement = ManagedRehostReplacement::new(
            "codex",
            PermissionMode::Default,
            "/work/repository",
            24,
            80,
            TerminalEnvironment::default(),
            None,
            ProviderStateEnvironment::default(),
            ManagedRehostRecipe::new(
                vec![
                    "codex".into(),
                    "resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap()
        .with_fresh_command(vec!["codex".into()])
        .unwrap();
        let request = ManagedRehostRequest::new(
            "operation-fresh-build",
            "source-1",
            "workspace-1",
            "principal-1",
            "runner-1",
            7,
            "host-1",
            "terminal-1",
            true,
        )
        .unwrap()
        .with_expected_provider_id("codex")
        .unwrap()
        .with_replacement(replacement)
        .unwrap()
        .with_expected_target_build_id("build-confirmed")
        .unwrap();

        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["schema"], MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA);
        assert_eq!(
            encoded["schemaVersion"],
            MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA_VERSION
        );
        assert_eq!(encoded["expectedTargetBuildId"], "build-confirmed");
        let guarded = request
            .clone()
            .with_fresh_source_quiescence(
                ManagedStopQuiescenceFence::new("terminal-1", 7, 19).unwrap(),
            )
            .unwrap();
        let encoded = serde_json::to_value(&guarded).unwrap();
        let decoded: ManagedRehostRequest = serde_json::from_value(encoded).unwrap();
        decoded.validate().unwrap();
        assert_eq!(decoded, guarded);
        let mut downgraded = serde_json::to_value(&guarded).unwrap();
        downgraded["schema"] = MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA.into();
        downgraded["schemaVersion"] = MANAGED_REHOST_FRESH_REPLACEMENT_SCHEMA_VERSION.into();
        assert!(
            serde_json::from_value::<ManagedRehostRequest>(downgraded)
                .unwrap()
                .validate()
                .is_err()
        );
        assert_eq!(
            decoded.source().expected_quiescence(),
            Some(&ManagedStopQuiescenceFence::new("terminal-1", 7, 19).unwrap())
        );
        assert_eq!(
            decoded.source().expected_conversation(),
            Some(&ManagedStopConversationFence::new("codex", None).unwrap())
        );
        assert!(
            request
                .clone()
                .with_fresh_source_quiescence(
                    ManagedStopQuiescenceFence::new("terminal-other", 7, 19).unwrap(),
                )
                .is_err()
        );
        assert!(request.requiring_socket_owner_absence().is_err());
    }
}
