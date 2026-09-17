use super::*;

/// Advances one exact durable stage. Replaying the immediately preceding CAS
/// returns the already-written record, which makes a lost response harmless.
pub fn advance_agent_runtime_transition_v1(
    current: &AgentRuntimeTransitionRecordV1,
    request: &AgentRuntimeTransitionAdvanceRequestV1,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    current.validate()?;
    request.validate()?;
    if current.intent.operation_id != request.operation_id {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent runtime transition",
            id: request.operation_id.as_str().into(),
            reason: "operation identity changed".into(),
        });
    }
    if request.advanced_at_ms < current.updated_at_ms {
        return Err(invalid("advancedAtMs", "must not move backward"));
    }
    if current.journal_revision == request.expected_journal_revision + 1
        && advance_matches_current(current, &request.advance)
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

    if current.is_dormant() {
        return Err(invalid(
            "deferredTarget",
            "target effects require an explicit wake",
        ));
    }

    let mut next = current.clone();
    match (&current.state, &request.advance) {
        (
            AgentRuntimeTransitionStateV1::Admitted,
            AgentRuntimeTransitionAdvanceV1::SourceRetained,
        ) => next.state = AgentRuntimeTransitionStateV1::SourceRetained,
        (
            AgentRuntimeTransitionStateV1::Admitted,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
        ) => next.state = AgentRuntimeTransitionStateV1::SourceStopped,
        (
            AgentRuntimeTransitionStateV1::SourceStopped,
            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure,
                replacement_authority,
            },
        ) => {
            failure.validate()?;
            next.state = AgentRuntimeTransitionStateV1::RepairRequired;
            next.target_failure = Some(failure.clone());
            if let AgentRuntimeReplacementAuthorityUpdateV1::Replace { authority } =
                replacement_authority
            {
                if let Some(authority) = authority {
                    authority.validate_for_transition_identity(
                        &current.intent.source.agent_id,
                        &current.intent.source.provider_id,
                        &current.intent.provider_conversation_ref,
                    )?;
                }
                next.replacement_authority = authority.as_deref().cloned();
            }
        }
        (
            AgentRuntimeTransitionStateV1::SourceStopped,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                authority,
                launch_idempotency_key,
            },
        ) => {
            authority.validate_for_transition_target(
                &current.intent.target_selection_at(request.advanced_at_ms)?,
                &current.intent.provider_conversation_ref,
            )?;
            if let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = authority.as_ref() {
                let target_attempt_operation_id = current
                    .last_repair_operation_id
                    .as_ref()
                    .unwrap_or(&current.intent.operation_id);
                validate_recorded_agent_runtime_native_launch_identity_v1(
                    target_attempt_operation_id,
                    &authority.binding.session_id,
                    launch_idempotency_key.as_deref(),
                )?;
            }
            next.state = AgentRuntimeTransitionStateV1::TargetStarted;
            next.target_authority = Some(authority.as_ref().clone());
            next.target_launch_idempotency_key = launch_idempotency_key.clone();
            next.replacement_authority = None;
            next.target_failure = None;
        }
        (
            AgentRuntimeTransitionStateV1::TargetStarted,
            AgentRuntimeTransitionAdvanceV1::Committed,
        ) => next.state = AgentRuntimeTransitionStateV1::Committed,
        _ => {
            return Err(DomainStoreErrorV1::InvalidEventStream {
                reason: format!(
                    "runtime transition cannot advance from {:?} with {:?}",
                    current.state, request.advance
                ),
            });
        }
    }
    next.journal_revision += 1;
    next.updated_at_ms = request.advanced_at_ms;
    next.validate()?;
    Ok(next)
}

fn advance_matches_current(
    current: &AgentRuntimeTransitionRecordV1,
    advance: &AgentRuntimeTransitionAdvanceV1,
) -> bool {
    match (&current.state, advance) {
        (
            AgentRuntimeTransitionStateV1::SourceRetained,
            AgentRuntimeTransitionAdvanceV1::SourceRetained,
        )
        | (
            AgentRuntimeTransitionStateV1::SourceStopped,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
        )
        | (AgentRuntimeTransitionStateV1::Committed, AgentRuntimeTransitionAdvanceV1::Committed) => {
            true
        }
        (
            AgentRuntimeTransitionStateV1::TargetStarted,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                authority,
                launch_idempotency_key,
            },
        ) => {
            current.target_authority.as_ref() == Some(authority.as_ref())
                && current.target_launch_idempotency_key == *launch_idempotency_key
        }
        (
            AgentRuntimeTransitionStateV1::RepairRequired,
            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure,
                replacement_authority,
            },
        ) => {
            current.target_failure.as_ref() == Some(failure)
                && match replacement_authority {
                    AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting => true,
                    AgentRuntimeReplacementAuthorityUpdateV1::Replace { authority } => {
                        current.replacement_authority.as_ref() == authority.as_deref()
                    }
                }
        }
        _ => false,
    }
}
