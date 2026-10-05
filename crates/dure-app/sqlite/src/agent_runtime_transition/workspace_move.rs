use super::*;
use crate::records;

pub(super) async fn prepare(
    connection: &mut SqliteConnection,
    intent: &AgentRuntimeTransitionIntentV1,
) -> Result<(), DomainStoreErrorV1> {
    let Some(movement) = &intent.workspace_move else {
        return Ok(());
    };
    require_source(connection, movement).await?;
    match records::project(&mut *connection, &movement.target_project.project_id).await? {
        Some(project) if project != movement.target_project => return Err(conflict(intent)),
        Some(_) => {}
        None => records::upsert_project(&mut *connection, &movement.target_project).await?,
    }
    if let Some(workspace) =
        records::workspace_on(connection, &movement.target_workspace.workspace_id).await?
    {
        if workspace != movement.target_workspace {
            return Err(conflict(intent));
        }
    } else {
        records::upsert_workspace(&mut *connection, &movement.target_workspace).await?;
    }
    Ok(())
}

pub(super) async fn commit(
    connection: &mut SqliteConnection,
    record: &AgentRuntimeTransitionRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let Some(movement) = &record.intent.workspace_move else {
        return Ok(());
    };
    require_source(connection, movement).await?;
    if records::project(&mut *connection, &movement.target_project.project_id)
        .await?
        .as_ref()
        != Some(&movement.target_project)
        || records::workspace_on(connection, &movement.target_workspace.workspace_id)
            .await?
            .as_ref()
            != Some(&movement.target_workspace)
        || !matches!(&record.target_authority, Some(AgentRuntimeBindingAuthorityV1::NativeCli {authority})
            if authority.runtime_workspace_id == movement.target_workspace.workspace_id.as_str())
    {
        return Err(conflict(&record.intent));
    }
    // Only the journal commit may change an Agent's workspace. Ordinary upsert
    // and bootstrap retain their immutable-workspace contract. No files move.
    sqlx::query("UPDATE agents SET workspace_id = ?2, updated_at_ms = ?3 WHERE agent_id = ?1")
        .bind(movement.source_agent.agent_id.as_str())
        .bind(movement.target_workspace.workspace_id.as_str())
        .bind(
            record
                .updated_at_ms
                .max(movement.source_agent.updated_at_ms),
        )
        .execute(connection)
        .await
        .map_err(|error| map_sqlx("commit_agent_workspace_move", error))?;
    Ok(())
}

async fn require_source(
    connection: &mut SqliteConnection,
    movement: &dure_app::AgentRuntimeWorkspaceMoveV1,
) -> Result<(), DomainStoreErrorV1> {
    if records::agent(&mut *connection, &movement.source_agent.agent_id)
        .await?
        .as_ref()
        != Some(&movement.source_agent)
        || records::workspace_on(connection, &movement.source_workspace.workspace_id)
            .await?
            .as_ref()
            != Some(&movement.source_workspace)
        || crate::agent_runtime_checkout::checkout_on(connection, &movement.source_agent.agent_id)
            .await?
            .is_some()
    {
        return Err(identity_conflict(
            "agent workspace move",
            movement.source_agent.agent_id.as_str(),
            "source workspace or checkout ownership changed",
        ));
    }
    Ok(())
}

fn conflict(intent: &AgentRuntimeTransitionIntentV1) -> DomainStoreErrorV1 {
    identity_conflict(
        "agent workspace move",
        intent.source.agent_id.as_str(),
        "destination workspace changed",
    )
}
