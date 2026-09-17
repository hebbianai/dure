use super::*;

pub(super) fn workspace_request(
    receipt: &AgentSpawnJournalReceiptV1,
    execution: &AgentSpawnExecution<'_>,
) -> Result<WorkspaceAcquireRequest, String> {
    if !execution.project_root.is_absolute() || execution.project_root.to_str().is_none() {
        return Err("agent_spawn_project_path_invalid".into());
    }
    Ok(WorkspaceAcquireRequest {
        project_root: execution.project_root.clone(),
        workspace_id: receipt.plan.workspace_id.clone(),
        registration_id: receipt.operation_id.clone(),
        registration: receipt.checkout_registration.clone(),
        policy: receipt.plan.request.worktree.clone(),
    })
}

pub(super) async fn resolve_workspace(
    store: &SqliteDomainStore,
    receipt: &mut AgentSpawnJournalReceiptV1,
    execution: Option<&AgentSpawnExecution<'_>>,
) -> Result<String, String> {
    let execution =
        execution.ok_or_else(|| "agent_spawn_execution_context_required".to_string())?;
    let handle = execution
        .workspace_acquirer
        .resolve(workspace_request(receipt, execution)?)
        .await
        .map_err(|failure| failure.code)?;
    validate_workspace_handle(receipt, &handle)?;
    validate_committed_workspace(receipt, &handle)?;
    *receipt = record_checkout_registration(store, receipt.clone(), &handle).await?;
    handle
        .root
        .to_str()
        .filter(|path| !path.is_empty() && !path.contains('\0'))
        .map(str::to_string)
        .ok_or_else(|| "agent_spawn_workspace_path_invalid".to_string())
}

pub(super) async fn record_checkout_registration(
    store: &SqliteDomainStore,
    receipt: AgentSpawnJournalReceiptV1,
    handle: &WorkspaceHandle,
) -> Result<AgentSpawnJournalReceiptV1, String> {
    match (&receipt.checkout_registration, &handle.registration) {
        (None, Some(registration)) => {
            append(
                store,
                &receipt,
                AgentSpawnJournalEventBodyV1::CheckoutClaimed {
                    registration: registration.clone(),
                },
            )
            .await
        }
        (existing, current) if existing == current => Ok(receipt),
        _ => Err("agent_spawn_workspace_receipt_mismatch".into()),
    }
}

pub(super) fn validate_workspace_handle(
    receipt: &AgentSpawnJournalReceiptV1,
    handle: &WorkspaceHandle,
) -> Result<(), String> {
    if !handle.root.is_absolute() {
        return Err("agent_spawn_workspace_path_invalid".into());
    }
    let shape_matches = match &receipt.plan.request.worktree {
        AgentSpawnWorktreePolicyV1::ProjectRoot
        | AgentSpawnWorktreePolicyV1::ExistingWorkspace { .. } => {
            handle.disposition == AgentSpawnStageDispositionV1::AdoptedExisting
                && handle.lease.is_none()
        }
        AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } => {
            handle.disposition == AgentSpawnStageDispositionV1::AdoptedExisting
                && handle.lease.is_none()
                && handle.root.as_path() == std::path::Path::new(&instance.canonical_path)
        }
        AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } => {
            handle.disposition == AgentSpawnStageDispositionV1::CreatedDureOwned
                && handle.lease.as_ref().is_some_and(|lease| {
                    dure_app::AgentSpawnWorkspaceLeaseV1::for_dedicated(
                        &receipt.plan.workspace_id,
                        branch,
                    )
                    .is_ok_and(|expected| expected == *lease)
                })
        }
    };
    if !shape_matches {
        return Err("agent_spawn_workspace_identity_mismatch".into());
    }
    Ok(())
}

fn validate_committed_workspace(
    receipt: &AgentSpawnJournalReceiptV1,
    handle: &WorkspaceHandle,
) -> Result<(), String> {
    let evidence = receipt.completed.iter().find_map(|stage| {
        if let AgentSpawnStageEvidenceV1::Worktree {
            workspace_id,
            disposition,
            lease,
        } = &stage.evidence
        {
            Some((workspace_id, disposition, lease))
        } else {
            None
        }
    });
    match evidence {
        Some((workspace_id, disposition, lease))
            if workspace_id == &receipt.plan.workspace_id
                && disposition == &handle.disposition
                && lease == &handle.lease =>
        {
            Ok(())
        }
        _ => Err("agent_spawn_workspace_receipt_mismatch".into()),
    }
}
