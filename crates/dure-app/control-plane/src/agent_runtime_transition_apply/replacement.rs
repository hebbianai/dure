use super::admission::preflight_transition_target;
use super::*;

/// A user selects a target, not a recovery algorithm. The existing journal
/// transfers the stopped source and any replacement fence to one successor.
pub(super) async fn admit_replacement(
    state: &ServiceState,
    body: &AgentRuntimeTransitionApplyBodyV1,
    current: &AgentRuntimeTransitionRecordV1,
    operation_id: OperationIdV1,
    idempotency_key: String,
) -> Result<AdmissionOutcome, super::super::BackendDispatchError> {
    if body
        .expected_source_revision
        .is_some_and(|revision| revision != current.intent.source.revision)
    {
        return Err("agent_runtime_transition_conflict".into());
    }
    let successor_intent = corrected_successor_intent(
        state,
        current,
        operation_id,
        idempotency_key,
        body.target_interaction_profile,
        body.target_execution_profile.clone(),
        body.target_launch_selection.clone(),
    )
    .await?;
    let authorization = state
        .store
        .supersede_agent_runtime_transition(&AgentRuntimeTransitionSupersedeRequestV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: current.intent.operation_id.clone(),
            expected_journal_revision: current.journal_revision,
            superseded_at_ms: successor_intent.requested_at_ms,
            successor_intent,
        })
        .await
        .map_err(repair_store_error)?;
    let (AgentRuntimeTransitionEffectAuthorizationV1::Authorized(successor)
    | AgentRuntimeTransitionEffectAuthorizationV1::Replayed(successor)) = authorization;
    Ok(AdmissionOutcome::Transition(Box::new(successor)))
}

pub(super) async fn corrected_successor_intent(
    state: &ServiceState,
    current: &AgentRuntimeTransitionRecordV1,
    operation_id: OperationIdV1,
    idempotency_key: String,
    target_interaction_profile: AgentInteractionProfileV1,
    target_execution_profile: Option<AgentExecutionProfileV1>,
    target_launch_selection: Option<AgentRuntimeLaunchSelectionV1>,
) -> Result<AgentRuntimeTransitionIntentV1, super::super::BackendDispatchError> {
    if current.state != AgentRuntimeTransitionStateV1::RepairRequired {
        return Err(super::super::BackendDispatchError::terminal(
            "agent_runtime_repair_conflict",
        ));
    }
    let source = &current.intent.source;
    let target_execution_profile =
        target_execution_profile.unwrap_or_else(|| source.execution_profile.clone());
    target_execution_profile.validate().map_err(|_| {
        super::super::BackendDispatchError::terminal("agent_runtime_repair_request_invalid")
    })?;
    if matches!(
        &target_execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            credential_generation: None,
            ..
        }
    ) {
        return Err(super::super::BackendDispatchError::terminal(
            "agent_runtime_repair_request_invalid",
        ));
    }
    let effective_launch =
        target_launch_selection
            .clone()
            .unwrap_or(AgentRuntimeLaunchSelectionV1 {
                model: source.model.clone(),
                effort: source.effort.clone(),
                permission_mode: None,
            });
    let effective_permission = effective_launch
        .permission_mode
        .clone()
        .unwrap_or_else(|| source.permission_mode.clone());
    let launch_selection_changed = effective_launch.model != source.model
        || effective_launch.effort != source.effort
        || effective_permission != source.permission_mode;
    let kind = transition_kind(
        source,
        target_interaction_profile,
        &target_execution_profile,
        launch_selection_changed,
        true,
    )
    .map_err(|_| {
        super::super::BackendDispatchError::terminal("agent_runtime_repair_request_invalid")
    })?;
    preflight_transition_target(
        state,
        source,
        &target_execution_profile,
        &effective_launch,
        kind,
        true,
        &current.intent.provider_conversation_ref,
    )
    .await
    .map_err(|error| error.with_disposition(crate::BackendFailureDispositionV1::Terminal))?;
    let requested_at_ms = clock_at_least(current.updated_at_ms).map_err(|_| {
        super::super::BackendDispatchError::from("agent_runtime_repair_clock_unavailable")
    })?;
    let intent = AgentRuntimeTransitionIntentV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        operation_id,
        idempotency_key,
        source: source.clone(),
        source_authority: current.intent.source_authority.clone(),
        source_stop_policy: current.intent.source_stop_policy,
        provider_conversation_ref: current.intent.provider_conversation_ref.clone(),
        target_interaction_profile,
        target_execution_profile,
        target_launch_selection,
        requested_at_ms,
    };
    intent.validate_after_stopped_source().map_err(|_| {
        super::super::BackendDispatchError::terminal("agent_runtime_repair_request_invalid")
    })?;
    Ok(intent)
}
