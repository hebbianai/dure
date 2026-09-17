use dure_app::{
    AgentIdV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseAdvanceRequestV1,
    AgentRuntimeCloseIntentV1, AgentRuntimeCloseRecordV1, AgentRuntimeCloseStateV1,
    AgentRuntimeCloseStore, AgentRuntimeSelectionV1, AgentRuntimeTransitionRecordV1,
    AgentRuntimeTransitionStateV1, DomainStoreErrorV1, DomainStoreFuture, OperationIdV1,
    advance_agent_runtime_close_v1,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::agent_runtime_transition::{
    active_transition_on, require_current_runtime_authority_on, selection_on,
};
use crate::error::{corrupt_row, identity_conflict, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

impl AgentRuntimeCloseStore for crate::SqliteDomainStore {
    fn admit_agent_runtime_close<'a>(
        &'a self,
        intent: &'a AgentRuntimeCloseIntentV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeCloseRecordV1> {
        Box::pin(admit(&self.pool, intent))
    }

    fn advance_agent_runtime_close<'a>(
        &'a self,
        request: &'a AgentRuntimeCloseAdvanceRequestV1,
    ) -> DomainStoreFuture<'a, AgentRuntimeCloseRecordV1> {
        Box::pin(advance(&self.pool, request))
    }

    fn agent_runtime_close<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeCloseRecordV1>> {
        Box::pin(close(&self.pool, operation_id))
    }

    fn effective_agent_runtime_close<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRuntimeCloseRecordV1>> {
        Box::pin(effective_close_for_agent(&self.pool, agent_id))
    }

    fn agent_runtime_transition_follows_close<'a>(
        &'a self,
        transition_operation_id: &'a OperationIdV1,
        close_operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, bool> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| map_sqlx("read_agent_runtime_close_lineage", error))?;
            transition_follows_close_on(
                &mut connection,
                transition_operation_id,
                close_operation_id,
            )
            .await
        })
    }
}

async fn transition_follows_close_on(
    connection: &mut SqliteConnection,
    transition_operation_id: &OperationIdV1,
    close_operation_id: &OperationIdV1,
) -> Result<bool, DomainStoreErrorV1> {
    sqlx::query_scalar(
        r#"
        WITH RECURSIVE predecessors(operation_id) AS (
            SELECT json_extract(record_json, '$.predecessorOperationId')
            FROM agent_runtime_transitions WHERE operation_id = ?1
            UNION
            SELECT json_extract(transition.record_json, '$.predecessorOperationId')
            FROM agent_runtime_transitions AS transition
            JOIN predecessors ON transition.operation_id = predecessors.operation_id
        )
        SELECT EXISTS (SELECT 1 FROM predecessors WHERE operation_id = ?2)
        "#,
    )
    .bind(transition_operation_id.as_str())
    .bind(close_operation_id.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_close_lineage", error))
}

pub(crate) async fn admit(
    pool: &SqlitePool,
    intent: &AgentRuntimeCloseIntentV1,
) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("admit_agent_runtime_close", error))?;
    begin_immediate(&mut connection, "admit_agent_runtime_close").await?;
    let result = admit_on(&mut connection, intent).await;
    finish_transaction(&mut connection, "admit_agent_runtime_close", result).await
}

/// Admits or exactly replays one close inside the caller's transaction.
/// The caller owns commit or rollback; this function owns every close-specific
/// identity and runtime-authority check.
pub(crate) async fn admit_on(
    connection: &mut SqliteConnection,
    intent: &AgentRuntimeCloseIntentV1,
) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
    let admitted = AgentRuntimeCloseRecordV1::admitted(intent.clone())?;
    admit_validated_on(connection, admitted).await
}

async fn admit_validated_on(
    connection: &mut SqliteConnection,
    admitted: AgentRuntimeCloseRecordV1,
) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
    let intent = &admitted.intent;
    let by_operation = close_on(connection, &intent.operation_id).await?;
    let by_key = close_by_key_on(connection, &intent.idempotency_key).await?;
    if by_operation.is_some() || by_key.is_some() {
        return replay_admission(intent, by_operation, by_key);
    }
    if let Some(active) = effective_close_for_agent_on(connection, &intent.source.agent_id).await? {
        return Err(identity_conflict(
            "agent runtime close",
            intent.source.agent_id.as_str(),
            format!("operation {} is already active", active.intent.operation_id),
        ));
    }
    let active_transition = active_transition_on(connection, &intent.source.agent_id).await?;
    if selection_on(connection, &intent.source.agent_id)
        .await?
        .as_ref()
        != Some(&intent.source)
    {
        return Err(identity_conflict(
            "agent runtime selection",
            intent.source.agent_id.as_str(),
            "the runtime close source is not the active selection",
        ));
    }
    match (&intent.stopped_transition, active_transition.as_ref()) {
        (None, None) => {
            require_current_runtime_authority_on(
                connection,
                &intent.source.agent_id,
                &intent.source_authority,
            )
            .await?;
        }
        (Some(stopped), Some(transition))
            if (transition.state == AgentRuntimeTransitionStateV1::RepairRequired
                || transition.is_dormant())
                && transition.intent.operation_id == stopped.operation_id
                && transition.journal_revision == stopped.journal_revision
                && transition.intent.source == intent.source
                && transition.intent.source_authority == intent.source_authority => {}
        _ => {
            return Err(identity_conflict(
                "agent runtime close",
                intent.source.agent_id.as_str(),
                "the stopped transition close authority is not current",
            ));
        }
    }
    insert(connection, &admitted).await?;
    Ok(admitted)
}

pub(crate) async fn advance(
    pool: &SqlitePool,
    request: &AgentRuntimeCloseAdvanceRequestV1,
) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("advance_agent_runtime_close", error))?;
    begin_immediate(&mut connection, "advance_agent_runtime_close").await?;
    let result = async {
        let current = close_on(&mut connection, &request.operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent runtime close",
                id: request.operation_id.as_str().into(),
            })?;
        let next = advance_agent_runtime_close_v1(&current, request)?;
        if next == current {
            return Ok(current);
        }
        update(&mut connection, &current, &next).await?;
        Ok(next)
    }
    .await;
    finish_transaction(&mut connection, "advance_agent_runtime_close", result).await
}

pub(crate) async fn close(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentRuntimeCloseRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_runtime_close", error))?;
    close_on(&mut connection, operation_id).await
}

pub(crate) async fn effective_close_for_agent(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeCloseRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_runtime_close", error))?;
    effective_close_for_agent_on(&mut connection, agent_id).await
}

pub(crate) async fn effective_close_for_agent_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeCloseRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT operation_id, idempotency_key, agent_id, state,
               journal_revision, record_json, created_at_ms, updated_at_ms
        FROM agent_runtime_closes
        WHERE agent_id = ?1
          AND state != 'source_retained'
          AND CAST(json_extract(record_json, '$.intent.source.revision') AS INTEGER) = (
              SELECT revision
              FROM agent_runtime_selections
              WHERE agent_id = ?1
          )
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_close", error))?;
    row.map(from_row).transpose()
}

pub(crate) async fn ensure_open_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<(), DomainStoreErrorV1> {
    if !is_open_on(connection, agent_id).await? {
        return Err(identity_conflict(
            "agent runtime close",
            agent_id.as_str(),
            "the Agent runtime is closed",
        ));
    }
    Ok(())
}

/// A close fences older work, not the successor chain it explicitly admitted.
/// Repair and supersede keep the original source until a target commits.
pub(crate) async fn ensure_transition_source_on(
    connection: &mut SqliteConnection,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let Some(close) =
        effective_close_for_agent_on(connection, &transition.intent.source.agent_id).await?
    else {
        return Ok(());
    };
    if !transition_follows_close_on(
        connection,
        &transition.intent.operation_id,
        &close.intent.operation_id,
    )
    .await?
    {
        return Err(identity_conflict(
            "agent runtime close",
            transition.intent.source.agent_id.as_str(),
            "the Agent runtime is closed",
        ));
    }
    ensure_stopped_source_on(
        connection,
        &close,
        &transition.intent.source,
        &transition.intent.source_authority,
        &transition.intent.operation_id,
        transition.intent.requested_at_ms,
    )
    .await
}

/// Binding publication belongs to the admitted target effect, while ordinary
/// input remains fenced until that target commits its selection.
pub(crate) async fn ensure_runtime_binding_write_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<(), DomainStoreErrorV1> {
    match crate::agent_runtime_transition::ensure_target_activation_on(connection, agent_id).await?
    {
        Some(transition) if transition.state == AgentRuntimeTransitionStateV1::SourceStopped => {
            ensure_transition_source_on(connection, &transition).await
        }
        _ => ensure_open_on(connection, agent_id).await,
    }
}

/// Allows an explicit successor to replace a terminal close of its exact
/// source generation. A close admitted by Agent removal remains a
/// destructive fence; its parent Dispatch must be resolved through that
/// workflow instead of being bypassed by a delayed Resume, Rehost, or profile
/// transition.
pub(crate) async fn ensure_runtime_successor_source_on(
    connection: &mut SqliteConnection,
    source: &AgentRuntimeSelectionV1,
    source_authority: &AgentRuntimeBindingAuthorityV1,
    successor_operation_id: &OperationIdV1,
    successor_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    let Some(close) = effective_close_for_agent_on(connection, &source.agent_id).await? else {
        return Ok(());
    };
    ensure_stopped_source_on(
        connection,
        &close,
        source,
        source_authority,
        successor_operation_id,
        successor_at_ms,
    )
    .await
}

async fn ensure_stopped_source_on(
    connection: &mut SqliteConnection,
    close: &AgentRuntimeCloseRecordV1,
    source: &AgentRuntimeSelectionV1,
    source_authority: &AgentRuntimeBindingAuthorityV1,
    successor_operation_id: &OperationIdV1,
    successor_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    let exact_source =
        close.intent.source == *source && close.intent.source_authority == *source_authority;
    if close.state != AgentRuntimeCloseStateV1::Stopped
        || !exact_source
        || close.intent.operation_id == *successor_operation_id
        || successor_at_ms < close.updated_at_ms
    {
        return Err(identity_conflict(
            "agent runtime close",
            source.agent_id.as_str(),
            "successor does not supersede the effective runtime close",
        ));
    }
    let dispatch_owned = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM agent_dispatch_stops
            WHERE runtime_close_operation_id = ?1
        ) OR EXISTS (
            SELECT 1 FROM agent_runtime_closes
            WHERE operation_id = ?1 AND removal_json IS NOT NULL
        )
        "#,
    )
    .bind(close.intent.operation_id.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("authorize_agent_runtime_successor", error))?;
    if dispatch_owned != 0 {
        return Err(identity_conflict(
            "agent runtime close",
            source.agent_id.as_str(),
            "Agent removal owns the effective runtime close",
        ));
    }
    Ok(())
}

pub(crate) async fn is_open_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<bool, DomainStoreErrorV1> {
    Ok(effective_close_for_agent_on(connection, agent_id)
        .await?
        .is_none())
}

fn replay_admission(
    intent: &AgentRuntimeCloseIntentV1,
    by_operation: Option<AgentRuntimeCloseRecordV1>,
    by_key: Option<AgentRuntimeCloseRecordV1>,
) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
    let records = [by_operation, by_key]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if let Some(first) = records.first()
        && records.iter().all(|record| record == first)
        && first.intent == *intent
    {
        return Ok(first.clone());
    }
    Err(DomainStoreErrorV1::IdempotencyConflict {
        reason: format!(
            "runtime close operation {} or key {:?} has a different intent",
            intent.operation_id, intent.idempotency_key
        ),
    })
}

async fn insert(
    connection: &mut SqliteConnection,
    record: &AgentRuntimeCloseRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let record_json = serde_json::to_string(record)
        .map_err(|error| serialization("agent runtime close", error))?;
    sqlx::query(
        r#"
        INSERT INTO agent_runtime_closes (
            operation_id, idempotency_key, agent_id, state,
            journal_revision, record_json, created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
    )
    .bind(record.intent.operation_id.as_str())
    .bind(&record.intent.idempotency_key)
    .bind(record.intent.source.agent_id.as_str())
    .bind(record.state.as_str())
    .bind(record.journal_revision)
    .bind(record_json)
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("admit_agent_runtime_close", error))?;
    Ok(())
}

async fn update(
    connection: &mut SqliteConnection,
    current: &AgentRuntimeCloseRecordV1,
    next: &AgentRuntimeCloseRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let record_json =
        serde_json::to_string(next).map_err(|error| serialization("agent runtime close", error))?;
    let result = sqlx::query(
        r#"
        UPDATE agent_runtime_closes SET
            state = ?2,
            journal_revision = ?3,
            record_json = ?4,
            updated_at_ms = ?5
        WHERE operation_id = ?1 AND journal_revision = ?6
        "#,
    )
    .bind(next.intent.operation_id.as_str())
    .bind(next.state.as_str())
    .bind(next.journal_revision)
    .bind(record_json)
    .bind(next.updated_at_ms)
    .bind(current.journal_revision)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("advance_agent_runtime_close", error))?;
    if result.rows_affected() != 1 {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.intent.source.agent_id.as_str().into(),
            expected_revision: current.journal_revision,
            actual_revision: None,
        });
    }
    Ok(())
}

pub(crate) async fn close_on(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentRuntimeCloseRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT operation_id, idempotency_key, agent_id, state,
               journal_revision, record_json, created_at_ms, updated_at_ms
        FROM agent_runtime_closes
        WHERE operation_id = ?1
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_close", error))?;
    row.map(from_row).transpose()
}

async fn close_by_key_on(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<AgentRuntimeCloseRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT operation_id, idempotency_key, agent_id, state,
               journal_revision, record_json, created_at_ms, updated_at_ms
        FROM agent_runtime_closes
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_close", error))?;
    row.map(from_row).transpose()
}

fn from_row(row: SqliteRow) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
    let record_json: String = row
        .try_get("record_json")
        .map_err(|error| corrupt_row("agent_runtime_closes", error))?;
    let record: AgentRuntimeCloseRecordV1 = serde_json::from_str(&record_json)
        .map_err(|error| serialization("agent runtime close", error))?;
    record.validate()?;
    let stored = (
        row.try_get::<String, _>("operation_id")
            .map_err(|error| corrupt_row("agent_runtime_closes", error))?,
        row.try_get::<String, _>("idempotency_key")
            .map_err(|error| corrupt_row("agent_runtime_closes", error))?,
        row.try_get::<String, _>("agent_id")
            .map_err(|error| corrupt_row("agent_runtime_closes", error))?,
        row.try_get::<String, _>("state")
            .map_err(|error| corrupt_row("agent_runtime_closes", error))?,
        row.try_get::<i64, _>("journal_revision")
            .map_err(|error| corrupt_row("agent_runtime_closes", error))?,
        row.try_get::<i64, _>("created_at_ms")
            .map_err(|error| corrupt_row("agent_runtime_closes", error))?,
        row.try_get::<i64, _>("updated_at_ms")
            .map_err(|error| corrupt_row("agent_runtime_closes", error))?,
    );
    let projected = (
        record.intent.operation_id.as_str().to_owned(),
        record.intent.idempotency_key.clone(),
        record.intent.source.agent_id.as_str().to_owned(),
        record.state.as_str().to_owned(),
        record.journal_revision,
        record.created_at_ms,
        record.updated_at_ms,
    );
    if stored != projected {
        return Err(storage(
            "corrupt_agent_runtime_close",
            "runtime close columns do not match record_json",
        ));
    }
    Ok(record)
}
