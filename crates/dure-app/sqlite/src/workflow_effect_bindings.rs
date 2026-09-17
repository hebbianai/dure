use sqlx::SqliteConnection;

/// Bind the first reporting Dispatch inside its creation transaction. Retained
/// results never follow a later task that happens to use the same Session.
pub(crate) async fn bind(
    connection: &mut SqliteConnection,
    agent_id: &str,
    dispatch_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE schedule_occurrences SET dispatch_id = ?2
        WHERE schema_version = 2 AND dispatch_id IS NULL AND operation_id IN (
            SELECT operation_id FROM agent_spawn_receipts
            WHERE json_extract(receipt_json, '$.plan.agentId') = ?1
        )"#,
    )
    .bind(agent_id)
    .bind(dispatch_id)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        r#"UPDATE workflow_action_effects SET report_dispatch_id = ?2
        WHERE report_dispatch_id IS NULL AND operation_id IN (
            SELECT operation_id FROM agent_spawn_receipts
            WHERE json_extract(receipt_json, '$.plan.agentId') = ?1
        )"#,
    )
    .bind(agent_id)
    .bind(dispatch_id)
    .execute(&mut *connection)
    .await?;
    Ok(())
}
