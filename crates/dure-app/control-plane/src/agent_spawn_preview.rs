use super::*;
use crate::agent_spawn_worktree::{AgentSpawnPreviewWorktree, normalize_agent_spawn_worktree};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentSpawnPreviewBody {
    schema_version: u16,
    idempotency_key: String,
    #[serde(default)]
    include_presentation_project: bool,
    #[serde(default)]
    project_id: Option<ProjectIdV1>,
    #[serde(default)]
    project_path: Option<String>,
    provider_id: ProviderIdV1,
    #[serde(default = "default_agent_execution_profile")]
    execution_profile: AgentExecutionProfileV1,
    agent_name: String,
    worktree: AgentSpawnPreviewWorktree,
    #[serde(default)]
    provider_conversation_ref: AgentProviderConversationPlanV1,
    #[serde(default)]
    permission_override: Option<ProviderLaunchPermissionOverrideV1>,
    prompt_digest: Option<AgentSpawnPromptDigestV1>,
    #[serde(default)]
    setup_command: Option<WorkflowSessionPrelaunchCommandV1>,
    #[serde(default)]
    model: Option<AgentSpawnModelSelectionV1>,
    #[serde(default)]
    effort: Option<AgentSpawnEffortSelectionV1>,
    #[serde(default)]
    interaction_preference: Option<AgentSpawnInteractionPreferenceV1>,
}

pub(super) async fn preview_agent_spawn(
    state: &ServiceState,
    authority: &BackendRequestAuthority,
    body: &Value,
) -> Result<Value, String> {
    let incoming: AgentSpawnPreviewBody = serde_json::from_value(body.clone())
        .map_err(|_| "agent_spawn_request_invalid".to_string())?;
    if incoming.schema_version != AGENT_SPAWN_SCHEMA_VERSION_V1
        || incoming.project_id.is_some() == incoming.project_path.is_some()
        || incoming
            .project_id
            .as_ref()
            .is_some_and(|project_id| !valid_project_id(project_id.as_str()))
        || incoming
            .project_path
            .as_deref()
            .is_some_and(|path| !valid_project_path(path))
    {
        return Err("agent_spawn_request_invalid".into());
    }
    let catalog = projects_catalog(state).await?;
    let project = incoming
        .project_path
        .as_deref()
        .map_or_else(
            || {
                incoming
                    .project_id
                    .as_ref()
                    .and_then(|project_id| catalog.project(project_id.as_str()))
            },
            |path| catalog.project_for_path(path),
        )
        .ok_or_else(|| "agent_spawn_project_not_found".to_string())?;
    project_catalog::validate_project_root(&project).map_err(str::to_string)?;
    let presentation_project = incoming
        .include_presentation_project
        .then(|| {
            let projection = project.projection();
            project
                .root()
                .to_str()
                .map(|root| {
                    json!({
                        "projectId": projection.id,
                        "rootId": projection.root_id,
                        "repositoryId": projection.repository_id,
                        "root": root,
                    })
                })
                .ok_or_else(|| "agent_spawn_project_path_invalid".to_string())
        })
        .transpose()?;
    let service_resolved_base = matches!(
        &incoming.worktree,
        AgentSpawnPreviewWorktree::Dedicated {
            base_commit_sha: None,
            ..
        }
    );
    let source_agent_id = match &incoming.worktree {
        AgentSpawnPreviewWorktree::ExistingWorkspace {
            source_agent_id, ..
        } => Some(source_agent_id.clone()),
        _ => None,
    };
    let _source_guard = match source_agent_id.as_ref() {
        Some(source_agent_id) => Some(state.agent_operations.acquire(source_agent_id).await),
        None => None,
    };
    let worktree = normalize_agent_spawn_worktree(
        state,
        &project,
        &incoming.idempotency_key,
        incoming.worktree,
    )
    .await?;
    let request = AgentSpawnPreviewIntentV1 {
        schema_version: incoming.schema_version,
        idempotency_key: incoming.idempotency_key,
        project_id: ProjectIdV1::new(project.projection().id.clone())
            .map_err(|_| "agent_spawn_request_invalid".to_string())?,
        provider_id: incoming.provider_id,
        execution_profile: incoming.execution_profile,
        agent_name: incoming.agent_name,
        worktree,
        provider_conversation_ref: incoming.provider_conversation_ref,
        permission_override: incoming.permission_override,
        prompt_digest: incoming.prompt_digest,
        setup_command: incoming.setup_command,
        model: incoming.model,
        effort: incoming.effort,
        interaction_preference: incoming.interaction_preference,
    };
    state
        .credential_profiles
        .resolve(&request.provider_id, &request.execution_profile)
        .await
        .map_err(|error| error.code().to_string())?;
    if !state
        .runtime_adapters
        .contains_runtime_kind(&agent_spawn_api::runtime_kind_id())
    {
        return Err("agent_spawn_runtime_unavailable".into());
    }
    workspace_git::validate_preview_policy(project.root(), &request.worktree).await?;
    let recorded_at_ms = now_ms().map_err(|_| "agent_spawn_clock_unavailable".to_string())?;
    let receipt = if service_resolved_base {
        agent_spawn_api::preview_with_service_resolved_base(
            &state.store,
            state.agent_providers.as_ref(),
            &authority.backend_id,
            &authority.generation,
            project.projection().clone(),
            request,
            recorded_at_ms,
        )
        .await?
    } else {
        agent_spawn_api::preview(
            &state.store,
            state.agent_providers.as_ref(),
            &authority.backend_id,
            &authority.generation,
            project.projection().clone(),
            request,
            recorded_at_ms,
        )
        .await?
    };
    let mut response = json!({ "schemaVersion": 1, "receipt": receipt });
    if let Some(project) = presentation_project {
        response["presentationProject"] = project;
    }
    Ok(response)
}
