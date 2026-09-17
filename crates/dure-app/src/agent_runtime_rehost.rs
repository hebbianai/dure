//! Atomic durable convergence for a native session-runtime successor.
//!
//! The native session adapter owns the source-to-successor operation and its
//! process-generation evidence. This contract only publishes that proven
//! successor as the Agent's runtime selection and checkpoint authority.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1,
    AgentInteractionProfileV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeReplacementAuthorityV1,
    AgentRuntimeSelectionV1, AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1,
    DomainStoreErrorV1, OperationIdV1, ProviderPermissionModeV1,
};

pub const AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1: u16 = 1;

/// Exact opaque launch reference admitted by the native session adapter. Its
/// alphabet intentionally differs from Dure operation identifiers.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ProviderLaunchReferenceV1(String);

impl ProviderLaunchReferenceV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainStoreErrorV1> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 256
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
            })
        {
            return Err(invalid(
                "providerLaunchReference",
                "must be one bounded native provider launch identity",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ProviderLaunchReferenceV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for ProviderLaunchReferenceV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn invalid(field: &'static str, reason: impl Into<String>) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

/// One compare-and-swap input after the control plane has validated the native
/// adapter's durable lineage and exact target generation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeNativeRehostCommitV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    /// Root generation of the verified native rehost request. It can precede
    /// the CP compare-and-swap source when CP is converging an already-committed
    /// prefix of the same lineage.
    pub request_source: AgentRuntimeNativeRehostSourceV1,
    pub source_selection: AgentRuntimeSelectionV1,
    pub source_authority: AgentCheckpointBindingAuthorityV1,
    /// Exact failed or dormant transition that this already-running native successor
    /// replaces. The control plane derives this fence from its locked durable
    /// projection; clients never nominate a journal to discard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repair_transition: Option<AgentRuntimeNativeRehostRepairTransitionV1>,
    pub target_authority: AgentCheckpointBindingAuthorityV1,
    pub target_execution_profile: crate::AgentExecutionProfileV1,
    pub target_permission_mode: ProviderPermissionModeV1,
    pub target_launch_idempotency_key: OperationIdV1,
    pub target_provider_launch_reference: Option<ProviderLaunchReferenceV1>,
    pub committed_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeNativeRehostRepairTransitionV1 {
    pub operation_id: OperationIdV1,
    pub expected_journal_revision: i64,
    /// Target-only Resume never retires the superseded replacement. Preserve
    /// its exact authority as quarantined cleanup evidence instead.
    #[serde(default)]
    pub retain_replacement_authority: bool,
    /// Exact dormant structured authority returned after retiring the failed
    /// replacement. Absence is valid only when the repair journal had no
    /// replacement authority to retire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_replacement_authority: Option<AgentRuntimeReplacementAuthorityV1>,
}

impl AgentRuntimeNativeRehostRepairTransitionV1 {
    fn validate_for(
        &self,
        successor_operation_id: &OperationIdV1,
    ) -> Result<(), DomainStoreErrorV1> {
        if self.expected_journal_revision < 1 {
            return Err(invalid(
                "repairTransition.expectedJournalRevision",
                "must be positive",
            ));
        }
        if &self.operation_id == successor_operation_id {
            return Err(invalid(
                "repairTransition.operationId",
                "must differ from the native successor operation",
            ));
        }
        if self.retain_replacement_authority && self.retired_replacement_authority.is_some() {
            return Err(invalid(
                "repairTransition.retiredReplacementAuthority",
                "a retained replacement cannot also carry retirement proof",
            ));
        }
        if let Some(AgentRuntimeReplacementAuthorityV1(
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
        )) = &self.retired_replacement_authority
        {
            binding.validate()?;
        } else if self.retired_replacement_authority.is_some() {
            return Err(invalid(
                "repairTransition.retiredReplacementAuthority",
                "must identify one retired structured replacement",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeNativeRehostSourceV1 {
    pub session_id: String,
    pub workspace_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
}

impl AgentRuntimeNativeRehostSourceV1 {
    pub fn from_authority(authority: &AgentCheckpointBindingAuthorityV1) -> Self {
        Self {
            session_id: authority.binding.session_id.clone(),
            workspace_id: authority.runtime_workspace_id.clone(),
            runner_principal: authority.runner_principal.clone(),
            runner_instance: authority.runner_instance.clone(),
            channel_epoch: authority.channel_epoch.clone(),
            host_instance_id: authority.host_instance_id.clone(),
            terminal_epoch: authority.terminal_epoch.clone(),
        }
    }

    fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        for (field, value) in [
            ("source.sessionId", self.session_id.as_str()),
            ("source.workspaceId", self.workspace_id.as_str()),
            ("source.runnerPrincipal", self.runner_principal.as_str()),
            ("source.runnerInstance", self.runner_instance.as_str()),
            ("source.channelEpoch", self.channel_epoch.as_str()),
            ("source.hostInstanceId", self.host_instance_id.as_str()),
            ("source.terminalEpoch", self.terminal_epoch.as_str()),
        ] {
            crate::domain_store::validate_token(field, value)?;
        }
        Ok(())
    }
}

impl AgentRuntimeNativeRehostCommitV1 {
    pub fn target_selection(&self) -> Result<AgentRuntimeSelectionV1, DomainStoreErrorV1> {
        let mut target = self.source_selection.clone();
        target.execution_profile = self.target_execution_profile.clone();
        target.permission_mode = self.target_permission_mode.clone();
        target.revision = target
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("sourceSelection", "revision overflow"))?;
        target.selected_by_operation_id = Some(self.operation_id.clone());
        target.updated_at_ms = self.committed_at_ms;
        target.validate()?;
        Ok(target)
    }

    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "unsupported native rehost schema"));
        }
        self.request_source.validate()?;
        self.source_selection.validate()?;
        if let Some(repair) = &self.repair_transition {
            repair.validate_for(&self.operation_id)?;
        }
        if self.source_selection.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1
            || self.source_selection.interaction_profile != AgentInteractionProfileV1::NativeCli
        {
            return Err(invalid(
                "sourceSelection",
                "native rehost requires a native runtime selection",
            ));
        }
        if self.source_selection.selected_by_operation_id.as_ref() == Some(&self.operation_id) {
            return Err(invalid(
                "operationId",
                "the successor operation must differ from the source selection",
            ));
        }
        AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: self.source_authority.clone(),
        }
        .validate_for_selection(&self.source_selection)?;
        self.target_authority.validate()?;
        if self.committed_at_ms < self.source_selection.updated_at_ms
            || self.committed_at_ms < self.source_authority.updated_at_ms
            || self.target_authority.updated_at_ms != self.committed_at_ms
            || self.target_authority.binding.bound_at_ms != self.committed_at_ms
        {
            return Err(invalid(
                "committedAtMs",
                "successor timestamps must be monotonic and exact",
            ));
        }
        let source = &self.source_authority;
        let target = &self.target_authority;
        if self.request_source.workspace_id != source.runtime_workspace_id
            || self.request_source.session_id == target.binding.session_id
        {
            return Err(invalid(
                "requestSource",
                "the verified request source must precede the native successor",
            ));
        }
        if target.binding.agent_id != source.binding.agent_id
            || target.binding.agent_id != self.source_selection.agent_id
            || target.binding.runtime_kind_id != source.binding.runtime_kind_id
            || target.binding.session_id == source.binding.session_id
            || target.runtime_workspace_id != source.runtime_workspace_id
            || target.binding.binding_generation
                != source
                    .binding
                    .binding_generation
                    .checked_add(1)
                    .ok_or_else(|| invalid("sourceAuthority", "binding generation overflow"))?
        {
            return Err(invalid(
                "targetAuthority",
                "the successor must advance exactly one native binding generation",
            ));
        }
        let target_selection = self.target_selection()?;
        AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: target.clone(),
        }
        .validate_for_selection(&target_selection)?;
        let receipt = AgentRuntimeNativeRehostReceiptV1 {
            schema_version: AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1,
            operation_id: self.operation_id.clone(),
            agent_id: target_selection.agent_id.clone(),
            selection_revision: target_selection.revision,
            source: self.request_source.clone(),
            session_id: target.binding.session_id.clone(),
            workspace_id: target.runtime_workspace_id.clone(),
            launch_idempotency_key: self.target_launch_idempotency_key.clone(),
            provider_launch_reference: self.target_provider_launch_reference.clone(),
            committed_at_ms: self.committed_at_ms,
        };
        receipt.validate_for(&target_selection, target)
    }
}

fn validate_retired_replacement_authority(
    current: &AgentRuntimeTransitionRecordV1,
    retired: Option<&AgentRuntimeReplacementAuthorityV1>,
) -> Result<(), DomainStoreErrorV1> {
    match (current.replacement_authority.as_ref(), retired) {
        (None, None) => Ok(()),
        (
            Some(AgentRuntimeReplacementAuthorityV1(
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source },
            )),
            Some(target),
        ) => {
            target.validate_for_transition_identity(
                &current.intent.source.agent_id,
                &current.intent.source.provider_id,
                &current.intent.provider_conversation_ref,
            )?;
            let AgentRuntimeReplacementAuthorityV1(
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: target },
            ) = target
            else {
                return Err(invalid(
                    "repairTransition.retiredReplacementAuthority",
                    "must preserve the structured replacement lineage",
                ));
            };
            let target_revision = source.binding_revision.checked_add(1).ok_or_else(|| {
                invalid(
                    "repairTransition.retiredReplacementAuthority",
                    "binding revision overflow",
                )
            })?;
            if target.schema_version != source.schema_version
                || target.interaction_session_id != source.interaction_session_id
                || target.agent_id != source.agent_id
                || target.provider_id != source.provider_id
                || target.execution_profile != current.intent.target_execution_profile
                || target.provider_conversation_ref != source.provider_conversation_ref
                || target.runtime == source.runtime
                || target.timeline_epoch != source.timeline_epoch
                || target.binding_revision != target_revision
                || target.history_complete != source.history_complete
                || target.created_at_ms != source.created_at_ms
                || target.updated_at_ms < source.updated_at_ms
            {
                return Err(invalid(
                    "repairTransition.retiredReplacementAuthority",
                    "does not prove the exact failed structured replacement was retired",
                ));
            }
            Ok(())
        }
        _ => Err(invalid(
            "repairTransition.retiredReplacementAuthority",
            "does not match the pending replacement authority",
        )),
    }
}

fn validate_repair_replacement_disposition(
    current: &AgentRuntimeTransitionRecordV1,
    repair: &AgentRuntimeNativeRehostRepairTransitionV1,
) -> Result<(), DomainStoreErrorV1> {
    if repair.retain_replacement_authority {
        return if repair.retired_replacement_authority.is_none() {
            Ok(())
        } else {
            Err(invalid(
                "repairTransition",
                "retained replacement authority cannot carry retirement proof",
            ))
        };
    }
    validate_retired_replacement_authority(current, repair.retired_replacement_authority.as_ref())
}

/// Retire one exact failed or dormant journal in the same transaction that
/// publishes its independently verified native Hmux successor. A failed
/// structured replacement may be superseded only with its exact retirement
/// proof; unrelated or still-live authority remains fenced.
pub fn supersede_agent_runtime_transition_with_native_rehost_v1(
    current: &AgentRuntimeTransitionRecordV1,
    request: &AgentRuntimeNativeRehostCommitV1,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    current.validate()?;
    request.validate()?;
    let repair = request.repair_transition.as_ref().ok_or_else(|| {
        invalid(
            "repairTransition",
            "is required while a runtime transition is active",
        )
    })?;
    if current.intent.operation_id != repair.operation_id
        || current.journal_revision != repair.expected_journal_revision
        || !(current.state == AgentRuntimeTransitionStateV1::RepairRequired || current.is_dormant())
        || current.intent.source != request.source_selection
        || current.intent.source_authority
            != (AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: request.source_authority.clone(),
            })
    {
        return Err(invalid(
            "repairTransition",
            "does not identify one replaceable failed or dormant native source",
        ));
    }
    if current.is_dormant()
        && request
            .target_authority
            .binding
            .provider_conversation_id
            .as_deref()
            != current.intent.provider_conversation_ref.as_option()
    {
        return Err(invalid(
            "targetAuthority",
            "native Resume must preserve the dormant conversation",
        ));
    }
    validate_repair_replacement_disposition(current, repair)?;
    if request.committed_at_ms < current.updated_at_ms {
        return Err(invalid(
            "committedAtMs",
            "must not precede the failed transition",
        ));
    }
    let mut superseded = current.clone();
    superseded.state = AgentRuntimeTransitionStateV1::Superseded;
    superseded.replacement_authority = repair
        .retain_replacement_authority
        .then(|| current.replacement_authority.clone())
        .flatten();
    superseded.superseded_by_operation_id = Some(request.operation_id.clone());
    superseded.journal_revision = superseded
        .journal_revision
        .checked_add(1)
        .ok_or_else(|| invalid("repairTransition", "journal revision overflow"))?;
    superseded.updated_at_ms = request.committed_at_ms;
    superseded.validate()?;
    Ok(superseded)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeNativeRehostReceiptV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub agent_id: crate::AgentIdV1,
    pub selection_revision: i64,
    pub source: AgentRuntimeNativeRehostSourceV1,
    pub session_id: String,
    pub workspace_id: String,
    pub launch_idempotency_key: OperationIdV1,
    pub provider_launch_reference: Option<ProviderLaunchReferenceV1>,
    pub committed_at_ms: i64,
}

impl AgentRuntimeNativeRehostReceiptV1 {
    pub fn validate_for(
        &self,
        selection: &AgentRuntimeSelectionV1,
        authority: &AgentCheckpointBindingAuthorityV1,
    ) -> Result<(), DomainStoreErrorV1> {
        self.source.validate()?;
        if self.schema_version != AGENT_RUNTIME_NATIVE_REHOST_SCHEMA_VERSION_V1
            || self.agent_id != selection.agent_id
            || self.selection_revision != selection.revision
            || selection.selected_by_operation_id.as_ref() != Some(&self.operation_id)
            || self.session_id != authority.binding.session_id
            || self.workspace_id != authority.runtime_workspace_id
            || self.committed_at_ms != selection.updated_at_ms
            || self.committed_at_ms != authority.updated_at_ms
        {
            return Err(invalid(
                "nativeRehostReceipt",
                "receipt must identify the exact selected native successor",
            ));
        }
        AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: authority.clone(),
        }
        .validate_for_selection(selection)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRuntimeNativeRehostCommitReceiptV1 {
    pub selection: AgentRuntimeSelectionV1,
    pub authority: AgentCheckpointBindingAuthorityV1,
    pub receipt: AgentRuntimeNativeRehostReceiptV1,
}

#[cfg(test)]
mod tests {
    use super::ProviderLaunchReferenceV1;

    #[test]
    fn provider_launch_reference_round_trips_the_runtime_opaque_alphabet() {
        let reference = ProviderLaunchReferenceV1::new("credential+profile").unwrap();
        let encoded = serde_json::to_string(&reference).unwrap();
        assert_eq!(
            serde_json::from_str::<ProviderLaunchReferenceV1>(&encoded).unwrap(),
            reference
        );
        assert!(
            serde_json::from_str::<ProviderLaunchReferenceV1>("\"credential/profile\"").is_err()
        );
        assert!(
            serde_json::from_str::<ProviderLaunchReferenceV1>("\"credential\\nprofile\"").is_err()
        );
    }
}
