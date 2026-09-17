use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentInteractionBindingV1, AgentInteractionProfileV1,
    AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1, AgentRuntimeTransitionRecordV1,
    AgentTimelineEpochV1,
};

use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntimeErrorV1 as Error,
    replacement_target_conversation_matches,
};

use super::{conflict, digest, invalid, safe_token};

pub(super) fn initial_binding(
    agent: &dure_app::AgentRecordV1,
    request: &StructuredProviderOpenRequestV1,
    backend_generation: &str,
) -> Result<AgentInteractionBindingV1, Error> {
    let provider = agent.provider_id.as_str();
    let seed = digest(&format!(
        "{provider}-structured-open/v1\0{}\0{}\0{:?}\0{}",
        agent.agent_id,
        backend_generation,
        request.execution_profile,
        request
            .provider_conversation_ref
            .as_deref()
            .unwrap_or_default(),
    ));
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new(format!(
            "{provider}-chat-{}",
            &seed[..24]
        ))
        .map_err(|_| invalid())?,
        agent_id: agent.agent_id.clone(),
        provider_id: agent.provider_id.clone(),
        execution_profile: request.execution_profile.clone(),
        provider_conversation_ref: request.provider_conversation_ref.clone(),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: format!("{provider}-runtime-{}", &seed[24..48]),
            provider_epoch: format!("{provider}-server-{}", &seed[40..64]),
        },
        timeline_epoch: AgentTimelineEpochV1::new(format!("{provider}-timeline-{}", &seed[..24]))
            .map_err(|_| invalid())?,
        binding_revision: 1,
        history_complete: request.provider_conversation_ref.is_none(),
        created_at_ms: agent.created_at_ms,
        updated_at_ms: agent.created_at_ms,
    };
    binding.validate().map_err(|_| invalid())?;
    Ok(binding)
}

pub(super) fn transition_runtime(
    transition: &AgentRuntimeTransitionRecordV1,
) -> AgentProviderRuntimeFenceV1 {
    let operation_id = transition
        .last_repair_operation_id
        .as_ref()
        .unwrap_or(&transition.intent.operation_id);
    runtime_for_operation(
        transition.intent.source.provider_id.as_str(),
        operation_id.as_str(),
    )
}

pub(super) fn failed_binding_recovery_runtime(
    source: &AgentInteractionBindingV1,
) -> AgentProviderRuntimeFenceV1 {
    let provider = source.provider_id.as_str();
    let seed = digest(&format!(
        "{provider}-runtime-recovery/v1\0{}\0{}\0{}",
        source.interaction_session_id,
        source.runtime.runtime_generation,
        source.runtime.provider_epoch,
    ));
    AgentProviderRuntimeFenceV1 {
        runtime_generation: format!("{provider}-runtime-{}", &seed[..24]),
        provider_epoch: format!("{provider}-server-{}", &seed[24..48]),
    }
}

fn runtime_for_operation(provider: &str, operation_id: &str) -> AgentProviderRuntimeFenceV1 {
    let seed = digest(&format!(
        "{provider}-runtime-transition/v1\0{}",
        operation_id,
    ));
    AgentProviderRuntimeFenceV1 {
        runtime_generation: format!("{provider}-runtime-{}", &seed[..24]),
        provider_epoch: format!("{provider}-server-{}", &seed[24..48]),
    }
}

fn is_transition_target(
    candidate: &AgentInteractionBindingV1,
    request: &StructuredProviderOpenRequestV1,
) -> bool {
    candidate.agent_id == request.agent_id
        && candidate.execution_profile == request.execution_profile
        && request
            .provider_conversation_ref
            .as_ref()
            .is_none_or(|expected| candidate.provider_conversation_ref.as_ref() == Some(expected))
}

pub(super) fn is_native_transition_target(
    candidate: &AgentInteractionBindingV1,
    request: &StructuredProviderOpenRequestV1,
    target: &AgentProviderRuntimeFenceV1,
    requested_at_ms: i64,
) -> bool {
    is_transition_target(candidate, request)
        && &candidate.runtime == target
        && candidate.updated_at_ms >= requested_at_ms
}

pub(super) fn is_structured_transition_target(
    candidate: &AgentInteractionBindingV1,
    source: &AgentInteractionBindingV1,
    request: &StructuredProviderOpenRequestV1,
    target: &AgentProviderRuntimeFenceV1,
    requested_at_ms: i64,
) -> bool {
    let Some(published_revision) = source.binding_revision.checked_add(1) else {
        return false;
    };
    is_transition_target(candidate, request)
        && &candidate.runtime == target
        && candidate.provider_id == source.provider_id
        && candidate.schema_version == source.schema_version
        && candidate.interaction_session_id == source.interaction_session_id
        && candidate.timeline_epoch == source.timeline_epoch
        && replacement_target_conversation_matches(
            request.provider_conversation_ref.as_deref(),
            candidate.provider_conversation_ref.as_deref(),
            published_revision,
            candidate.binding_revision,
        )
        && candidate.history_complete == source.history_complete
        && candidate.created_at_ms == source.created_at_ms
        && candidate.updated_at_ms >= requested_at_ms
}

pub(super) fn is_exact_failed_target_successor(
    candidate: &AgentInteractionBindingV1,
    failed: &AgentInteractionBindingV1,
    target: &AgentProviderRuntimeFenceV1,
    target_execution_profile: &dure_app::AgentExecutionProfileV1,
) -> bool {
    candidate.schema_version == failed.schema_version
        && candidate.interaction_session_id == failed.interaction_session_id
        && candidate.agent_id == failed.agent_id
        && candidate.provider_id == failed.provider_id
        && &candidate.execution_profile == target_execution_profile
        && candidate.provider_conversation_ref == failed.provider_conversation_ref
        && &candidate.runtime == target
        && candidate.timeline_epoch == failed.timeline_epoch
        && failed
            .binding_revision
            .checked_add(1)
            .is_some_and(|revision| candidate.binding_revision == revision)
        && candidate.history_complete == failed.history_complete
        && candidate.created_at_ms == failed.created_at_ms
        && candidate.updated_at_ms >= failed.updated_at_ms
}

pub(super) fn validate_request(request: &StructuredProviderOpenRequestV1) -> Result<(), Error> {
    request
        .execution_profile
        .validate()
        .map_err(|_| invalid())?;
    if request
        .provider_conversation_ref
        .as_deref()
        .is_some_and(|reference| !safe_token(reference))
    {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn validate_existing_binding(
    provider_id: &str,
    binding: &AgentInteractionBindingV1,
    request: &StructuredProviderOpenRequestV1,
) -> Result<(), Error> {
    if binding.agent_id != request.agent_id
        || binding.provider_id.as_str() != provider_id
        || binding.execution_profile != request.execution_profile
        || request
            .provider_conversation_ref
            .as_ref()
            .is_some_and(|reference| binding.provider_conversation_ref.as_ref() != Some(reference))
    {
        return Err(conflict());
    }
    Ok(())
}

pub(super) fn validate_replacement_request(
    provider_id: &str,
    request: &StructuredProviderOpenRequestV1,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<(), Error> {
    validate_request(request)?;
    transition.validate().map_err(|_| conflict())?;
    if !transition.permits_target_effects()
        || transition.intent.source.provider_id.as_str() != provider_id
        || transition.intent.source.agent_id != request.agent_id
        || transition.intent.target_interaction_profile
            != AgentInteractionProfileV1::StructuredProtocol
        || transition.intent.target_execution_profile != request.execution_profile
        || transition.intent.provider_conversation_ref.as_option()
            != request.provider_conversation_ref.as_deref()
        || transition.intent.effective_permission_mode() != request.permission_mode
        // The intent's effective launch selection is the one authority for
        // the replacement's model/effort — the source values only when no
        // snapshot rides the transition.
        || transition.intent.effective_launch_selection().model != request.model
        || transition.intent.effective_launch_selection().effort != request.effort
    {
        return Err(conflict());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use dure_app::{
        AgentExecutionProfileV1, AgentIdV1, AgentRuntimeBindingAuthorityV1,
        AgentRuntimeLaunchSelectionV1, AgentRuntimeSelectionV1,
        AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
        AgentRuntimeTransitionIntentV1, AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1,
        OperationIdV1, ProviderIdV1, ProviderPermissionModeV1, advance_agent_runtime_transition_v1,
    };

    use super::*;

    #[test]
    fn selection_only_replacement_admits_the_new_launch_selection() {
        let agent_id = AgentIdV1::new("agent-codex-selection").unwrap();
        let provider_id = ProviderIdV1::new("codex").unwrap();
        let execution_profile = AgentExecutionProfileV1::ProviderDefault;
        let binding = AgentInteractionBindingV1 {
            schema_version: 1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-codex").unwrap(),
            agent_id: agent_id.clone(),
            provider_id: provider_id.clone(),
            execution_profile: execution_profile.clone(),
            provider_conversation_ref: Some("conversation-codex".into()),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-codex".into(),
                provider_epoch: "thread-codex".into(),
            },
            timeline_epoch: AgentTimelineEpochV1::new("timeline-codex").unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 10,
            updated_at_ms: 10,
        };
        let new_model = AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap();
        let new_effort = AgentSpawnEffortSelectionV1::parse("xhigh").unwrap();
        let admitted = AgentRuntimeTransitionRecordV1::admitted(AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("transition-codex-selection").unwrap(),
            idempotency_key: "transition-codex-selection-key".into(),
            source: AgentRuntimeSelectionV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
                provider_id,
                interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                execution_profile: execution_profile.clone(),
                permission_mode: ProviderPermissionModeV1::Default,
                model: None,
                effort: None,
                revision: 1,
                selected_by_operation_id: None,
                updated_at_ms: 10,
            },
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-codex",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: execution_profile.clone(),
            target_launch_selection: Some(AgentRuntimeLaunchSelectionV1 {
                model: Some(new_model.clone()),
                effort: Some(new_effort.clone()),
                permission_mode: Some(ProviderPermissionModeV1::SkipPermissions),
            }),
            requested_at_ms: 11,
        })
        .unwrap();
        let stopped = advance_agent_runtime_transition_v1(
            &admitted,
            &AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: admitted.intent.operation_id.clone(),
                expected_journal_revision: 1,
                advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
                advanced_at_ms: 12,
            },
        )
        .unwrap();

        // The apply path builds the open request from the intent's effective
        // launch selection; the fence must admit exactly that.
        let request = StructuredProviderOpenRequestV1 {
            agent_id: agent_id.clone(),
            execution_profile: execution_profile.clone(),
            provider_conversation_ref: Some("conversation-codex".into()),
            permission_mode: ProviderPermissionModeV1::SkipPermissions,
            model: Some(new_model),
            effort: Some(new_effort),
        };
        assert!(validate_replacement_request("codex", &request, &stopped).is_ok());

        // A request still carrying the OLD source selection must conflict.
        let stale = StructuredProviderOpenRequestV1 {
            model: None,
            effort: None,
            permission_mode: ProviderPermissionModeV1::Default,
            ..request.clone()
        };
        assert!(validate_replacement_request("codex", &stale, &stopped).is_err());

        let mut failed_target = binding.clone();
        failed_target.execution_profile = AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-failed".into(),
            credential_generation: Some("credential-failed-1".into()),
        };
        failed_target.runtime = AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-codex-failed".into(),
            provider_epoch: "thread-codex-failed".into(),
        };
        failed_target.binding_revision += 1;
        failed_target.updated_at_ms = 12;
        assert!(
            !is_structured_transition_target(
                &failed_target,
                &binding,
                &request,
                &failed_target.runtime,
                11,
            ),
            "runtime lineage without exact target selection is not effect authority"
        );

        let mut fresh_request = request.clone();
        fresh_request.provider_conversation_ref = None;
        let mut allocated_target = binding.clone();
        allocated_target.provider_conversation_ref = Some("allocated-by-thread-start".into());
        allocated_target.runtime = AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-codex-fresh-target".into(),
            provider_epoch: "thread-codex-fresh-target".into(),
        };
        allocated_target.updated_at_ms = 12;
        assert!(is_native_transition_target(
            &allocated_target,
            &fresh_request,
            &allocated_target.runtime,
            11,
        ));
        allocated_target.binding_revision = binding.binding_revision + 2;
        assert!(is_structured_transition_target(
            &allocated_target,
            &binding,
            &fresh_request,
            &allocated_target.runtime,
            11,
        ));
    }
}
