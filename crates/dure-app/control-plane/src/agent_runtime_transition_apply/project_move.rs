//! Project moves use the runtime transition journal, including its restart and
//! repair boundaries. This first capability admits only proven stopped native
//! Codex sources without a retained checkout claim, on the selected backend.
use super::*;
use dure_app::{
    AgentRuntimeWorkspaceMoveV1, ProjectIdV1, ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewBody {
    schema_version: u16,
    agent_id: AgentIdV1,
    project_id: ProjectIdV1,
    idempotency_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApplyBody {
    schema_version: u16,
    plan: AgentRuntimeTransitionIntentV1,
    confirm_restart: bool,
}

pub(crate) async fn preview(
    state: &ServiceState,
    body: PreviewBody,
) -> Result<serde_json::Value, crate::BackendDispatchError> {
    if body.schema_version != 1 || !valid_token(&body.idempotency_key) {
        return Err("agent_project_move_request_invalid".into());
    }
    let _guard = state.agent_operations.acquire(&body.agent_id).await;
    let plan = plan(
        state,
        &body.agent_id,
        &body.project_id,
        &body.idempotency_key,
        now_ms().map_err(|_| "agent_project_move_clock_unavailable".to_string())?,
    )
    .await?;
    Ok(serde_json::json!({"schemaVersion": 1, "plan": plan, "requiresRestartConfirmation": true}))
}

pub(crate) async fn apply(
    state: &ServiceState,
    body: ApplyBody,
) -> Result<serde_json::Value, crate::BackendDispatchError> {
    if body.schema_version != 1 || !body.confirm_restart || body.plan.workspace_move.is_none() {
        return Err("agent_project_move_confirmation_required".into());
    }
    let _guard = state
        .agent_operations
        .acquire(&body.plan.source.agent_id)
        .await;
    body.plan.validate().map_err(store_error)?;
    let transition = if let Some(existing) = state
        .store
        .agent_runtime_transition(&body.plan.operation_id)
        .await
        .map_err(store_error)?
    {
        if existing.intent != body.plan {
            return Err("agent_project_move_idempotency_conflict".into());
        }
        existing
    } else {
        let movement = body.plan.workspace_move.as_ref().unwrap();
        let current = plan(
            state,
            &body.plan.source.agent_id,
            &movement.target_project.project_id,
            &body.plan.idempotency_key,
            body.plan.requested_at_ms,
        )
        .await?;
        if current != body.plan {
            return Err("agent_project_move_preview_stale".into());
        }
        state
            .store
            .admit_agent_runtime_transition(&body.plan)
            .await
            .map_err(store_error)?
    };
    let receipt = drive_outcome(drive_locked(state, transition).await?)?;
    Ok(serde_json::json!({"schemaVersion": 1, "receipt": receipt}))
}

async fn plan(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    project_id: &ProjectIdV1,
    key: &str,
    requested_at_ms: i64,
) -> Result<AgentRuntimeTransitionIntentV1, crate::BackendDispatchError> {
    if !valid_token(key) {
        return Err("agent_project_move_request_invalid".into());
    }
    let source = crate::agent_runtime_projection::read_locked(state, agent_id)
        .await?
        .into_explicit_successor_source()
        .map_err(|_| "agent_project_move_source_unavailable".to_string())?;
    if source.selection.interaction_profile != AgentInteractionProfileV1::NativeCli {
        return Err("agent_project_move_structured_unsupported".into());
    }
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = &source.authority else {
        return Err("agent_project_move_source_unavailable".into());
    };
    // Closed and unreachable are distinct. Even an old close journal does not
    // grant permission to launch against an unobservable native generation.
    let inspection = inspect_native_source(state, &source.selection, authority)
        .await
        .map_err(|error| error.code().to_string())?;
    if !inspection.is_exited_exact() {
        return Err("agent_project_move_source_must_be_stopped".into());
    }
    let conversation = AgentProviderConversationPlanV1::from_option(
        authority.binding.provider_conversation_id.clone(),
    )
    .map_err(store_error)?;
    if conversation.as_option().is_none() {
        return Err("agent_runtime_provider_conversation_unavailable".into());
    }
    if crate::agent_runtime_checkout::resolve(state, &source.selection, &source.authority)
        .await?
        .is_some()
    {
        return Err("agent_project_move_checkout_handoff_unsupported".into());
    }
    let source_agent = state
        .store
        .agent(agent_id)
        .await
        .map_err(store_error)?
        .ok_or("agent_project_move_source_unavailable")?;
    let source_workspace = state
        .store
        .workspace(&source_agent.workspace_id)
        .await
        .map_err(store_error)?
        .ok_or("agent_runtime_workspace_unavailable")?;
    if source_workspace.project_id == *project_id {
        return Err("agent_project_move_already_in_project".into());
    }
    let catalog = crate::projects_catalog(state).await?;
    let project = catalog
        .project(project_id.as_str())
        .ok_or("agent_project_move_project_not_registered")?;
    crate::project_catalog::validate_project_root(&project).map_err(str::to_owned)?;
    let root = project
        .root()
        .to_str()
        .ok_or("agent_runtime_workspace_unavailable")?
        .to_owned();
    let target_project = match state.store.project(project_id).await.map_err(store_error)? {
        Some(project) if project.root_path == root => project,
        Some(_) => return Err("agent_project_move_project_changed".into()),
        None => ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: root.clone(),
            display_name: project.projection().display_name.clone(),
            created_at_ms: requested_at_ms,
            updated_at_ms: requested_at_ms,
        },
    };
    let (operation_id, _) = runtime_transition_identity(key)?;
    let target_workspace = WorkspaceRecordV1 {
        workspace_id: WorkspaceIdV1::new(format!("move-{}", operation_id.as_str()))
            .map_err(|_| "agent_project_move_request_invalid")?,
        project_id: project_id.clone(),
        root_path: root,
        base_commit_sha: None,
        created_at_ms: requested_at_ms,
        updated_at_ms: requested_at_ms,
    };
    let selection = source.selection;
    let intent = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id,
        idempotency_key: key.into(),
        source: selection.clone(),
        source_authority: source.authority,
        source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: conversation,
        target_interaction_profile: selection.interaction_profile,
        target_execution_profile: selection.execution_profile.clone(),
        target_launch_selection: None,
        workspace_move: Some(AgentRuntimeWorkspaceMoveV1 {
            source_agent,
            source_workspace,
            target_project,
            target_workspace,
            registered_root_id: project.projection().root_id.clone(),
            observed_root_id: crate::project_catalog::observed_project_root_identity(&project)
                .map_err(str::to_owned)?,
            registered_repository_id: project.projection().repository_id.clone(),
        }),
        requested_at_ms,
    };
    intent.validate().map_err(store_error)?;
    preflight(state, &intent).await?;
    native::preflight_target(
        state,
        &selection,
        &intent.effective_launch_selection(),
        &selection.permission_mode,
        intent.provider_conversation_ref.as_option(),
    )?;
    Ok(intent)
}

/// Recheck host-local registration and exact history before each target effect.
/// Never transfer project files or provider history across execution hosts.
pub(super) async fn preflight(
    state: &ServiceState,
    intent: &AgentRuntimeTransitionIntentV1,
) -> Result<(), String> {
    let Some(movement) = &intent.workspace_move else {
        return Ok(());
    };
    let catalog = crate::projects_catalog(state).await?;
    let project = catalog
        .project(movement.target_project.project_id.as_str())
        .ok_or("agent_project_move_project_not_registered")?;
    crate::project_catalog::validate_project_root(&project).map_err(str::to_owned)?;
    if project.root().to_str() != Some(movement.target_workspace.root_path.as_str())
        || crate::project_catalog::observed_project_root_identity(&project)?
            != movement.observed_root_id
        || project.projection().root_id != movement.registered_root_id
        || project.projection().repository_id != movement.registered_repository_id
    {
        return Err("agent_project_move_project_changed".into());
    }
    let credential = state
        .credential_profiles
        .resolve(&intent.source.provider_id, &intent.target_execution_profile)
        .await
        .map_err(|error| error.code().to_owned())?;
    let home = credential.map(|profile| profile.directory().to_path_buf());
    let provider = intent.source.provider_id.clone();
    let conversation = intent
        .provider_conversation_ref
        .as_option()
        .ok_or("agent_project_move_history_unavailable")?
        .to_owned();
    tokio::task::spawn_blocking(move || {
        dure_provider_profile::transcript::preflight_project_move_history(
            provider.as_str(),
            home,
            &conversation,
        )
    })
    .await
    .map_err(|_| "agent_project_move_history_unavailable")?
    .map_err(str::to_owned)
}
