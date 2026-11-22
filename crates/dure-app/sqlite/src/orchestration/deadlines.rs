use super::*;

/// Rediscover due work from SQLite on every tick, including after a restart.
/// There is no client-owned timer, in-memory scheduling queue, or PTY effect.
pub(crate) async fn expire(
    store: &WorkflowInteractionStore,
    now_ms: i64,
) -> Result<usize, StoreError> {
    if now_ms < 0 {
        return Err(StoreError::StateConflict {
            code: "clock_invalid",
        });
    }
    let rows = sqlx::query(
        "SELECT DISTINCT authority.workspace_id, authority.tenant_ref
         FROM workflow_interaction_authorities AS authority
         JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = authority.dispatch_id
         WHERE dispatch.state != 'completed'
           AND json_extract(authority.deadline_json, '$.dueAtMs') <= ?1
           AND json_extract(authority.deadline_json, '$.overdueEventCursor') IS NULL",
    )
    .bind(now_ms)
    .fetch_all(&store.pool)
    .await
    .map_err(|_| unavailable())?;
    let mut count = 0;
    let mut failure = None;
    for row in rows {
        let authority = AuthorityScope {
            workspace_id: WorkspaceId::new(
                row.try_get::<String, _>("workspace_id")
                    .map_err(|_| corrupt())?,
            )
            .map_err(|_| corrupt())?,
            tenant_ref: row
                .try_get::<Option<String>, _>("tenant_ref")
                .map_err(|_| corrupt())?
                .map(TenantRef::new)
                .transpose()
                .map_err(|_| corrupt())?,
        };
        match store
            .transact(&authority, |state| {
                let changed = state.expire_dispatch_deadlines(now_ms)?;
                Ok((changed, changed > 0))
            })
            .await
        {
            Ok(changed) => count += changed,
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    failure.map_or(Ok(count), Err)
}
