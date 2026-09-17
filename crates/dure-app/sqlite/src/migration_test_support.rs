use sqlx::{Executor, Sqlite, SqlitePool};

use crate::schema::{
    CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX, CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX,
    CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX, CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX,
    CREATE_AGENT_DISPATCH_STOPS_V33,
};

pub(crate) async fn remove_post_v32_dispatch_stop_storage<'e, E>(executor: E)
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query("DROP TABLE IF EXISTS agent_dispatch_stops")
        .execute(executor)
        .await
        .expect("a pre-v33 migration fixture must not retain current dispatch-stop storage");
}

pub(crate) async fn downgrade_dispatch_stop_fixture_to_v33(
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> {
    for index in [
        "agent_dispatch_stops_active_agent_idx",
        "agent_dispatch_stops_active_spawn_idx",
        "agent_dispatch_stops_spawn_history_idx",
        "agent_dispatch_stops_recovery_idx",
    ] {
        sqlx::query(&format!("DROP INDEX {index}"))
            .execute(pool)
            .await?;
    }
    sqlx::query("ALTER TABLE agent_dispatch_stops RENAME TO agent_dispatch_stops_v35_seed")
        .execute(pool)
        .await?;
    sqlx::query(CREATE_AGENT_DISPATCH_STOPS_V33)
        .execute(pool)
        .await?;
    sqlx::query(
        r#"
        INSERT INTO agent_dispatch_stops (
            operation_id, agent_id, spawn_operation_id, plan_token, state,
            journal_revision, runtime_selection_json, runtime_authority_json,
            owned_checkout_json, runtime_close_operation_id,
            terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
            updated_at_ms
        )
        SELECT
            operation_id, agent_id, spawn_operation_id, plan_token, state,
            journal_revision, runtime_selection_json, runtime_authority_json,
            json_extract(workspace_action_json, '$.ownedCheckout'),
            runtime_close_operation_id,
            terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
            updated_at_ms
        FROM agent_dispatch_stops_v35_seed
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("DROP TABLE agent_dispatch_stops_v35_seed")
        .execute(pool)
        .await?;
    for statement in [
        CREATE_AGENT_DISPATCH_STOPS_ACTIVE_AGENT_INDEX,
        CREATE_AGENT_DISPATCH_STOPS_ACTIVE_SPAWN_INDEX,
        CREATE_AGENT_DISPATCH_STOPS_SPAWN_HISTORY_INDEX,
        CREATE_AGENT_DISPATCH_STOPS_RECOVERY_INDEX,
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}
