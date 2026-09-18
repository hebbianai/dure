//! Durable authority and recovery contract for replacing an Agent runtime.
//!
//! Interaction-profile changes and credential changes are the same operation:
//! stop one exact writer, start one exact replacement, then atomically publish
//! the replacement selection. Provider adapters own process-specific resume
//! details; this contract owns only the provider-neutral transition facts.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain_store::validate_token;
use crate::{
    AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionProfileV1, AgentSpawnEffortSelectionV1,
    AgentSpawnModelSelectionV1, DomainStoreErrorV1, DomainStoreFuture, OperationIdV1, ProviderIdV1,
    ProviderPermissionModeV1,
};

mod advance;
pub use advance::advance_agent_runtime_transition_v1;
mod deferred;
pub use deferred::{
    AgentRuntimeDeferredTargetV1, AgentRuntimeTransitionWakeRequestV1,
    authorize_agent_runtime_transition_wake_v1,
};
mod history;
mod store;
pub use store::{
    AgentRuntimeRequestOutcomeV1, AgentRuntimeRequestReceiptV1, AgentRuntimeTransitionStore,
};

pub const AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1: u16 = 1;

/// Stable request identity shared by explicit transitions and automatic recovery.
pub fn agent_runtime_transition_identity(
    attempt_id: &str,
) -> Result<(OperationIdV1, String), crate::DomainIdErrorV1> {
    let mut digest = Sha256::new();
    digest.update(b"dure-agent-runtime-transition-attempt/v1\0");
    digest.update((attempt_id.len() as u64).to_be_bytes());
    digest.update(attempt_id.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    Ok((
        OperationIdV1::new(format!("runtime-transition-{digest}"))?,
        format!("runtime-attempt-{digest}"),
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRuntimeNativeLaunchIdentityV1 {
    pub launch_idempotency_key: String,
    pub session_id: String,
}

/// The immutable native launch preference for one target attempt. A managed
/// create may return a different effective pair, but it may never mix one half
/// of this prepared identity with one half of a successor identity.
#[must_use]
pub fn agent_runtime_native_launch_identity_v1(
    operation_id: &OperationIdV1,
) -> AgentRuntimeNativeLaunchIdentityV1 {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "dure-agent-runtime-native-target/v1\0{}",
                operation_id.as_str()
            )
            .as_bytes()
        )
    );
    AgentRuntimeNativeLaunchIdentityV1 {
        launch_idempotency_key: format!("runtime-native-launch-{digest}"),
        session_id: format!("runtime-native-{}", &digest[..32]),
    }
}

pub fn validate_agent_runtime_native_launch_identity_v1(
    operation_id: &OperationIdV1,
    session_id: &str,
    launch_idempotency_key: &str,
) -> Result<(), DomainStoreErrorV1> {
    validate_token("targetLaunchIdempotencyKey", launch_idempotency_key)?;
    let prepared = agent_runtime_native_launch_identity_v1(operation_id);
    if (session_id == prepared.session_id)
        != (launch_idempotency_key == prepared.launch_idempotency_key)
    {
        return Err(invalid(
            "targetLaunchIdempotencyKey",
            "must remain the prepared key exactly for the prepared Session and change exactly for an advanced successor Session",
        ));
    }
    Ok(())
}

fn validate_recorded_agent_runtime_native_launch_identity_v1(
    operation_id: &OperationIdV1,
    session_id: &str,
    launch_idempotency_key: Option<&str>,
) -> Result<(), DomainStoreErrorV1> {
    if let Some(key) = launch_idempotency_key {
        return validate_agent_runtime_native_launch_identity_v1(operation_id, session_id, key);
    }
    let prepared = agent_runtime_native_launch_identity_v1(operation_id);
    if session_id != prepared.session_id {
        return Err(invalid(
            "targetLaunchIdempotencyKey",
            "is required for an advanced successor Session",
        ));
    }
    Ok(())
}

fn invalid(field: &'static str, reason: impl Into<String>) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

fn positive(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 1 {
        return Err(invalid(field, "must be positive"));
    }
    Ok(())
}

fn timestamp(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 0 {
        return Err(invalid(field, "must not be negative"));
    }
    Ok(())
}

fn exact_execution_profile(profile: &AgentExecutionProfileV1) -> Result<(), DomainStoreErrorV1> {
    profile.validate()?;
    if matches!(
        profile,
        AgentExecutionProfileV1::CredentialReference {
            credential_generation: None,
            ..
        }
    ) {
        return Err(invalid(
            "executionProfile",
            "credential references require an exact generation",
        ));
    }
    Ok(())
}

fn selected_execution_profile(
    selection: &AgentRuntimeSelectionV1,
) -> Result<(), DomainStoreErrorV1> {
    selection.execution_profile.validate()?;
    if matches!(
        &selection.execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            credential_generation: None,
            ..
        }
    ) && selection.interaction_profile != AgentInteractionProfileV1::NativeCli
    {
        return Err(invalid(
            "executionProfile",
            "only a Host-proven native runtime may have an unclaimed credential generation",
        ));
    }
    Ok(())
}

/// The single durable answer to which interaction and credential profile is
/// active for a logical Agent. Exact process fences remain in their existing
/// native or structured binding authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeSelectionV1 {
    pub schema_version: u16,
    pub agent_id: AgentIdV1,
    pub provider_id: ProviderIdV1,
    pub interaction_profile: AgentInteractionProfileV1,
    pub execution_profile: AgentExecutionProfileV1,
    pub permission_mode: ProviderPermissionModeV1,
    pub model: Option<AgentSpawnModelSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<AgentSpawnEffortSelectionV1>,
    pub revision: i64,
    pub selected_by_operation_id: Option<OperationIdV1>,
    pub updated_at_ms: i64,
}

impl AgentRuntimeSelectionV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime selection schema",
            ));
        }
        selected_execution_profile(self)?;
        positive("revision", self.revision)?;
        timestamp("updatedAtMs", self.updated_at_ms)?;
        match (self.revision, &self.selected_by_operation_id) {
            (1, None) => Ok(()),
            (_, Some(_)) if self.revision > 1 => Ok(()),
            (1, Some(_)) => Err(invalid(
                "selectedByOperationId",
                "an initial selection must not claim a replacement operation",
            )),
            (_, Some(_)) => Err(invalid("revision", "must be positive")),
            (_, None) => Err(invalid(
                "selectedByOperationId",
                "a replacement selection must identify its operation",
            )),
        }
    }
}

/// Exact process authority associated with a selection. The tagged union keeps
/// provider/runtime details out of the journal state machine.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "interactionProfile",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum AgentRuntimeBindingAuthorityV1 {
    NativeCli {
        authority: AgentCheckpointBindingAuthorityV1,
    },
    StructuredProtocol {
        binding: AgentInteractionBindingV1,
    },
}

impl AgentRuntimeBindingAuthorityV1 {
    pub fn validate_for_selection(
        &self,
        selection: &AgentRuntimeSelectionV1,
    ) -> Result<(), DomainStoreErrorV1> {
        selection.validate()?;
        match self {
            Self::NativeCli { authority } => {
                authority.validate()?;
                if selection.interaction_profile != AgentInteractionProfileV1::NativeCli
                    || authority.binding.agent_id != selection.agent_id
                {
                    return Err(invalid(
                        "sourceAuthority",
                        "native binding does not match the runtime selection",
                    ));
                }
                let credential_matches = match &selection.execution_profile {
                    AgentExecutionProfileV1::ProviderDefault => {
                        authority.binding.credential_reference_id.is_none()
                    }
                    AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
                        authority.binding.credential_reference_id.as_deref()
                            == Some(reference_id.as_str())
                    }
                };
                if !credential_matches {
                    return Err(invalid(
                        "sourceAuthority",
                        "native binding does not match the selected credential reference",
                    ));
                }
            }
            Self::StructuredProtocol { binding } => {
                binding.validate()?;
                if selection.interaction_profile != AgentInteractionProfileV1::StructuredProtocol
                    || binding.agent_id != selection.agent_id
                    || binding.provider_id != selection.provider_id
                    || binding.execution_profile != selection.execution_profile
                {
                    return Err(invalid(
                        "sourceAuthority",
                        "structured binding does not match the runtime selection",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn validate_for_transition(
        &self,
        selection: &AgentRuntimeSelectionV1,
        provider_conversation: &AgentProviderConversationPlanV1,
    ) -> Result<(), DomainStoreErrorV1> {
        self.validate_for_selection(selection)?;
        if self.provider_conversation_ref() != provider_conversation.as_option() {
            return Err(invalid(
                "sourceAuthority",
                "binding does not match the exact source conversation plan",
            ));
        }
        Ok(())
    }

    pub fn validate_for_transition_target(
        &self,
        selection: &AgentRuntimeSelectionV1,
        provider_conversation: &AgentProviderConversationPlanV1,
    ) -> Result<(), DomainStoreErrorV1> {
        self.validate_for_selection(selection)?;
        if provider_conversation
            .as_option()
            .is_some_and(|expected| self.provider_conversation_ref() != Some(expected))
        {
            return Err(invalid(
                "targetAuthority",
                "binding does not match the resumed target conversation",
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn provider_conversation_ref(&self) -> Option<&str> {
        match self {
            Self::NativeCli { authority } => authority.binding.provider_conversation_id.as_deref(),
            Self::StructuredProtocol { binding } => binding.provider_conversation_ref.as_deref(),
        }
    }
}

/// Immutable conversation plan for one transition. `Fresh` is exact absence
/// at the source boundary, not a wildcard; the target adapter may later prove
/// a newly allocated provider conversation through its published authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct AgentProviderConversationPlanV1(Option<String>);

impl Default for AgentProviderConversationPlanV1 {
    fn default() -> Self {
        Self::fresh()
    }
}

impl<'de> Deserialize<'de> for AgentProviderConversationPlanV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Option::<String>::deserialize(deserializer)?;
        Self::from_option(value).map_err(serde::de::Error::custom)
    }
}

impl AgentProviderConversationPlanV1 {
    #[must_use]
    pub const fn fresh() -> Self {
        Self(None)
    }

    pub fn resume(value: impl Into<String>) -> Result<Self, DomainStoreErrorV1> {
        let value = value.into();
        validate_token("providerConversationRef", &value)?;
        Ok(Self(Some(value)))
    }

    pub fn from_option(value: Option<String>) -> Result<Self, DomainStoreErrorV1> {
        match value {
            Some(value) => Self::resume(value),
            None => Ok(Self::fresh()),
        }
    }

    #[must_use]
    pub fn as_option(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

/// Exact authority of a failed predecessor target that a successor
/// is authorized to replace. This is deliberately distinct from the
/// successor's target authority: a new attempt may preserve or change the
/// credential and interaction profile of the immutable failed intent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct AgentRuntimeReplacementAuthorityV1(pub AgentRuntimeBindingAuthorityV1);

impl AgentRuntimeReplacementAuthorityV1 {
    pub fn validate_for_transition_identity(
        &self,
        agent_id: &AgentIdV1,
        provider_id: &ProviderIdV1,
        provider_conversation: &AgentProviderConversationPlanV1,
    ) -> Result<(), DomainStoreErrorV1> {
        match &self.0 {
            AgentRuntimeBindingAuthorityV1::NativeCli { authority } => {
                authority.validate()?;
                if &authority.binding.agent_id != agent_id
                    || provider_conversation.as_option().is_some_and(|expected| {
                        authority.binding.provider_conversation_id.as_deref() != Some(expected)
                    })
                {
                    return Err(invalid(
                        "replacementSourceAuthority",
                        "native binding does not match the transition identity",
                    ));
                }
            }
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
                binding.validate()?;
                if &binding.agent_id != agent_id
                    || &binding.provider_id != provider_id
                    || provider_conversation.as_option().is_some_and(|expected| {
                        binding.provider_conversation_ref.as_deref() != Some(expected)
                    })
                {
                    return Err(invalid(
                        "replacementSourceAuthority",
                        "structured binding does not match the transition identity",
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Absolute update semantics for the one pending replacement fence. `None`
/// cannot mean both "no provider mutation" and "the provider proved no durable
/// binding", so those outcomes are distinct variants.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "disposition", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentRuntimeReplacementAuthorityUpdateV1 {
    PreserveExisting,
    Replace {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        authority: Option<Box<AgentRuntimeReplacementAuthorityV1>>,
    },
}

/// Complete launch-selection snapshot a transition may install: `None` values
/// mean the provider default (Auto), so returning to Auto is expressible. An
/// absent snapshot on the intent inherits the source selection unchanged.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeLaunchSelectionV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AgentSpawnModelSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<AgentSpawnEffortSelectionV1>,
    /// Absent inherits the source's permission mode (unlike model/effort,
    /// the mode has no "Auto": it is always an explicit value).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<ProviderPermissionModeV1>,
}

mod stop_policy;
pub use stop_policy::AgentRuntimeSourceStopPolicyV1;

/// Fully admitted, non-secret replacement intent. The complete target profile
/// is immutable, so one transition may replace interaction, credentials, and
/// launch selection together. A transition that changes none is rejected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeTransitionIntentV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub idempotency_key: String,
    pub source: AgentRuntimeSelectionV1,
    pub source_authority: AgentRuntimeBindingAuthorityV1,
    #[serde(
        default,
        skip_serializing_if = "AgentRuntimeSourceStopPolicyV1::is_preserve"
    )]
    pub source_stop_policy: AgentRuntimeSourceStopPolicyV1,
    pub provider_conversation_ref: AgentProviderConversationPlanV1,
    pub target_interaction_profile: AgentInteractionProfileV1,
    pub target_execution_profile: AgentExecutionProfileV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_launch_selection: Option<AgentRuntimeLaunchSelectionV1>,
    pub requested_at_ms: i64,
}

impl AgentRuntimeTransitionIntentV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        self.validate_for_source_boundary(false)
    }

    /// Validates a successor whose source runtime already crossed the durable
    /// stop boundary. Such an intent may relaunch the source's logical profile;
    /// the supersede CAS separately proves that it corrects the failed target.
    pub fn validate_after_stopped_source(&self) -> Result<(), DomainStoreErrorV1> {
        self.validate_for_source_boundary(true)
    }

    fn validate_for_source_boundary(
        &self,
        source_already_stopped: bool,
    ) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime transition schema",
            ));
        }
        validate_token("idempotencyKey", &self.idempotency_key)?;
        self.source.validate()?;
        self.source_authority
            .validate_for_transition(&self.source, &self.provider_conversation_ref)?;
        self.source_stop_policy.validate(&self.source_authority)?;
        exact_execution_profile(&self.target_execution_profile)?;
        let profile_changed = self.source.interaction_profile != self.target_interaction_profile;
        let execution_changed = self.source.execution_profile != self.target_execution_profile;
        if !source_already_stopped
            && !profile_changed
            && !execution_changed
            && !self.launch_selection_changed()
        {
            return Err(invalid(
                "target",
                "transition must change a profile or the launch selection",
            ));
        }
        timestamp("requestedAtMs", self.requested_at_ms)?;
        if self.requested_at_ms < self.source.updated_at_ms {
            return Err(invalid(
                "requestedAtMs",
                "must not precede the source selection",
            ));
        }
        Ok(())
    }

    /// The launch selection the target runtime installs: the intent's
    /// snapshot when present, otherwise the source's values unchanged.
    pub fn effective_launch_selection(&self) -> AgentRuntimeLaunchSelectionV1 {
        self.target_launch_selection
            .clone()
            .unwrap_or(AgentRuntimeLaunchSelectionV1 {
                model: self.source.model.clone(),
                effort: self.source.effort.clone(),
                permission_mode: None,
            })
    }

    /// The permission mode the target runtime installs: the snapshot's when
    /// set, otherwise the source's unchanged.
    pub fn effective_permission_mode(&self) -> ProviderPermissionModeV1 {
        self.target_launch_selection
            .as_ref()
            .and_then(|selection| selection.permission_mode.clone())
            .unwrap_or_else(|| self.source.permission_mode.clone())
    }

    fn launch_selection_changed(&self) -> bool {
        let effective = self.effective_launch_selection();
        effective.model != self.source.model
            || effective.effort != self.source.effort
            || self.effective_permission_mode() != self.source.permission_mode
    }

    pub fn target_selection_at(
        &self,
        selected_at_ms: i64,
    ) -> Result<AgentRuntimeSelectionV1, DomainStoreErrorV1> {
        timestamp("selectedAtMs", selected_at_ms)?;
        if selected_at_ms < self.requested_at_ms {
            return Err(invalid(
                "selectedAtMs",
                "must not precede the replacement request",
            ));
        }
        let launch = self.effective_launch_selection();
        let selection = AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id: self.source.agent_id.clone(),
            provider_id: self.source.provider_id.clone(),
            interaction_profile: self.target_interaction_profile,
            execution_profile: self.target_execution_profile.clone(),
            permission_mode: self.effective_permission_mode(),
            model: launch.model,
            effort: launch.effort,
            revision: self
                .source
                .revision
                .checked_add(1)
                .ok_or_else(|| invalid("revision", "overflowed"))?,
            selected_by_operation_id: Some(self.operation_id.clone()),
            updated_at_ms: selected_at_ms,
        };
        selection.validate()?;
        Ok(selection)
    }
}

/// Provider-neutral reason a replacement could not establish its target after
/// the source runtime crossed its destructive stop boundary. Provider codes
/// are retained only as bounded diagnostics; orchestration branches on this
/// closed classification and journal state, never on provider strings.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeTargetFailureKindV1 {
    TargetInvalid,
    RuntimeUnavailable,
    CredentialUnavailable,
    CredentialStale,
    LaunchFailed,
    IdentityMismatch,
    AuthorityPublishFailed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeTargetFailureV1 {
    pub kind: AgentRuntimeTargetFailureKindV1,
    pub provider_code: String,
}

impl AgentRuntimeTargetFailureV1 {
    pub fn new(
        kind: AgentRuntimeTargetFailureKindV1,
        provider_code: impl Into<String>,
    ) -> Result<Self, DomainStoreErrorV1> {
        let failure = Self {
            kind,
            provider_code: provider_code.into(),
        };
        failure.validate()?;
        Ok(failure)
    }

    /// Normalizes an untrusted provider diagnostic at the adapter boundary.
    /// The closed failure kind remains authoritative; malformed free-form
    /// diagnostics are replaced with one bounded, inert code before the
    /// failure enters the durable transition journal.
    pub fn from_untrusted_provider_diagnostic(
        kind: AgentRuntimeTargetFailureKindV1,
        provider_code: impl Into<String>,
    ) -> Self {
        let provider_code = provider_code.into();
        if validate_token("providerCode", &provider_code).is_ok() {
            Self {
                kind,
                provider_code,
            }
        } else {
            Self {
                kind,
                provider_code: "provider_failure_diagnostic_invalid".to_owned(),
            }
        }
    }

    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token("providerCode", &self.provider_code)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeTransitionStateV1 {
    Admitted,
    /// The destructive boundary was refused, so the selected source remains
    /// authoritative. This exact attempt is terminal; a fresh request admits
    /// a new intent from current source and target authority.
    SourceRetained,
    SourceStopped,
    /// The source is durably stopped and a typed target failure requires one
    /// explicit exact repair or supersede operation before effects may resume.
    RepairRequired,
    TargetStarted,
    Committed,
    /// A new immutable intent atomically replaced this failed attempt.
    Superseded,
}

impl AgentRuntimeTransitionStateV1 {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::SourceRetained => "source_retained",
            Self::SourceStopped => "source_stopped",
            Self::RepairRequired => "repair_required",
            Self::TargetStarted => "target_started",
            Self::Committed => "committed",
            Self::Superseded => "superseded",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeTransitionRecordV1 {
    pub schema_version: u16,
    pub intent: AgentRuntimeTransitionIntentV1,
    pub state: AgentRuntimeTransitionStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred_target: Option<AgentRuntimeDeferredTargetV1>,
    pub target_authority: Option<AgentRuntimeBindingAuthorityV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_launch_idempotency_key: Option<String>,
    /// The one exact provider/runtime fence the next target effect must replace
    /// or retire. A provider mutation replaces this value, a pre-effect failure
    /// preserves it, successful target publication clears it, and supersede
    /// atomically moves it to the successor intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_authority: Option<AgentRuntimeReplacementAuthorityV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_failure: Option<AgentRuntimeTargetFailureV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_repair_operation_id: Option<OperationIdV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor_operation_id: Option<OperationIdV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by_operation_id: Option<OperationIdV1>,
    pub journal_revision: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl AgentRuntimeTransitionRecordV1 {
    pub fn admitted(intent: AgentRuntimeTransitionIntentV1) -> Result<Self, DomainStoreErrorV1> {
        Self::admitted_with_activation(intent, None)
    }

    fn admitted_with_activation(
        intent: AgentRuntimeTransitionIntentV1,
        deferred_target: Option<AgentRuntimeDeferredTargetV1>,
    ) -> Result<Self, DomainStoreErrorV1> {
        let requested_at_ms = intent.requested_at_ms;
        let record = Self {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            intent,
            state: AgentRuntimeTransitionStateV1::Admitted,
            deferred_target,
            target_authority: None,
            target_launch_idempotency_key: None,
            replacement_authority: None,
            target_failure: None,
            last_repair_operation_id: None,
            predecessor_operation_id: None,
            superseded_by_operation_id: None,
            journal_revision: 1,
            created_at_ms: requested_at_ms,
            updated_at_ms: requested_at_ms,
        };
        record.validate()?;
        Ok(record)
    }

    /// Admits an explicit successor after another durable lifecycle operation
    /// already crossed this exact source's stop boundary. The predecessor is
    /// retained as the audit link; this transition starts at `SourceStopped`
    /// and therefore can never inspect or stop the retired runtime again.
    pub fn after_stopped_source(
        intent: AgentRuntimeTransitionIntentV1,
        predecessor_operation_id: OperationIdV1,
    ) -> Result<Self, DomainStoreErrorV1> {
        Self::successor_after_stopped_source(intent, predecessor_operation_id, None)
    }

    fn successor_after_stopped_source(
        intent: AgentRuntimeTransitionIntentV1,
        predecessor_operation_id: OperationIdV1,
        replacement_authority: Option<AgentRuntimeReplacementAuthorityV1>,
    ) -> Result<Self, DomainStoreErrorV1> {
        intent.validate_after_stopped_source()?;
        if intent.operation_id == predecessor_operation_id {
            return Err(invalid(
                "predecessorOperationId",
                "must differ from the successor operation",
            ));
        }
        let requested_at_ms = intent.requested_at_ms;
        let record = Self {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            intent,
            state: AgentRuntimeTransitionStateV1::SourceStopped,
            deferred_target: None,
            target_authority: None,
            target_launch_idempotency_key: None,
            replacement_authority,
            target_failure: None,
            last_repair_operation_id: None,
            predecessor_operation_id: Some(predecessor_operation_id),
            superseded_by_operation_id: None,
            journal_revision: 1,
            created_at_ms: requested_at_ms,
            updated_at_ms: requested_at_ms,
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime transition record schema",
            ));
        }
        deferred::validate(self)?;
        if self.predecessor_operation_id.is_some() || self.deferred_target.is_some() {
            self.intent.validate_after_stopped_source()?;
        } else {
            self.intent.validate()?;
        }
        timestamp("createdAtMs", self.created_at_ms)?;
        timestamp("updatedAtMs", self.updated_at_ms)?;
        if self.created_at_ms != self.intent.requested_at_ms
            || self.updated_at_ms < self.created_at_ms
        {
            return Err(invalid(
                "updatedAtMs",
                "transition timestamps are inconsistent",
            ));
        }
        positive("journalRevision", self.journal_revision)?;
        let successor = self.predecessor_operation_id.is_some();
        history::validate(self)?;
        if self.state == AgentRuntimeTransitionStateV1::Admitted && successor {
            return Err(invalid(
                "predecessorOperationId",
                "a successor starts after the stopped-source boundary",
            ));
        }
        if let Some(authority) = &self.replacement_authority {
            authority.validate_for_transition_identity(
                &self.intent.source.agent_id,
                &self.intent.source.provider_id,
                &self.intent.provider_conversation_ref,
            )?;
            if !matches!(
                self.state,
                AgentRuntimeTransitionStateV1::SourceStopped
                    | AgentRuntimeTransitionStateV1::RepairRequired
                    | AgentRuntimeTransitionStateV1::Superseded
            ) || self.state == AgentRuntimeTransitionStateV1::SourceStopped
                && self.last_repair_operation_id.is_none()
                && self.predecessor_operation_id.is_none()
            {
                return Err(invalid(
                    "replacementAuthority",
                    "is only valid while an authorized target effect remains pending",
                ));
            }
        }
        if self
            .predecessor_operation_id
            .as_ref()
            .is_some_and(|operation| operation == &self.intent.operation_id)
            || self
                .last_repair_operation_id
                .as_ref()
                .is_some_and(|operation| operation == &self.intent.operation_id)
            || self.last_repair_operation_id.is_some()
                && self.last_repair_operation_id == self.predecessor_operation_id
            || self.last_repair_operation_id.is_some()
                && self.last_repair_operation_id == self.superseded_by_operation_id
            || self.predecessor_operation_id.is_some()
                && self.predecessor_operation_id == self.superseded_by_operation_id
        {
            return Err(invalid(
                "operationId",
                "transition, predecessor, and repair operations must be distinct",
            ));
        }
        if let Some(key) = &self.target_launch_idempotency_key {
            validate_token("targetLaunchIdempotencyKey", key)?;
        }
        match (&self.state, &self.target_authority, &self.target_failure) {
            (
                AgentRuntimeTransitionStateV1::Admitted
                | AgentRuntimeTransitionStateV1::SourceRetained
                | AgentRuntimeTransitionStateV1::SourceStopped,
                None,
                None,
            ) => Ok(()),
            (
                AgentRuntimeTransitionStateV1::TargetStarted
                | AgentRuntimeTransitionStateV1::Committed,
                Some(authority),
                None,
            ) => {
                authority.validate_for_transition_target(
                    &self.intent.target_selection_at(self.updated_at_ms)?,
                    &self.intent.provider_conversation_ref,
                )?;
                if matches!(
                    authority,
                    AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. }
                ) && self.target_launch_idempotency_key.is_some()
                {
                    return Err(invalid(
                        "targetLaunchIdempotencyKey",
                        "is only valid for a native target",
                    ));
                }
                if let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = authority {
                    let target_attempt_operation_id = self
                        .last_repair_operation_id
                        .as_ref()
                        .unwrap_or(&self.intent.operation_id);
                    validate_recorded_agent_runtime_native_launch_identity_v1(
                        target_attempt_operation_id,
                        &authority.binding.session_id,
                        self.target_launch_idempotency_key.as_deref(),
                    )?;
                }
                Ok(())
            }
            (
                AgentRuntimeTransitionStateV1::RepairRequired
                | AgentRuntimeTransitionStateV1::Superseded,
                None,
                Some(failure),
            ) => {
                failure.validate()?;
                Ok(())
            }
            (AgentRuntimeTransitionStateV1::Superseded, None, None)
                if self.target_is_deferred() =>
            {
                Ok(())
            }
            _ => Err(invalid(
                "targetOutcome",
                "authority or failure presence does not match the transition state",
            )),
        }?;
        if !matches!(
            self.state,
            AgentRuntimeTransitionStateV1::TargetStarted | AgentRuntimeTransitionStateV1::Committed
        ) && self.target_launch_idempotency_key.is_some()
        {
            return Err(invalid(
                "targetLaunchIdempotencyKey",
                "is only valid after the target starts",
            ));
        }
        match (&self.state, &self.superseded_by_operation_id) {
            (AgentRuntimeTransitionStateV1::Superseded, Some(operation_id))
                if operation_id != &self.intent.operation_id =>
            {
                Ok(())
            }
            (AgentRuntimeTransitionStateV1::Superseded, _) => Err(invalid(
                "supersededByOperationId",
                "a superseded transition must identify a distinct successor",
            )),
            (_, None) => Ok(()),
            _ => Err(invalid(
                "supersededByOperationId",
                "is only valid for a superseded transition",
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentRuntimeTransitionAdvanceV1 {
    SourceRetained,
    SourceStopped,
    RepairRequired {
        failure: AgentRuntimeTargetFailureV1,
        replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1,
    },
    TargetStarted {
        authority: Box<AgentRuntimeBindingAuthorityV1>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        launch_idempotency_key: Option<String>,
    },
    Committed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeTransitionAdvanceRequestV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub expected_journal_revision: i64,
    pub advance: AgentRuntimeTransitionAdvanceV1,
    pub advanced_at_ms: i64,
}

impl AgentRuntimeTransitionAdvanceRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime transition advance schema",
            ));
        }
        positive("expectedJournalRevision", self.expected_journal_revision)?;
        if let AgentRuntimeTransitionAdvanceV1::TargetStarted {
            authority,
            launch_idempotency_key,
        } = &self.advance
        {
            match (authority.as_ref(), launch_idempotency_key) {
                (AgentRuntimeBindingAuthorityV1::NativeCli { .. }, Some(key)) => {
                    validate_token("targetLaunchIdempotencyKey", key)?;
                }
                (AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. }, None)
                | (AgentRuntimeBindingAuthorityV1::NativeCli { .. }, None) => {}
                (AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. }, Some(_)) => {
                    return Err(invalid(
                        "targetLaunchIdempotencyKey",
                        "is only valid for a native target",
                    ));
                }
            }
        }
        timestamp("advancedAtMs", self.advanced_at_ms)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeTransitionRepairRequestV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub expected_journal_revision: i64,
    pub repair_operation_id: OperationIdV1,
    pub repaired_at_ms: i64,
}

/// Distinguishes the one journal mutation that grants target effects from a
/// transport replay that may only observe the resulting transition record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentRuntimeTransitionEffectAuthorizationV1 {
    Authorized(AgentRuntimeTransitionRecordV1),
    Replayed(AgentRuntimeTransitionRecordV1),
}

impl AgentRuntimeTransitionRepairRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime transition repair schema",
            ));
        }
        positive("expectedJournalRevision", self.expected_journal_revision)?;
        timestamp("repairedAtMs", self.repaired_at_ms)?;
        if self.operation_id == self.repair_operation_id {
            return Err(invalid(
                "repairOperationId",
                "must differ from the transition operation",
            ));
        }
        Ok(())
    }
}

/// Consumes one exact repair authorization. Replaying its operation identity
/// returns the current record at any later stage and cannot authorize another
/// target effect.
pub fn authorize_agent_runtime_transition_repair_v1(
    current: &AgentRuntimeTransitionRecordV1,
    request: &AgentRuntimeTransitionRepairRequestV1,
) -> Result<AgentRuntimeTransitionEffectAuthorizationV1, DomainStoreErrorV1> {
    current.validate()?;
    request.validate()?;
    if current.intent.operation_id != request.operation_id {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent runtime transition repair",
            id: request.operation_id.as_str().into(),
            reason: "transition operation identity changed".into(),
        });
    }
    if current.last_repair_operation_id.as_ref() == Some(&request.repair_operation_id) {
        return Ok(AgentRuntimeTransitionEffectAuthorizationV1::Replayed(
            current.clone(),
        ));
    }
    if current.journal_revision != request.expected_journal_revision {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.intent.source.agent_id.as_str().into(),
            expected_revision: request.expected_journal_revision,
            actual_revision: Some(current.journal_revision),
        });
    }
    if current.state != AgentRuntimeTransitionStateV1::RepairRequired {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "runtime transition repair requires repair_required state".into(),
        });
    }
    if request.repaired_at_ms < current.updated_at_ms {
        return Err(invalid("repairedAtMs", "must not move backward"));
    }
    let mut next = current.clone();
    next.state = AgentRuntimeTransitionStateV1::SourceStopped;
    next.target_failure = None;
    next.last_repair_operation_id = Some(request.repair_operation_id.clone());
    next.journal_revision += 1;
    next.updated_at_ms = request.repaired_at_ms;
    next.validate()?;
    Ok(AgentRuntimeTransitionEffectAuthorizationV1::Authorized(
        next,
    ))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeTransitionSupersedeRequestV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub expected_journal_revision: i64,
    pub successor_intent: AgentRuntimeTransitionIntentV1,
    pub superseded_at_ms: i64,
}

impl AgentRuntimeTransitionSupersedeRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime transition supersede schema",
            ));
        }
        positive("expectedJournalRevision", self.expected_journal_revision)?;
        self.successor_intent.validate_after_stopped_source()?;
        timestamp("supersededAtMs", self.superseded_at_ms)?;
        if self.successor_intent.requested_at_ms != self.superseded_at_ms {
            return Err(invalid(
                "supersededAtMs",
                "must equal the successor request timestamp",
            ));
        }
        Ok(())
    }
}

pub fn supersede_agent_runtime_transition_v1(
    current: &AgentRuntimeTransitionRecordV1,
    request: &AgentRuntimeTransitionSupersedeRequestV1,
) -> Result<
    (
        AgentRuntimeTransitionRecordV1,
        AgentRuntimeTransitionRecordV1,
    ),
    DomainStoreErrorV1,
> {
    current.validate()?;
    request.validate()?;
    if current.intent.operation_id != request.operation_id {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent runtime transition supersede",
            id: request.operation_id.as_str().into(),
            reason: "transition operation identity changed".into(),
        });
    }
    if current.journal_revision != request.expected_journal_revision {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.intent.source.agent_id.as_str().into(),
            expected_revision: request.expected_journal_revision,
            actual_revision: Some(current.journal_revision),
        });
    }
    if current.state != AgentRuntimeTransitionStateV1::RepairRequired {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "only repair_required transitions may be superseded".into(),
        });
    }
    let successor = &request.successor_intent;
    if successor.source != current.intent.source
        || successor.source_authority != current.intent.source_authority
        || successor.source_stop_policy != current.intent.source_stop_policy
        || successor.provider_conversation_ref != current.intent.provider_conversation_ref
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent runtime transition successor",
            id: successor.operation_id.as_str().into(),
            reason: "successor changed the stopped source or provider conversation".into(),
        });
    }
    if successor.operation_id == current.intent.operation_id
        || successor.idempotency_key == current.intent.idempotency_key
    {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "successor must have a distinct operation and idempotency key".into(),
        });
    }
    if request.superseded_at_ms < current.updated_at_ms {
        return Err(invalid("supersededAtMs", "must not move backward"));
    }

    let successor_record = AgentRuntimeTransitionRecordV1::successor_after_stopped_source(
        successor.clone(),
        current.intent.operation_id.clone(),
        current.replacement_authority.clone(),
    )?;
    let mut superseded = current.clone();
    superseded.state = AgentRuntimeTransitionStateV1::Superseded;
    // The atomic supersede transaction moves the one live replacement fence
    // into the successor. The predecessor keeps its typed diagnostic but no
    // second copy of effect authority.
    superseded.replacement_authority = None;
    superseded.superseded_by_operation_id = Some(successor.operation_id.clone());
    superseded.journal_revision += 1;
    superseded.updated_at_ms = request.superseded_at_ms;
    superseded.validate()?;
    Ok((superseded, successor_record))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentProviderRuntimeFenceV1, AgentTimelineEpochV1,
        RuntimeKindIdV1, SessionBindingRecordV1,
    };

    fn native_selection() -> AgentRuntimeSelectionV1 {
        AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "account-work".into(),
                credential_generation: Some("credential-v1".into()),
            },
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 100,
        }
    }

    #[test]
    fn native_host_selection_may_leave_a_credential_generation_unclaimed() {
        let mut adopted = native_selection();
        adopted.execution_profile = AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-work".into(),
            credential_generation: None,
        };

        adopted.validate().unwrap();

        let mut replaced_native = adopted.clone();
        replaced_native.revision = 2;
        replaced_native.selected_by_operation_id =
            Some(OperationIdV1::new("replacement-1").unwrap());
        replaced_native.validate().unwrap();

        let mut structured = adopted;
        structured.interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
        assert!(structured.validate().is_err());
    }

    fn native_authority() -> AgentRuntimeBindingAuthorityV1 {
        AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: AgentCheckpointBindingAuthorityV1 {
                schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
                binding: SessionBindingRecordV1 {
                    agent_id: AgentIdV1::new("agent-1").unwrap(),
                    runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                    session_id: "session-1".into(),
                    provider_conversation_id: Some("conversation-1".into()),
                    credential_reference_id: Some("account-work".into()),
                    binding_generation: 1,
                    bound_at_ms: 90,
                },
                runtime_workspace_id: "workspace-1".into(),
                runner_principal: "runner-principal-1".into(),
                runner_instance: "runner-instance-1".into(),
                channel_epoch: "1".into(),
                host_instance_id: "host-instance-1".into(),
                terminal_epoch: "terminal-epoch-1".into(),
                updated_at_ms: 100,
            },
        }
    }

    fn native_authority_with_conversation(
        provider_conversation_id: Option<&str>,
    ) -> AgentRuntimeBindingAuthorityV1 {
        let mut binding_authority = native_authority();
        let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = &mut binding_authority else {
            unreachable!();
        };
        authority.binding.provider_conversation_id = provider_conversation_id.map(str::to_string);
        binding_authority
    }

    fn intent() -> AgentRuntimeTransitionIntentV1 {
        AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("runtime-transition-1").unwrap(),
            idempotency_key: "switch-agent-1-to-chat".into(),
            source: native_selection(),
            source_authority: native_authority(),
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: AgentProviderConversationPlanV1::resume("conversation-1")
                .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: native_selection().execution_profile,
            target_launch_selection: None,
            requested_at_ms: 110,
        }
    }

    #[test]
    fn deferred_legacy_credential_pins_only_the_same_native_account() {
        let mut plan = intent();
        plan.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
        plan.source.execution_profile = AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-work".into(),
            credential_generation: None,
        };
        let admitted = AgentRuntimeTransitionRecordV1::admitted_deferred(plan.clone()).unwrap();
        assert_eq!(admitted.intent.source, plan.source);
        assert_eq!(
            admitted.intent.target_execution_profile,
            plan.target_execution_profile
        );
        for target in [
            AgentExecutionProfileV1::ProviderDefault,
            AgentExecutionProfileV1::CredentialReference {
                reference_id: "another-account".into(),
                credential_generation: Some("another-generation".into()),
            },
            plan.source.execution_profile.clone(),
        ] {
            let mut changed = plan.clone();
            changed.target_execution_profile = target;
            assert!(AgentRuntimeTransitionRecordV1::admitted_deferred(changed).is_err());
        }
        let mut pinned = plan.clone();
        pinned.source.execution_profile = AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-work".into(),
            credential_generation: Some("known-source-generation".into()),
        };
        assert!(AgentRuntimeTransitionRecordV1::admitted_deferred(pinned).is_err());
        plan.target_interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
        assert!(AgentRuntimeTransitionRecordV1::admitted_deferred(plan).is_err());
    }

    #[test]
    fn fresh_provider_conversation_round_trips_as_exact_null() {
        let mut encoded = serde_json::to_value(intent()).unwrap();
        encoded["providerConversationRef"] = serde_json::Value::Null;
        encoded["sourceAuthority"]["authority"]["binding"]["providerConversationId"] =
            serde_json::Value::Null;

        let decoded: AgentRuntimeTransitionIntentV1 =
            serde_json::from_value(encoded).expect("fresh conversation intent must deserialize");
        decoded.validate().unwrap();
        assert_eq!(
            serde_json::to_value(decoded).unwrap()["providerConversationRef"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn conversation_plan_rejects_invalid_resume_tokens_at_deserialization() {
        let error = serde_json::from_str::<AgentProviderConversationPlanV1>(
            r#""conversation with spaces""#,
        )
        .expect_err("invalid persisted conversation token must be rejected while parsing");

        assert!(error.to_string().contains("providerConversationRef"));
    }

    #[test]
    fn conversation_plan_uses_the_durable_provider_token_boundary() {
        assert!(AgentProviderConversationPlanV1::resume("threads/2026-08-30:turn_1").is_ok());
        assert!(AgentProviderConversationPlanV1::resume(format!("/{}", "a".repeat(159))).is_ok());
        assert!(AgentProviderConversationPlanV1::resume(format!("/{}", "a".repeat(160))).is_err());
        assert!(AgentProviderConversationPlanV1::resume("conversation+alias").is_err());
    }

    fn fresh_intent() -> AgentRuntimeTransitionIntentV1 {
        let mut fresh = intent();
        fresh.provider_conversation_ref = AgentProviderConversationPlanV1::fresh();
        fresh.source_authority = native_authority_with_conversation(None);
        fresh
    }

    fn structured_authority() -> AgentRuntimeBindingAuthorityV1 {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: AgentInteractionBindingV1 {
                schema_version: 1,
                interaction_session_id: crate::AgentInteractionSessionIdV1::new("interaction-1")
                    .unwrap(),
                agent_id: AgentIdV1::new("agent-1").unwrap(),
                provider_id: ProviderIdV1::new("claude").unwrap(),
                execution_profile: native_selection().execution_profile,
                provider_conversation_ref: Some("conversation-1".into()),
                runtime: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "runtime-generation-2".into(),
                    provider_epoch: "provider-epoch-2".into(),
                },
                timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
                binding_revision: 1,
                history_complete: true,
                created_at_ms: 120,
                updated_at_ms: 120,
            },
        }
    }

    fn structured_authority_with_conversation(
        provider_conversation_ref: Option<&str>,
    ) -> AgentRuntimeBindingAuthorityV1 {
        let mut authority = structured_authority();
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = &mut authority else {
            unreachable!();
        };
        binding.provider_conversation_ref = provider_conversation_ref.map(str::to_string);
        authority
    }

    #[test]
    fn conversation_plan_is_exact_at_the_source_and_adapter_proven_at_the_target() {
        let fresh_native = fresh_intent();
        fresh_native.validate().unwrap();

        let mut fresh_structured = fresh_native.clone();
        fresh_structured.source.interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
        fresh_structured.source_authority = structured_authority_with_conversation(None);
        fresh_structured.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
        fresh_structured.validate().unwrap();

        let mut fresh_with_existing_source = fresh_native.clone();
        fresh_with_existing_source.source_authority = native_authority();
        assert!(fresh_with_existing_source.validate().is_err());

        let mut resume_without_source = intent();
        resume_without_source.source_authority = native_authority_with_conversation(None);
        assert!(resume_without_source.validate().is_err());
        let mut resume_changed_source = intent();
        resume_changed_source.provider_conversation_ref =
            AgentProviderConversationPlanV1::resume("conversation-other").unwrap();
        assert!(resume_changed_source.validate().is_err());

        let fresh_stopped = advance_agent_runtime_transition_v1(
            &AgentRuntimeTransitionRecordV1::admitted(fresh_native.clone()).unwrap(),
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: fresh_native.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        for (conversation, expected) in [
            (None, None),
            (
                Some("conversation-allocated"),
                Some("conversation-allocated"),
            ),
        ] {
            let started = advance_agent_runtime_transition_v1(
                &fresh_stopped,
                &AgentRuntimeTransitionAdvanceRequestV1 {
                    schema_version: 1,
                    operation_id: fresh_native.operation_id.clone(),
                    expected_journal_revision: 2,
                    advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                        launch_idempotency_key: None,
                        authority: Box::new(structured_authority_with_conversation(conversation)),
                    },
                    advanced_at_ms: 130,
                },
            )
            .unwrap();
            assert_eq!(
                started
                    .target_authority
                    .as_ref()
                    .and_then(AgentRuntimeBindingAuthorityV1::provider_conversation_ref),
                expected
            );
        }

        let resume_stopped = advance_agent_runtime_transition_v1(
            &AgentRuntimeTransitionRecordV1::admitted(intent()).unwrap(),
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: intent().operation_id,
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        for conversation in [None, Some("conversation-other")] {
            assert!(
                advance_agent_runtime_transition_v1(
                    &resume_stopped,
                    &AgentRuntimeTransitionAdvanceRequestV1 {
                        schema_version: 1,
                        operation_id: resume_stopped.intent.operation_id.clone(),
                        expected_journal_revision: 2,
                        advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                            launch_idempotency_key: None,
                            authority: Box::new(structured_authority_with_conversation(
                                conversation
                            )),
                        },
                        advanced_at_ms: 130,
                    },
                )
                .is_err()
            );
        }
    }

    #[test]
    fn fresh_failed_target_retains_its_new_exact_conversation_authority() {
        let admitted = AgentRuntimeTransitionRecordV1::admitted(fresh_intent()).unwrap();
        let stopped = advance_agent_runtime_transition_v1(
            &admitted,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: admitted.intent.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        let failed_authority = AgentRuntimeReplacementAuthorityV1(
            structured_authority_with_conversation(Some("conversation-allocated-before-failure")),
        );
        let parked = advance_agent_runtime_transition_v1(
            &stopped,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: stopped.intent.operation_id.clone(),
                expected_journal_revision: 2,
                advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                    failure: AgentRuntimeTargetFailureV1::new(
                        AgentRuntimeTargetFailureKindV1::LaunchFailed,
                        "structured_target_failed_after_identity",
                    )
                    .unwrap(),
                    replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                        authority: Some(Box::new(failed_authority.clone())),
                    },
                },
                advanced_at_ms: 130,
            },
        )
        .unwrap();
        let reopened: AgentRuntimeTransitionRecordV1 =
            serde_json::from_value(serde_json::to_value(&parked).unwrap()).unwrap();

        assert_eq!(reopened.replacement_authority, Some(failed_authority));
        assert_eq!(
            reopened
                .replacement_authority
                .as_ref()
                .and_then(|authority| authority.0.provider_conversation_ref()),
            Some("conversation-allocated-before-failure")
        );
    }

    #[test]
    fn profile_switch_preserves_execution_and_advances_exactly_once_per_stage() {
        let admitted = AgentRuntimeTransitionRecordV1::admitted(intent()).unwrap();
        let stopped_request = AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 120,
        };
        let stopped = advance_agent_runtime_transition_v1(&admitted, &stopped_request).unwrap();
        assert_eq!(
            advance_agent_runtime_transition_v1(&stopped, &stopped_request).unwrap(),
            stopped
        );
        let started_request = AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: stopped.intent.operation_id.clone(),
            expected_journal_revision: 2,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(structured_authority()),
            },
            advanced_at_ms: 130,
        };
        let started = advance_agent_runtime_transition_v1(&stopped, &started_request).unwrap();
        let committed = advance_agent_runtime_transition_v1(
            &started,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: started.intent.operation_id.clone(),
                expected_journal_revision: 3,
                advance: AgentRuntimeTransitionAdvanceV1::Committed,
                advanced_at_ms: 140,
            },
        )
        .unwrap();

        assert_eq!(committed.state, AgentRuntimeTransitionStateV1::Committed);
        let target = committed.intent.target_selection_at(140).unwrap();
        assert_eq!(target.revision, 2);
        assert_eq!(
            target.execution_profile,
            native_selection().execution_profile
        );
        assert_eq!(
            target.interaction_profile,
            AgentInteractionProfileV1::StructuredProtocol
        );
    }

    #[test]
    fn retained_source_terminates_the_exact_attempt_idempotently() {
        let admitted = AgentRuntimeTransitionRecordV1::admitted(intent()).unwrap();
        let retain = AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceRetained,
            advanced_at_ms: 120,
        };
        let retained = advance_agent_runtime_transition_v1(&admitted, &retain).unwrap();

        assert_eq!(
            retained.state,
            AgentRuntimeTransitionStateV1::SourceRetained
        );
        assert_eq!(retained.journal_revision, 2);
        assert_eq!(
            advance_agent_runtime_transition_v1(&retained, &retain).unwrap(),
            retained
        );
    }

    #[test]
    fn destructive_source_stop_policy_round_trips_in_the_durable_intent() {
        assert!(AgentRuntimeSourceStopPolicyV1::Preserve.requires_idle());
        assert!(!AgentRuntimeSourceStopPolicyV1::Discard.requires_idle());

        let legacy = serde_json::to_value(intent()).unwrap();
        assert!(legacy.get("sourceStopPolicy").is_none());
        let legacy: AgentRuntimeTransitionIntentV1 = serde_json::from_value(legacy).unwrap();
        assert_eq!(
            legacy.source_stop_policy,
            AgentRuntimeSourceStopPolicyV1::Preserve
        );

        let mut encoded = serde_json::to_value(intent()).unwrap();
        encoded["sourceStopPolicy"] = serde_json::json!("discard");

        let decoded: AgentRuntimeTransitionIntentV1 = serde_json::from_value(encoded).unwrap();

        assert_eq!(
            serde_json::to_value(decoded).unwrap()["sourceStopPolicy"],
            serde_json::json!("discard")
        );
    }

    #[test]
    fn profile_switch_preserves_reasoning_effort() {
        let mut source = serde_json::to_value(native_selection()).unwrap();
        source["effort"] = serde_json::json!("xhigh");
        let source = serde_json::from_value(source).unwrap();
        let mut replacement = intent();
        replacement.source = source;

        let target = replacement.target_selection_at(120).unwrap();

        assert_eq!(
            serde_json::to_value(target).unwrap()["effort"],
            serde_json::json!("xhigh")
        );
    }

    #[test]
    fn selection_only_transition_replaces_model_and_effort_in_place() {
        // Same interaction + execution profile; only the launch selection moves.
        let mut switch = intent();
        switch.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
        switch.target_execution_profile = switch.source.execution_profile.clone();
        assert!(matches!(
            switch.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "target",
                ..
            })
        ));

        switch.target_launch_selection = Some(AgentRuntimeLaunchSelectionV1 {
            model: Some(AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
            effort: Some(AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
            permission_mode: None,
        });
        switch.validate().unwrap();

        let target = switch.target_selection_at(120).unwrap();
        assert_eq!(
            serde_json::to_value(&target).unwrap()["model"],
            serde_json::json!("gpt-5.6-sol")
        );
        assert_eq!(
            serde_json::to_value(&target).unwrap()["effort"],
            serde_json::json!("xhigh")
        );

        // A full snapshot with None values clears the selection back to Auto.
        let mut source = serde_json::to_value(native_selection()).unwrap();
        source["model"] = serde_json::json!("gpt-5.6-sol");
        let mut clearing = intent();
        clearing.source = serde_json::from_value(source).unwrap();
        clearing.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
        clearing.target_execution_profile = clearing.source.execution_profile.clone();
        clearing.target_launch_selection = Some(AgentRuntimeLaunchSelectionV1 {
            model: None,
            effort: None,
            permission_mode: None,
        });
        clearing.validate().unwrap();
        let cleared = clearing.target_selection_at(120).unwrap();
        assert_eq!(cleared.model, None);
        assert_eq!(cleared.effort, None);

        // A snapshot equal to the source changes nothing and is rejected.
        let mut noop = intent();
        noop.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
        noop.target_execution_profile = noop.source.execution_profile.clone();
        noop.target_launch_selection = Some(AgentRuntimeLaunchSelectionV1 {
            model: noop.source.model.clone(),
            effort: noop.source.effort.clone(),
            permission_mode: None,
        });
        assert!(matches!(
            noop.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "target",
                ..
            })
        ));
    }

    #[test]
    fn persisted_native_successor_requires_its_effective_create_key() {
        let mut switch = intent();
        switch.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
        switch.target_execution_profile = switch.source.execution_profile.clone();
        switch.target_launch_selection = Some(AgentRuntimeLaunchSelectionV1 {
            model: Some(AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
            effort: None,
            permission_mode: None,
        });
        let admitted = AgentRuntimeTransitionRecordV1::admitted(switch).unwrap();
        let stopped = advance_agent_runtime_transition_v1(
            &admitted,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: admitted.intent.operation_id.clone(),
                expected_journal_revision: admitted.journal_revision,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        let mut persisted = advance_agent_runtime_transition_v1(
            &stopped,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: stopped.intent.operation_id.clone(),
                expected_journal_revision: stopped.journal_revision,
                advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                    authority: Box::new(native_authority()),
                    launch_idempotency_key: Some("runtime-native-successor-key".into()),
                },
                advanced_at_ms: 130,
            },
        )
        .unwrap();

        persisted.target_launch_idempotency_key = None;

        assert!(persisted.validate().is_err());
    }

    #[test]
    fn one_transition_can_replace_interaction_and_credentials_from_one_snapshot() {
        let mut replacement = intent();
        replacement.target_execution_profile = AgentExecutionProfileV1::ProviderDefault;
        replacement.validate().unwrap();

        let target = replacement.target_selection_at(120).unwrap();
        assert_eq!(
            target.interaction_profile,
            AgentInteractionProfileV1::StructuredProtocol
        );
        assert_eq!(
            target.execution_profile,
            AgentExecutionProfileV1::ProviderDefault
        );
    }

    #[test]
    fn target_authority_must_keep_the_exact_conversation_and_credential() {
        let admitted = AgentRuntimeTransitionRecordV1::admitted(intent()).unwrap();
        let stopped = advance_agent_runtime_transition_v1(
            &admitted,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: admitted.intent.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        let mut wrong = structured_authority();
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = &mut wrong else {
            unreachable!();
        };
        binding.provider_conversation_ref = Some("conversation-other".into());

        assert!(
            advance_agent_runtime_transition_v1(
                &stopped,
                &AgentRuntimeTransitionAdvanceRequestV1 {
                    schema_version: 1,
                    operation_id: stopped.intent.operation_id.clone(),
                    expected_journal_revision: 2,
                    advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                        launch_idempotency_key: None,
                        authority: Box::new(wrong),
                    },
                    advanced_at_ms: 130,
                },
            )
            .is_err()
        );
    }

    #[test]
    fn repair_replay_observes_the_later_failure_without_reopening_it() {
        let admitted = AgentRuntimeTransitionRecordV1::admitted(intent()).unwrap();
        let stopped = advance_agent_runtime_transition_v1(
            &admitted,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: admitted.intent.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        let failure = AgentRuntimeTargetFailureV1::new(
            AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
            "claude_credential_unavailable",
        )
        .unwrap();
        let parked = advance_agent_runtime_transition_v1(
            &stopped,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: stopped.intent.operation_id.clone(),
                expected_journal_revision: 2,
                advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                    failure: failure.clone(),
                    replacement_authority:
                        AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
                },
                advanced_at_ms: 130,
            },
        )
        .unwrap();
        let request = AgentRuntimeTransitionRepairRequestV1 {
            schema_version: 1,
            operation_id: parked.intent.operation_id.clone(),
            expected_journal_revision: parked.journal_revision,
            repair_operation_id: OperationIdV1::new("runtime-repair-1").unwrap(),
            repaired_at_ms: 140,
        };
        let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(authorized) =
            authorize_agent_runtime_transition_repair_v1(&parked, &request).unwrap()
        else {
            panic!("the first exact repair must grant one authorization")
        };
        let failed_again = advance_agent_runtime_transition_v1(
            &authorized,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: authorized.intent.operation_id.clone(),
                expected_journal_revision: authorized.journal_revision,
                advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                    failure,
                    replacement_authority:
                        AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
                },
                advanced_at_ms: 150,
            },
        )
        .unwrap();

        assert_eq!(
            authorize_agent_runtime_transition_repair_v1(&failed_again, &request).unwrap(),
            AgentRuntimeTransitionEffectAuthorizationV1::Replayed(failed_again.clone())
        );
        assert_eq!(
            failed_again.state,
            AgentRuntimeTransitionStateV1::RepairRequired
        );
    }

    #[test]
    fn an_older_exact_repair_cannot_reopen_a_later_repair_revision() {
        let admitted = AgentRuntimeTransitionRecordV1::admitted(intent()).unwrap();
        let stopped = advance_agent_runtime_transition_v1(
            &admitted,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: admitted.intent.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        let failure = AgentRuntimeTargetFailureV1::new(
            AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
            "claude_credential_unavailable",
        )
        .unwrap();
        let park = |current: &AgentRuntimeTransitionRecordV1, at| {
            advance_agent_runtime_transition_v1(
                current,
                &AgentRuntimeTransitionAdvanceRequestV1 {
                    schema_version: 1,
                    operation_id: current.intent.operation_id.clone(),
                    expected_journal_revision: current.journal_revision,
                    advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                        failure: failure.clone(),
                        replacement_authority:
                            AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
                    },
                    advanced_at_ms: at,
                },
            )
            .unwrap()
        };
        let first_parked = park(&stopped, 130);
        let first_request = AgentRuntimeTransitionRepairRequestV1 {
            schema_version: 1,
            operation_id: first_parked.intent.operation_id.clone(),
            expected_journal_revision: first_parked.journal_revision,
            repair_operation_id: OperationIdV1::new("runtime-repair-revision-3").unwrap(),
            repaired_at_ms: 140,
        };
        let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(first_authorized) =
            authorize_agent_runtime_transition_repair_v1(&first_parked, &first_request).unwrap()
        else {
            panic!("the first exact repair must be authorized")
        };
        let second_parked = park(&first_authorized, 150);
        let second_request = AgentRuntimeTransitionRepairRequestV1 {
            schema_version: 1,
            operation_id: second_parked.intent.operation_id.clone(),
            expected_journal_revision: second_parked.journal_revision,
            repair_operation_id: OperationIdV1::new("runtime-repair-revision-5").unwrap(),
            repaired_at_ms: 160,
        };
        let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(second_authorized) =
            authorize_agent_runtime_transition_repair_v1(&second_parked, &second_request).unwrap()
        else {
            panic!("the newer exact repair must be authorized")
        };
        let third_parked = park(&second_authorized, 170);

        assert!(matches!(
            authorize_agent_runtime_transition_repair_v1(&third_parked, &first_request),
            Err(DomainStoreErrorV1::RevisionConflict { .. })
        ));
        assert_eq!(
            third_parked.last_repair_operation_id,
            Some(second_request.repair_operation_id),
            "the stale repair must not replace the current authorization receipt"
        );
    }

    #[test]
    fn corrected_successor_preserves_the_stopped_source_and_conversation() {
        let admitted = AgentRuntimeTransitionRecordV1::admitted(intent()).unwrap();
        let stopped = advance_agent_runtime_transition_v1(
            &admitted,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: admitted.intent.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 120,
            },
        )
        .unwrap();
        let parked = advance_agent_runtime_transition_v1(
            &stopped,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: stopped.intent.operation_id.clone(),
                expected_journal_revision: 2,
                advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                    failure: AgentRuntimeTargetFailureV1::new(
                        AgentRuntimeTargetFailureKindV1::LaunchFailed,
                        "claude_launch_failed",
                    )
                    .unwrap(),
                    replacement_authority:
                        AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
                },
                advanced_at_ms: 130,
            },
        )
        .unwrap();
        let mut successor_intent = parked.intent.clone();
        successor_intent.operation_id = OperationIdV1::new("runtime-transition-2").unwrap();
        successor_intent.idempotency_key = "switch-agent-1-to-chat-corrected".into();
        successor_intent.target_execution_profile = AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-corrected".into(),
            credential_generation: Some("credential-corrected-1".into()),
        };
        successor_intent.target_launch_selection = Some(AgentRuntimeLaunchSelectionV1 {
            model: Some(AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
            effort: None,
            permission_mode: None,
        });
        successor_intent.requested_at_ms = 140;
        let (superseded, successor) = supersede_agent_runtime_transition_v1(
            &parked,
            &AgentRuntimeTransitionSupersedeRequestV1 {
                schema_version: 1,
                operation_id: parked.intent.operation_id.clone(),
                expected_journal_revision: parked.journal_revision,
                successor_intent,
                superseded_at_ms: 140,
            },
        )
        .unwrap();

        assert_eq!(superseded.state, AgentRuntimeTransitionStateV1::Superseded);
        assert_eq!(
            successor.state,
            AgentRuntimeTransitionStateV1::SourceStopped
        );
        assert_eq!(successor.intent.source, parked.intent.source);
        assert_eq!(
            successor.intent.source_authority,
            parked.intent.source_authority
        );
        assert_eq!(
            successor.intent.provider_conversation_ref,
            parked.intent.provider_conversation_ref
        );
        assert_eq!(
            successor.predecessor_operation_id,
            Some(parked.intent.operation_id.clone())
        );
        assert_ne!(
            successor.intent.target_execution_profile, successor.intent.source.execution_profile,
            "a corrected successor may change both target profile and credential after stop"
        );

        let mut restore_source = parked.intent.clone();
        restore_source.operation_id = OperationIdV1::new("runtime-transition-restore").unwrap();
        restore_source.idempotency_key = "switch-agent-1-restore-source".into();
        restore_source.target_interaction_profile = parked.intent.source.interaction_profile;
        restore_source.target_execution_profile = parked.intent.source.execution_profile.clone();
        restore_source.requested_at_ms = 140;
        let (_, restored) = supersede_agent_runtime_transition_v1(
            &parked,
            &AgentRuntimeTransitionSupersedeRequestV1 {
                schema_version: 1,
                operation_id: parked.intent.operation_id.clone(),
                expected_journal_revision: parked.journal_revision,
                successor_intent: restore_source,
                superseded_at_ms: 140,
            },
        )
        .unwrap();
        assert_eq!(
            restored.intent.target_interaction_profile,
            restored.intent.source.interaction_profile
        );
        assert_eq!(
            restored.intent.target_execution_profile,
            restored.intent.source.execution_profile
        );

        let mut equivalent_target = parked.intent.clone();
        equivalent_target.operation_id = OperationIdV1::new("runtime-transition-3").unwrap();
        equivalent_target.idempotency_key = "switch-agent-1-to-chat-equivalent".into();
        equivalent_target.target_launch_selection = Some(AgentRuntimeLaunchSelectionV1 {
            model: None,
            effort: None,
            permission_mode: None,
        });
        equivalent_target.requested_at_ms = 140;
        let (_, equivalent) = supersede_agent_runtime_transition_v1(
            &parked,
            &AgentRuntimeTransitionSupersedeRequestV1 {
                schema_version: 1,
                operation_id: parked.intent.operation_id.clone(),
                expected_journal_revision: parked.journal_revision,
                successor_intent: equivalent_target,
                superseded_at_ms: 140,
            },
        )
        .unwrap();
        assert_eq!(
            equivalent.state,
            AgentRuntimeTransitionStateV1::SourceStopped
        );
        assert_eq!(
            equivalent.intent.target_execution_profile,
            parked.intent.target_execution_profile
        );
    }
}
