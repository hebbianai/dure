//! A delayed replacement stays in the existing journal, not a second registry.
use super::*;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentRuntimeDeferredTargetV1 {
    Waiting,
    Requested {
        operation_id: OperationIdV1,
        requested_at_ms: i64,
    },
}

impl AgentRuntimeTransitionRecordV1 {
    /// Persist the same-conversation replacement intent before stopping.
    /// Admission is not proof that the live provider is safe to stop.
    pub fn admitted_deferred(
        intent: AgentRuntimeTransitionIntentV1,
    ) -> Result<Self, DomainStoreErrorV1> {
        Self::admitted_with_activation(intent, Some(AgentRuntimeDeferredTargetV1::Waiting))
    }

    #[must_use]
    pub fn target_is_deferred(&self) -> bool {
        matches!(
            self.deferred_target,
            Some(AgentRuntimeDeferredTargetV1::Waiting)
        )
    }

    /// The source has stopped and no replacement effect has been authorized.
    #[must_use]
    pub fn is_dormant(&self) -> bool {
        self.state == AgentRuntimeTransitionStateV1::SourceStopped && self.target_is_deferred()
    }

    /// Journal permission only; adapters still validate the exact runtime fence.
    #[must_use]
    pub fn permits_target_effects(&self) -> bool {
        self.state == AgentRuntimeTransitionStateV1::SourceStopped && !self.target_is_deferred()
    }
}

pub(super) fn validate(record: &AgentRuntimeTransitionRecordV1) -> Result<(), DomainStoreErrorV1> {
    let Some(activation) = &record.deferred_target else {
        return Ok(());
    };
    let intent = &record.intent;
    // Pinning the same legacy native account supplies a resumable target; it
    // does not assert a credential generation for the historical source.
    let execution_preserved = intent.source.execution_profile == intent.target_execution_profile
        || (matches!(
            intent.source_authority,
            AgentRuntimeBindingAuthorityV1::NativeCli { .. }
        ) && matches!(
            (&intent.source.execution_profile, &intent.target_execution_profile),
            (
                AgentExecutionProfileV1::CredentialReference {
                    reference_id: source,
                    credential_generation: None,
                },
                AgentExecutionProfileV1::CredentialReference {
                    reference_id: target,
                    credential_generation: Some(_),
                },
            ) if source == target
        ));
    if !intent.source_stop_policy.requires_idle()
        || intent.provider_conversation_ref.as_option().is_none()
        || intent.source.interaction_profile != intent.target_interaction_profile
        || !execution_preserved
        || intent.launch_selection_changed()
        || record.predecessor_operation_id.is_some()
    {
        return Err(invalid(
            "deferredTarget",
            "must preserve the exact resumable source profile",
        ));
    }
    match activation {
        AgentRuntimeDeferredTargetV1::Waiting => {
            if !matches!(
                record.state,
                AgentRuntimeTransitionStateV1::Admitted
                    | AgentRuntimeTransitionStateV1::SourceRetained
                    | AgentRuntimeTransitionStateV1::SourceStopped
                    | AgentRuntimeTransitionStateV1::Superseded
            ) || record.last_repair_operation_id.is_some()
                || record.target_failure.is_some()
                || record.replacement_authority.is_some()
            {
                return Err(invalid(
                    "deferredTarget",
                    "cannot perform target effects before an explicit wake",
                ));
            }
        }
        AgentRuntimeDeferredTargetV1::Requested {
            operation_id,
            requested_at_ms,
        } => {
            if matches!(
                record.state,
                AgentRuntimeTransitionStateV1::Admitted
                    | AgentRuntimeTransitionStateV1::SourceRetained
            ) || operation_id == &intent.operation_id
                || Some(operation_id) == record.last_repair_operation_id.as_ref()
                || Some(operation_id) == record.superseded_by_operation_id.as_ref()
                || *requested_at_ms < record.created_at_ms
                || *requested_at_ms > record.updated_at_ms
            {
                return Err(invalid(
                    "deferredTarget",
                    "wake identity or history is inconsistent",
                ));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeTransitionWakeRequestV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub expected_journal_revision: i64,
    pub wake_operation_id: OperationIdV1,
    pub woken_at_ms: i64,
}

impl AgentRuntimeTransitionWakeRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1
            || self.operation_id == self.wake_operation_id
        {
            return Err(invalid(
                "wakeOperationId",
                "unsupported schema or repeated transition identity",
            ));
        }
        positive("expectedJournalRevision", self.expected_journal_revision)?;
        timestamp("wokenAtMs", self.woken_at_ms)
    }
}

/// A single journal CAS grants wake effects; retries only observe its result.
pub fn authorize_agent_runtime_transition_wake_v1(
    current: &AgentRuntimeTransitionRecordV1,
    request: &AgentRuntimeTransitionWakeRequestV1,
) -> Result<AgentRuntimeTransitionEffectAuthorizationV1, DomainStoreErrorV1> {
    current.validate()?;
    request.validate()?;
    if current.intent.operation_id != request.operation_id {
        return Err(invalid(
            "operationId",
            "wake targets a different transition",
        ));
    }
    if let Some(AgentRuntimeDeferredTargetV1::Requested { operation_id, .. }) =
        &current.deferred_target
        && operation_id == &request.wake_operation_id
    {
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
    if !current.is_dormant() {
        return Err(invalid(
            "deferredTarget",
            "wake requires the exact deferred stopped source",
        ));
    }
    if request.woken_at_ms < current.updated_at_ms {
        return Err(invalid("wokenAtMs", "must not move backward"));
    }
    let mut next = current.clone();
    next.deferred_target = Some(AgentRuntimeDeferredTargetV1::Requested {
        operation_id: request.wake_operation_id.clone(),
        requested_at_ms: request.woken_at_ms,
    });
    next.journal_revision = next
        .journal_revision
        .checked_add(1)
        .ok_or_else(|| invalid("journalRevision", "overflowed"))?;
    next.updated_at_ms = request.woken_at_ms;
    next.validate()?;
    Ok(AgentRuntimeTransitionEffectAuthorizationV1::Authorized(
        next,
    ))
}
