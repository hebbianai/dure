use super::*;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum TargetActivation {
    Immediate,
    Deferred,
}

pub(super) async fn load_or_admit(
    state: &ServiceState,
    body: &AgentRuntimeTransitionApplyBodyV1,
    operation_id: OperationIdV1,
    idempotency_key: String,
    fingerprint: &str,
) -> Result<AdmissionOutcome, crate::BackendDispatchError> {
    load_or_admit_with_activation(
        state,
        body,
        operation_id,
        idempotency_key,
        fingerprint,
        TargetActivation::Immediate,
    )
    .await
}

pub(super) async fn load_or_admit_with_activation(
    state: &ServiceState,
    body: &AgentRuntimeTransitionApplyBodyV1,
    operation_id: OperationIdV1,
    idempotency_key: String,
    fingerprint: &str,
    activation: TargetActivation,
) -> Result<AdmissionOutcome, crate::BackendDispatchError> {
    let observed = crate::agent_runtime_projection::read_locked(state, &body.agent_id).await?;
    let observed = match observed {
        crate::agent_runtime_projection::AgentRuntimeObservedV1::Transitioning {
            transition,
            ..
        } if transition.state == AgentRuntimeTransitionStateV1::Admitted
            && transition.deferred_target.is_none()
            && activation == TargetActivation::Immediate =>
        {
            match_admitted_target(&transition, body)?;
            let authorization = state
                .store
                .resume_agent_runtime_transition(
                    &transition.intent.operation_id,
                    &idempotency_key,
                    fingerprint,
                )
                .await
                .map_err(store_error)?;
            return Ok(match authorization {
                AgentRuntimeTransitionEffectAuthorizationV1::Authorized(record) => {
                    AdmissionOutcome::Transition(Box::new(record))
                }
                AgentRuntimeTransitionEffectAuthorizationV1::Replayed(record) => {
                    AdmissionOutcome::Replayed(Box::new(record))
                }
            });
        }
        crate::agent_runtime_projection::AgentRuntimeObservedV1::Transitioning {
            transition,
            ..
        } if transition.state == AgentRuntimeTransitionStateV1::RepairRequired
            && activation == TargetActivation::Immediate =>
        {
            return replacement::admit_replacement(
                state,
                body,
                &transition,
                operation_id,
                idempotency_key,
            )
            .await;
        }
        observed => observed,
    };
    let source_projection = match observed.into_explicit_successor_source() {
        Ok(source) => source,
        Err(crate::agent_runtime_projection::AgentRuntimeObservedV1::Unmanaged) => {
            return Err("agent_runtime_selection_unavailable".into());
        }
        Err(_) => return Err("agent_runtime_transition_conflict".into()),
    };
    let source_already_stopped = source_projection.boundary.is_stopped();
    if source_already_stopped && activation == TargetActivation::Deferred {
        return Err("agent_runtime_hibernate_source_stopped".into());
    }
    let source_boundary_ms = source_projection
        .boundary
        .updated_at_ms(source_projection.selection.updated_at_ms);
    let source = source_projection.selection;
    let source_authority = source_projection.authority;
    source.validate().map_err(store_error)?;
    source_authority
        .validate_for_selection(&source)
        .map_err(store_error)?;
    if body
        .expected_source_revision
        .is_some_and(|revision| revision != source.revision)
    {
        return Err("agent_runtime_transition_conflict".into());
    }
    let target_execution_profile = body
        .target_execution_profile
        .clone()
        .unwrap_or_else(|| source.execution_profile.clone());
    target_execution_profile.validate().map_err(store_error)?;
    if matches!(
        &target_execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            credential_generation: None,
            ..
        }
    ) {
        return Err("agent_runtime_transition_request_invalid".into());
    }
    let target_launch_selection = body.target_launch_selection.clone();
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
    if !source_already_stopped
        && activation == TargetActivation::Immediate
        && source.interaction_profile == body.target_interaction_profile
        && source.execution_profile == target_execution_profile
        && !launch_selection_changed
    {
        return Ok(AdmissionOutcome::AlreadySelected(Box::new((
            source,
            source_authority,
        ))));
    }
    let kind = transition_kind(
        &source,
        body.target_interaction_profile,
        &target_execution_profile,
        launch_selection_changed,
        source_already_stopped || activation == TargetActivation::Deferred,
    )?;

    let (source_authority, provider_conversation_ref) = match source_authority {
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } if !source_already_stopped => {
            let inspection = inspect_native_source(state, &source, &authority)
                .await
                .map_err(|failure| failure.code().to_string())?;
            let (authority, provider_conversation_ref) =
                converge_native_provider_conversation(state, &source, authority, &inspection)
                    .await?;
            if provider_conversation_ref.as_option().is_none()
                && body.source_stop_policy == AgentRuntimeSourceStopPolicyV1::Discard
            {
                return Err("agent_runtime_provider_conversation_unavailable".into());
            }
            if body.source_stop_policy.requires_idle()
                && !inspection.is_exited_exact()
                && !inspection.is_agent_quiescent()
            {
                return Err("agent_runtime_source_busy".into());
            }
            if matches!(
                body.source_stop_policy,
                AgentRuntimeSourceStopPolicyV1::PreserveObserved { .. }
            ) {
                if !inspection.supports_semantic_quiescent_stop() {
                    return Err("agent_runtime_semantic_idle_unavailable".into());
                }
                let observed = inspection
                    .managed_stop_quiescence_fence()
                    .map_err(|_| "agent_runtime_source_busy".to_string())?;
                if !body.source_stop_policy.accepts_observation(
                    observed.runtime_revision(),
                    observed.observed_through_output_seq(),
                ) {
                    return Err("agent_runtime_source_busy".into());
                }
            }
            (
                AgentRuntimeBindingAuthorityV1::NativeCli { authority },
                provider_conversation_ref,
            )
        }
        authority => {
            let provider_conversation_ref = AgentProviderConversationPlanV1::from_option(
                authority.provider_conversation_ref().map(str::to_owned),
            )
            .map_err(store_error)?;
            (authority, provider_conversation_ref)
        }
    };
    source_authority
        .validate_for_transition(&source, &provider_conversation_ref)
        .map_err(store_error)?;
    preflight_transition_target(
        state,
        &source,
        &target_execution_profile,
        &effective_launch,
        kind,
        source_already_stopped,
        &provider_conversation_ref,
    )
    .await?;

    crate::agent_runtime_checkout::ensure(state, &source, &source_authority).await?;
    let requested_at_ms = clock_at_least(source_boundary_ms)?;
    let intent = AgentRuntimeTransitionIntentV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        operation_id,
        idempotency_key,
        source,
        source_authority,
        source_stop_policy: body.source_stop_policy,
        provider_conversation_ref,
        target_interaction_profile: body.target_interaction_profile,
        target_execution_profile,
        target_launch_selection,
        requested_at_ms,
    };
    let admitted = match activation {
        TargetActivation::Immediate => state.store.admit_agent_runtime_transition(&intent).await,
        TargetActivation::Deferred => {
            state
                .store
                .admit_deferred_agent_runtime_transition(&intent)
                .await
        }
    }
    .map_err(store_error)?;
    Ok(AdmissionOutcome::Transition(Box::new(admitted)))
}

/// Omitted settings resume the admitted target. Explicit settings must name
/// that same intent; a retry cannot retarget it or upgrade its stop policy.
fn match_admitted_target(
    transition: &AgentRuntimeTransitionRecordV1,
    body: &AgentRuntimeTransitionApplyBodyV1,
) -> Result<(), String> {
    let intent = &transition.intent;
    let launch_matches = body.target_launch_selection.as_ref().is_none_or(|launch| {
        let target = intent.effective_launch_selection();
        launch.model == target.model
            && launch.effort == target.effort
            && launch
                .permission_mode
                .as_ref()
                .unwrap_or(&intent.source.permission_mode)
                == &intent.effective_permission_mode()
    });
    if body
        .expected_source_revision
        .is_some_and(|revision| revision != intent.source.revision)
        || body.target_interaction_profile != intent.target_interaction_profile
        || body.source_stop_policy != intent.source_stop_policy
        || body
            .target_execution_profile
            .as_ref()
            .is_some_and(|profile| profile != &intent.target_execution_profile)
        || !launch_matches
    {
        return Err("agent_runtime_transition_conflict".into());
    }
    Ok(())
}

pub(super) async fn preflight_transition_target(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    target_execution_profile: &AgentExecutionProfileV1,
    effective_launch: &AgentRuntimeLaunchSelectionV1,
    kind: TransitionKind,
    source_already_stopped: bool,
    provider_conversation_ref: &AgentProviderConversationPlanV1,
) -> Result<(), crate::BackendDispatchError> {
    let effective_permission = effective_launch
        .permission_mode
        .as_ref()
        .unwrap_or(&source.permission_mode);
    let _resolved_credential = state
        .credential_profiles
        .resolve(&source.provider_id, target_execution_profile)
        .await
        .map_err(|error| crate::BackendDispatchError::from(error.code().to_string()))?;
    let _ = runtime_workspace(state, source)
        .await
        .map_err(crate::BackendDispatchError::from)?;
    match kind {
        TransitionKind::StructuredTarget => {
            state
                .structured_runtimes
                .new_session_availability(&source.provider_id)
                .map_err(crate::structured_provider_runtime_error)?;
            let plan = state
                .agent_providers
                .structured_session_plan(dure_app::AgentProviderStructuredSessionRequestV1 {
                    provider_id: &source.provider_id,
                    execution_profile: target_execution_profile,
                    permission_mode: effective_permission,
                    model: effective_launch.model.as_ref(),
                    effort: effective_launch.effort.as_ref(),
                    has_setup_command: false,
                    provider_conversation_ref,
                })
                .map_err(|error| {
                    crate::BackendDispatchError::from(error.code.as_str().to_owned())
                })?;
            if plan.is_none() {
                return Err("agent_runtime_structured_profile_unavailable".into());
            }
        }
        TransitionKind::NativeTarget => {
            if !source_already_stopped
                && source.interaction_profile == AgentInteractionProfileV1::StructuredProtocol
                && state
                    .structured_runtimes
                    .resolve(&source.provider_id)
                    .is_none()
            {
                return Err("agent_runtime_structured_profile_unavailable".into());
            }
            native::preflight_target(
                state,
                source,
                effective_launch,
                effective_permission,
                provider_conversation_ref.as_option(),
            )
            .map_err(crate::BackendDispatchError::from)?;
        }
    }
    Ok(())
}

pub(super) fn validate_replay(
    transition: &AgentRuntimeTransitionRecordV1,
    body: &AgentRuntimeTransitionApplyBodyV1,
    operation_id: &OperationIdV1,
) -> Result<(), String> {
    transition.validate().map_err(store_error)?;
    if body
        .expected_source_revision
        .is_some_and(|revision| revision != transition.intent.source.revision)
    {
        return Err("agent_runtime_transition_conflict".into());
    }
    let execution_matches = body.target_execution_profile.as_ref().map_or_else(
        || transition.intent.target_execution_profile == transition.intent.source.execution_profile,
        |target| transition.intent.target_execution_profile == *target,
    );
    if transition.intent.operation_id != *operation_id
        || transition.intent.source.agent_id != body.agent_id
        || transition.intent.target_interaction_profile != body.target_interaction_profile
        || (transition.predecessor_operation_id.is_none()
            && transition.intent.source_stop_policy != body.source_stop_policy)
        || !execution_matches
        || transition.intent.target_launch_selection != body.target_launch_selection
    {
        return Err("agent_runtime_transition_idempotency_conflict".into());
    }
    Ok(())
}
