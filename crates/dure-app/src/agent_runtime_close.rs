//! Durable authority for explicitly closing one Agent runtime.
//!
//! Closing is intentionally separate from deleting a client projection. The
//! admitted tombstone prevents inspect/open from resurrecting a runtime while
//! its exact provider process is being stopped or after a lost response.

use serde::{Deserialize, Serialize};

use crate::domain_store::validate_token;
use crate::{
    AgentIdV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1, DomainStoreErrorV1,
    DomainStoreFuture, OperationIdV1,
};

pub const AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1: u16 = 1;

fn invalid(field: &'static str, reason: impl Into<String>) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

fn timestamp(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 0 {
        return Err(invalid(field, "must not be negative"));
    }
    Ok(())
}

/// Exact durable proof that this close starts after a transition already
/// crossed its source-stop boundary and parked in `repair_required`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeCloseStoppedTransitionV1 {
    pub operation_id: OperationIdV1,
    pub journal_revision: i64,
}

impl AgentRuntimeCloseStoppedTransitionV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.journal_revision < 1 {
            return Err(invalid(
                "stoppedTransition.journalRevision",
                "must be positive",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeCloseIntentV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub idempotency_key: String,
    pub source: AgentRuntimeSelectionV1,
    pub source_authority: AgentRuntimeBindingAuthorityV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_transition: Option<AgentRuntimeCloseStoppedTransitionV1>,
    pub requested_at_ms: i64,
}

impl AgentRuntimeCloseIntentV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "unsupported runtime close schema"));
        }
        validate_token("idempotencyKey", &self.idempotency_key)?;
        self.source_authority.validate_for_selection(&self.source)?;
        if let Some(stopped_transition) = &self.stopped_transition {
            stopped_transition.validate()?;
            if stopped_transition.operation_id == self.operation_id {
                return Err(invalid(
                    "stoppedTransition.operationId",
                    "must differ from the close operation",
                ));
            }
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
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeCloseStateV1 {
    Admitted,
    /// The destructive boundary was refused, so the source remains selected
    /// and open. This exact close attempt is terminal.
    SourceRetained,
    Stopped,
}

impl AgentRuntimeCloseStateV1 {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::SourceRetained => "source_retained",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeCloseRecordV1 {
    pub schema_version: u16,
    pub intent: AgentRuntimeCloseIntentV1,
    pub state: AgentRuntimeCloseStateV1,
    pub journal_revision: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl AgentRuntimeCloseRecordV1 {
    pub fn admitted(intent: AgentRuntimeCloseIntentV1) -> Result<Self, DomainStoreErrorV1> {
        intent.validate()?;
        let requested_at_ms = intent.requested_at_ms;
        let record = Self {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            intent,
            state: AgentRuntimeCloseStateV1::Admitted,
            journal_revision: 1,
            created_at_ms: requested_at_ms,
            updated_at_ms: requested_at_ms,
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime close record schema",
            ));
        }
        self.intent.validate()?;
        timestamp("createdAtMs", self.created_at_ms)?;
        timestamp("updatedAtMs", self.updated_at_ms)?;
        if self.created_at_ms != self.intent.requested_at_ms
            || self.updated_at_ms < self.created_at_ms
        {
            return Err(invalid(
                "updatedAtMs",
                "runtime close timestamps are inconsistent",
            ));
        }
        let expected_revision = match self.state {
            AgentRuntimeCloseStateV1::Admitted => 1,
            AgentRuntimeCloseStateV1::SourceRetained | AgentRuntimeCloseStateV1::Stopped => 2,
        };
        if self.journal_revision != expected_revision {
            return Err(invalid(
                "journalRevision",
                "does not match the runtime close state",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeCloseAdvanceV1 {
    SourceRetained,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeCloseAdvanceRequestV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub expected_journal_revision: i64,
    pub advance: AgentRuntimeCloseAdvanceV1,
    pub advanced_at_ms: i64,
}

impl AgentRuntimeCloseAdvanceRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported runtime close advance schema",
            ));
        }
        if self.expected_journal_revision < 1 {
            return Err(invalid("expectedJournalRevision", "must be positive"));
        }
        timestamp("advancedAtMs", self.advanced_at_ms)
    }
}

pub fn advance_agent_runtime_close_v1(
    current: &AgentRuntimeCloseRecordV1,
    request: &AgentRuntimeCloseAdvanceRequestV1,
) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
    current.validate()?;
    request.validate()?;
    if current.intent.operation_id != request.operation_id {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent runtime close",
            id: request.operation_id.as_str().into(),
            reason: "operation identity changed".into(),
        });
    }
    if request.advanced_at_ms < current.updated_at_ms {
        return Err(invalid("advancedAtMs", "must not move backward"));
    }
    if close_advance_matches_current(current.state, request.advance)
        && current.journal_revision == request.expected_journal_revision + 1
    {
        return Ok(current.clone());
    }
    if current.journal_revision != request.expected_journal_revision {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.intent.source.agent_id.as_str().into(),
            expected_revision: request.expected_journal_revision,
            actual_revision: Some(current.journal_revision),
        });
    }
    if current.state != AgentRuntimeCloseStateV1::Admitted {
        return Err(DomainStoreErrorV1::InvalidEventStream {
            reason: "only an admitted runtime close can stop".into(),
        });
    }
    let mut next = current.clone();
    next.state = match request.advance {
        AgentRuntimeCloseAdvanceV1::SourceRetained => AgentRuntimeCloseStateV1::SourceRetained,
        AgentRuntimeCloseAdvanceV1::Stopped => AgentRuntimeCloseStateV1::Stopped,
    };
    next.journal_revision = 2;
    next.updated_at_ms = request.advanced_at_ms;
    next.validate()?;
    Ok(next)
}

fn close_advance_matches_current(
    state: AgentRuntimeCloseStateV1,
    advance: AgentRuntimeCloseAdvanceV1,
) -> bool {
    matches!(
        (state, advance),
        (
            AgentRuntimeCloseStateV1::SourceRetained,
            AgentRuntimeCloseAdvanceV1::SourceRetained,
        ) | (
            AgentRuntimeCloseStateV1::Stopped,
            AgentRuntimeCloseAdvanceV1::Stopped,
        )
    )
}

pub trait AgentRuntimeCloseStore: Send + Sync {
    fn admit_agent_runtime_close<'a>(
        &'a self,
        intent: &'a AgentRuntimeCloseIntentV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeCloseRecordV1>;

    fn advance_agent_runtime_close<'a>(
        &'a self,
        request: &'a AgentRuntimeCloseAdvanceRequestV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeCloseRecordV1>;

    /// Reads one exact attempt, including terminal retained-source history.
    fn agent_runtime_close<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeCloseRecordV1>>;

    /// Reads the active close admission or permanent stopped tombstone.
    fn effective_agent_runtime_close<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeCloseRecordV1>>;

    /// Reads whether a close precedes this transition through its durable
    /// successor chain, including failed targets that were superseded.
    fn agent_runtime_transition_follows_close<'a>(
        &'a self,
        transition_operation_id: &'a OperationIdV1,
        close_operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, bool>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1, AgentInteractionBindingV1,
        AgentInteractionProfileV1, AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1,
        AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1, AgentTimelineEpochV1,
        ProviderIdV1, ProviderPermissionModeV1, RuntimeKindIdV1, SessionBindingRecordV1,
    };

    fn intent() -> AgentRuntimeCloseIntentV1 {
        let execution_profile = AgentExecutionProfileV1::ProviderDefault;
        AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("runtime-close-1").unwrap(),
            idempotency_key: "runtime-close-agent-1".into(),
            source: AgentRuntimeSelectionV1 {
                schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
                agent_id: AgentIdV1::new("agent-1").unwrap(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                execution_profile: execution_profile.clone(),
                permission_mode: ProviderPermissionModeV1::Default,
                model: Option::<AgentSpawnModelSelectionV1>::None,
                effort: Option::<AgentSpawnEffortSelectionV1>::None,
                revision: 1,
                selected_by_operation_id: None,
                updated_at_ms: 10,
            },
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: AgentInteractionBindingV1 {
                    schema_version: 1,
                    interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1")
                        .unwrap(),
                    agent_id: AgentIdV1::new("agent-1").unwrap(),
                    provider_id: ProviderIdV1::new("codex").unwrap(),
                    execution_profile,
                    provider_conversation_ref: Some("thread-1".into()),
                    runtime: AgentProviderRuntimeFenceV1 {
                        runtime_generation: "runtime-1".into(),
                        provider_epoch: "provider-1".into(),
                    },
                    timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
                    binding_revision: 1,
                    history_complete: true,
                    created_at_ms: 10,
                    updated_at_ms: 10,
                },
            },
            stopped_transition: None,
            requested_at_ms: 20,
        }
    }

    #[test]
    fn close_advances_once_and_replays_the_same_stop() {
        let admitted = AgentRuntimeCloseRecordV1::admitted(intent()).unwrap();
        let request = AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 30,
        };
        let stopped = advance_agent_runtime_close_v1(&admitted, &request).unwrap();
        assert_eq!(stopped.state, AgentRuntimeCloseStateV1::Stopped);
        assert_eq!(
            advance_agent_runtime_close_v1(&stopped, &request).unwrap(),
            stopped
        );
    }

    #[test]
    fn retained_source_terminates_the_exact_close_attempt() {
        let admitted = AgentRuntimeCloseRecordV1::admitted(intent()).unwrap();
        let request = AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
            advanced_at_ms: 30,
        };
        let retained = advance_agent_runtime_close_v1(&admitted, &request).unwrap();

        assert_eq!(retained.state, AgentRuntimeCloseStateV1::SourceRetained);
        assert_eq!(retained.journal_revision, 2);
        assert_eq!(
            advance_agent_runtime_close_v1(&retained, &request).unwrap(),
            retained
        );
    }

    #[test]
    fn close_accepts_a_binding_before_the_provider_conversation_is_established() {
        let mut intent = intent();
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
            &mut intent.source_authority
        else {
            unreachable!();
        };
        binding.provider_conversation_ref = None;

        assert!(AgentRuntimeCloseRecordV1::admitted(intent).is_ok());
    }

    #[test]
    fn close_accepts_the_exact_native_authority() {
        let mut intent = intent();
        intent.source.interaction_profile = AgentInteractionProfileV1::NativeCli;
        intent.source_authority = AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: AgentCheckpointBindingAuthorityV1 {
                schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
                binding: SessionBindingRecordV1 {
                    agent_id: intent.source.agent_id.clone(),
                    runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                    session_id: "session-1".into(),
                    provider_conversation_id: None,
                    credential_reference_id: None,
                    binding_generation: 1,
                    bound_at_ms: 10,
                },
                runtime_workspace_id: "workspace-1".into(),
                runner_principal: "runner-principal-1".into(),
                runner_instance: "runner-instance-1".into(),
                channel_epoch: "1".into(),
                host_instance_id: "host-instance-1".into(),
                terminal_epoch: "terminal-epoch-1".into(),
                updated_at_ms: 10,
            },
        };

        assert!(AgentRuntimeCloseRecordV1::admitted(intent).is_ok());
    }
}
