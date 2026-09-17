use super::rejected_failure;
use dure_app::{WorkflowSessionLaunchFailureV1, WorkflowSessionLaunchRequestV1};
use hmux_client::{
    MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION, ManagedCreateRequest, ManagedRehostRecipe,
    PresentationCheckpointPredecessor, ProviderConversationIdentitySeed, ProviderStateEnvironment,
};

pub(super) fn managed_launch_command(
    request: &WorkflowSessionLaunchRequestV1,
) -> Result<Vec<String>, WorkflowSessionLaunchFailureV1> {
    let mut provider_command = Vec::with_capacity(1 + request.provider_arguments.len());
    provider_command.push(request.provider_executable.clone());
    provider_command.extend(request.provider_arguments.iter().cloned());
    if let Some(prompt) = &request.initial_prompt {
        provider_command = dure_provider_adapter::native_provider_command_with_initial_prompt(
            &request.provider_id,
            request.provider_conversation_ref.as_deref(),
            provider_command,
            prompt,
        )
        .map_err(|error| rejected_failure(error.as_str()))?;
    }
    let Some(prelaunch_command) = request.prelaunch_command.as_ref() else {
        return Ok(provider_command);
    };
    let mut command = vec![
        "/bin/sh".into(),
        "-c".into(),
        "set -e; /bin/sh -c \"$1\"; shift; \"$@\"; status=$?; exit \"$status\"".into(),
        "dure-agent-setup".into(),
        prelaunch_command.as_str().into(),
    ];
    command.extend(provider_command);
    Ok(command)
}

pub(super) fn managed_create_request(
    request: &WorkflowSessionLaunchRequestV1,
    provider_state_environment: ProviderStateEnvironment,
    presentation_predecessor: Option<PresentationCheckpointPredecessor>,
) -> Result<ManagedCreateRequest, WorkflowSessionLaunchFailureV1> {
    let managed = ManagedCreateRequest::new(
        &request.launch_idempotency_key,
        &request.session_id,
        &request.workspace_id,
        request.provider_id.as_str(),
        crate::provider_permission::to_hmux(request.permission_mode.clone()),
        &request.working_directory,
        managed_launch_command(request)?,
        24,
        80,
    )
    .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?
    .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
    .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?;
    let managed = if let Some(provider_conversation_ref) = &request.provider_conversation_ref {
        managed
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new(
                    request.provider_id.as_str(),
                    provider_conversation_ref,
                )
                .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?,
            )
            .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?
    } else {
        managed
    };
    let managed = if let Some(resume) = &request.provider_resume {
        let command = std::iter::once(request.provider_executable.clone())
            .chain(resume.arguments.iter().cloned())
            .collect();
        let recipe = ManagedRehostRecipe::new(command, resume.launch_reference.clone())
            .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?;
        managed
            .with_managed_rehost_recipe(recipe)
            .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?
    } else {
        managed
    };
    let managed = if let Some(predecessor) = presentation_predecessor {
        managed
            .with_presentation_predecessor(predecessor)
            .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?
    } else {
        managed
    };
    let managed = if provider_state_environment.is_empty() {
        managed
    } else {
        managed
            .with_provider_state_environment(provider_state_environment)
            .map_err(|_| rejected_failure("hmux_managed_create_request_invalid"))?
    };
    Ok(managed)
}
