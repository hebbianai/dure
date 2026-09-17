use dure_app::{DomainStoreErrorV1, ScheduleRunSummaryV1};
use sqlx::{Row, SqlitePool};

use crate::error::{corrupt_row, map_sqlx, storage};

/// Read the retained canonical Dispatch result; no live session or workspace is required.
pub(crate) async fn inspect(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<(ScheduleRunSummaryV1, Option<String>)>, DomainStoreErrorV1> {
    let row = sqlx::query(r#"SELECT task.run_id, dispatch.task_id, dispatch.dispatch_id,
        dispatch.generation, authority.workspace_id, authority.blocked_by,
        dispatch.state, dispatch.completion_result
        FROM schedule_occurrences AS occurrence
        JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = occurrence.dispatch_id
        JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
        JOIN workflow_interaction_authorities AS authority ON authority.dispatch_id = dispatch.dispatch_id
        WHERE occurrence.idempotency_key = ?1"#)
        .bind(key).fetch_optional(pool).await.map_err(|e| map_sqlx("inspect_schedule_run", e))?;
    let Some(row) = row else { return Ok(None) };
    let read_error = |error| corrupt_row("schedule run", error);
    let state: String = row.try_get("state").map_err(read_error)?;
    let completed = match state.as_str() {
        "completed" => true,
        "starting" => false,
        _ => return Err(storage("corrupt_schedule_run", "unknown Dispatch state")),
    };
    let generation: i64 = row.try_get("generation").map_err(read_error)?;
    let summary = ScheduleRunSummaryV1 {
        run_id: row.try_get("run_id").map_err(read_error)?,
        task_id: row.try_get("task_id").map_err(read_error)?,
        dispatch_id: row.try_get("dispatch_id").map_err(read_error)?,
        generation: u64::try_from(generation)
            .map_err(|_| storage("corrupt_schedule_run", "invalid generation"))?,
        workspace_id: row.try_get("workspace_id").map_err(read_error)?,
        completed,
        blocked_by: row.try_get("blocked_by").map_err(read_error)?,
    };
    Ok(Some((
        summary,
        row.try_get("completion_result").map_err(read_error)?,
    )))
}
