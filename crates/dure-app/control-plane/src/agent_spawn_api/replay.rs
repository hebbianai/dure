use super::*;

pub(super) fn reconcile_existing(
    existing: AgentSpawnJournalReceiptV1,
    mut authority: AgentSpawnAuthorityV1,
    mut request: AgentSpawnPreviewIntentV1,
    runtime: AgentSpawnRuntimePlanV1,
    worktree_base_reconciliation: WorktreeBaseReconciliation,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    // The transport boundary already proved the active service generation.
    // Rebuild against the persisted creator generation so a successor can
    // replay only the otherwise identical operation and plan token.
    authority.backend_generation = existing.plan.authority.backend_generation.clone();
    if matches!(
        worktree_base_reconciliation,
        WorktreeBaseReconciliation::ServiceResolved
    ) {
        if let (
            dure_app::AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha: existing_base,
                branch: existing_branch,
                ..
            },
            dure_app::AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha: requested_base,
                branch: requested_branch,
                ..
            },
        ) = (&existing.plan.request.worktree, &mut request.worktree)
        {
            if existing_branch == requested_branch {
                requested_base.clone_from(existing_base);
            }
        }
    }
    let persisted_request = &existing.plan.request;
    let persisted_resolution = existing
        .plan
        .provider_launch_defaults
        .as_ref()
        .ok_or_else(|| "agent_spawn_idempotency_conflict".to_string())?;
    let runtime_matches = match &existing.plan.launch {
        AgentSpawnLaunchPlanV1::NativeCli {
            runtime: persisted, ..
        } => persisted == &runtime,
        AgentSpawnLaunchPlanV1::StructuredProtocol => true,
    };
    if existing.plan.schema_version != AGENT_SPAWN_SCHEMA_VERSION_V1
        || existing.plan.authority != authority
        || !runtime_matches
        || persisted_request.schema_version != request.schema_version
        || persisted_request.idempotency_key != request.idempotency_key
        || persisted_request.project_id != request.project_id
        || persisted_request.provider_id != request.provider_id
        || persisted_request.execution_profile != request.execution_profile
        || persisted_request.agent_name != request.agent_name
        || persisted_request.worktree != request.worktree
        || persisted_request.provider_conversation_ref != request.provider_conversation_ref
        || persisted_request.prompt_digest != request.prompt_digest
        || persisted_request.setup_command != request.setup_command
        || persisted_request.model != request.model
        || persisted_request.effort != request.effort
        || persisted_resolution.permission_override != request.permission_override
    {
        return Err("agent_spawn_idempotency_conflict".into());
    }
    Ok(existing)
}
