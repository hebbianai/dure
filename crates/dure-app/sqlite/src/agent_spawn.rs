use std::collections::HashMap;

use dure_app::{
    AgentIdV1, AgentSpawnJournalEventBodyV1, AgentSpawnJournalEventV1, AgentSpawnJournalReceiptV1,
    AgentSpawnJournalStateV1, AgentSpawnPlanIntentDraftV1, AgentSpawnPlanTokenV1, AgentSpawnPlanV1,
    DomainStoreErrorV1, OperationEventIdV1, OperationIdV1,
    create_agent_spawn_plan_from_defaults_v1, fold_agent_spawn_journal_v1,
    validate_agent_spawn_plan_intent_v1,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn append_planned_resolving_provider_defaults<F>(
    pool: &SqlitePool,
    draft: AgentSpawnPlanIntentDraftV1,
    event_id: OperationEventIdV1,
    recorded_at_ms: i64,
    admit: F,
) -> Result<AgentSpawnJournalReceiptV1, DomainStoreErrorV1>
where
    F: FnOnce(AgentSpawnPlanV1) -> Result<AgentSpawnPlanV1, DomainStoreErrorV1>,
{
    validate_agent_spawn_plan_intent_v1(&draft).map_err(|error| {
        DomainStoreErrorV1::InvalidRecord {
            field: "agentSpawnPlan",
            reason: error.to_string(),
        }
    })?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("preview_agent_spawn", error))?;
    begin_immediate(&mut connection, "preview_agent_spawn").await?;
    let result = async {
        if let Some(operation_id) =
            planned_operation_by_idempotency_key(&mut connection, &draft.request.idempotency_key)
                .await?
        {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: format!(
                    "agent spawn key {:?} already belongs to operation {operation_id}",
                    draft.request.idempotency_key
                ),
            });
        }
        let defaults = crate::provider_launch_defaults::read_on(&mut connection).await?;
        let plan = create_agent_spawn_plan_from_defaults_v1(draft, &defaults).map_err(|error| {
            DomainStoreErrorV1::InvalidRecord {
                field: "agentSpawnPlan",
                reason: error.to_string(),
            }
        })?;
        let plan = admit(plan)?;
        plan.validate()
            .map_err(|error| DomainStoreErrorV1::InvalidRecord {
                field: "agentSpawnPlan",
                reason: error.to_string(),
            })?;
        let event = AgentSpawnJournalEventV1 {
            event_id,
            operation_id: plan.operation_id.clone(),
            sequence: 1,
            plan_token: plan.plan_token.clone(),
            body: AgentSpawnJournalEventBodyV1::Planned {
                plan: Box::new(plan),
            },
            recorded_at_ms,
        };
        append_event_on(&mut connection, &event).await
    }
    .await;
    finish_transaction(&mut connection, "preview_agent_spawn", result).await
}

pub(crate) async fn append_event(
    pool: &SqlitePool,
    event: &AgentSpawnJournalEventV1,
) -> Result<AgentSpawnJournalReceiptV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("append_agent_spawn_event", error))?;
    begin_immediate(&mut connection, "append_agent_spawn_event").await?;
    let result = append_event_on(&mut connection, event).await;
    finish_transaction(&mut connection, "append_agent_spawn_event", result).await
}

/// Durable catalog page, independent of runtime discovery and client panes.
/// Validate every returned receipt against its journal in one read snapshot.
pub(crate) async fn list_receipts(
    pool: &SqlitePool,
    after: Option<&OperationIdV1>,
    selector: Option<&str>,
) -> Result<Vec<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("list_agent_spawn_receipts", error))?;
    begin_read(&mut connection, "list_agent_spawn_receipts").await?;
    let result = async {
        let ids: Vec<String> = sqlx::query_scalar(
            r#"SELECT operation_id FROM agent_spawn_receipts
               WHERE (?1 IS NULL OR operation_id > ?1)
                 AND (?2 IS NULL OR operation_id = ?2 OR json_extract(receipt_json, '$.plan.agentId') = ?2
                      OR json_extract(receipt_json, '$.plan.request.agentName') = ?2)
               ORDER BY operation_id LIMIT 65"#,
        )
        .bind(after.map(OperationIdV1::as_str))
        .bind(selector)
        .fetch_all(&mut *connection).await
        .map_err(|error| map_sqlx("list_agent_spawn_receipts", error))?;
        let mut receipts = Vec::with_capacity(ids.len());
        for id in ids {
            let id = OperationIdV1::new(id)
                .map_err(|error| corrupt_identifier("agent_spawn_receipts.operation_id", error))?;
            let receipt = validated_receipt_by_operation(&mut connection, &id).await?
                .ok_or_else(|| storage("missing_agent_spawn_receipt", "catalog receipt missing"))?;
            receipts.push(receipt);
        }
        Ok(receipts)
    }.await;
    finish_transaction(&mut connection, "list_agent_spawn_receipts", result).await
}

pub(crate) async fn receipt(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_spawn_receipt", error))?;
    begin_read(&mut connection, "read_agent_spawn_receipt").await?;
    let result = validated_receipt_by_operation(&mut connection, operation_id).await;
    finish_transaction(&mut connection, "read_agent_spawn_receipt", result).await
}

pub(crate) async fn receipt_by_idempotency_key(
    pool: &SqlitePool,
    idempotency_key: &str,
) -> Result<Option<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_spawn_receipt", error))?;
    begin_read(&mut connection, "read_agent_spawn_receipt").await?;
    let result = async {
        let event_owner = planned_operation_by_idempotency_key(&mut connection, idempotency_key)
            .await?;
        let projected = receipt_by_key(&mut connection, idempotency_key).await?;
        let operation_id = match (event_owner, projected) {
            (None, None) => return Ok(None),
            (Some(operation_id), None) => {
                return Err(storage(
                    "missing_agent_spawn_receipt",
                    format!(
                        "idempotency key {idempotency_key:?} belongs to operation {operation_id} but has no receipt"
                    ),
                ));
            }
            (None, Some(receipt)) => {
                return Err(storage(
                    "orphan_agent_spawn_receipt",
                    format!(
                        "idempotency key {idempotency_key:?} projects operation {} without a planned event",
                        receipt.operation_id
                    ),
                ));
            }
            (Some(operation_id), Some(receipt)) => {
                if receipt.operation_id != operation_id {
                    return Err(storage(
                        "stale_agent_spawn_receipt",
                        format!(
                            "idempotency key {idempotency_key:?} event and projection owners differ"
                        ),
                    ));
                }
                operation_id
            }
        };
        validated_receipt_by_operation(&mut connection, &operation_id).await
    }
    .await;
    finish_transaction(&mut connection, "read_agent_spawn_receipt", result).await
}

pub(crate) async fn receipt_by_agent_id(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_spawn_receipt", error))?;
    begin_read(&mut connection, "read_agent_spawn_receipt").await?;
    let result = async {
        let Some(operation_id) = planned_operation_by_agent_id(&mut connection, agent_id).await?
        else {
            return Ok(None);
        };
        let receipt = validated_receipt_by_operation(&mut connection, &operation_id).await?;
        if receipt
            .as_ref()
            .is_some_and(|receipt| &receipt.plan.agent_id != agent_id)
        {
            return Err(storage(
                "corrupt_agent_spawn_event",
                "agent index resolved a plan for another agent",
            ));
        }
        Ok(receipt)
    }
    .await;
    finish_transaction(&mut connection, "read_agent_spawn_receipt", result).await
}

pub(crate) async fn rebuild_receipts(pool: &SqlitePool) -> Result<usize, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("rebuild_agent_spawn_receipts", error))?;
    begin_immediate(&mut connection, "rebuild_agent_spawn_receipts").await?;
    let result = async {
        let events = load_all_events(&mut connection).await?;
        let mut streams: Vec<Vec<AgentSpawnJournalEventV1>> = Vec::new();
        for event in events {
            match streams.last_mut() {
                Some(stream)
                    if stream
                        .first()
                        .is_some_and(|first| first.operation_id == event.operation_id) =>
                {
                    stream.push(event);
                }
                _ => streams.push(vec![event]),
            }
        }

        let mut receipts = Vec::with_capacity(streams.len());
        let mut idempotency_owners = HashMap::<String, OperationIdV1>::new();
        let mut agent_owners = HashMap::<String, OperationIdV1>::new();
        for stream in streams {
            let receipt = fold(&stream)?;
            let idempotency_key = receipt.plan.request.idempotency_key.clone();
            if let Some(owner) =
                idempotency_owners.insert(idempotency_key.clone(), receipt.operation_id.clone())
            {
                if owner != receipt.operation_id {
                    return Err(DomainStoreErrorV1::IdempotencyConflict {
                        reason: format!(
                            "agent spawn key {idempotency_key:?} is claimed by operations {owner} and {}",
                            receipt.operation_id
                        ),
                    });
                }
            }
            let agent_id = receipt.plan.agent_id.as_str().to_owned();
            if let Some(owner) = agent_owners.insert(agent_id.clone(), receipt.operation_id.clone())
            {
                if owner != receipt.operation_id {
                    return Err(DomainStoreErrorV1::IdentityConflict {
                        entity: "agent_spawn_agent",
                        id: agent_id,
                        reason: format!(
                            "planned spawn is claimed by operations {owner} and {}",
                            receipt.operation_id
                        ),
                    });
                }
            }
            receipts.push(receipt);
        }

        sqlx::query("DELETE FROM agent_spawn_receipts")
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("rebuild_agent_spawn_receipts", error))?;
        for receipt in &receipts {
            persist_receipt(&mut connection, receipt).await?;
        }
        Ok(receipts.len())
    }
    .await;
    finish_transaction(&mut connection, "rebuild_agent_spawn_receipts", result).await
}

async fn begin_read(
    connection: &mut SqliteConnection,
    operation: &'static str,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx(operation, error))?;
    Ok(())
}

async fn append_event_on(
    connection: &mut SqliteConnection,
    event: &AgentSpawnJournalEventV1,
) -> Result<AgentSpawnJournalReceiptV1, DomainStoreErrorV1> {
    if let Some(existing) = event_by_id(connection, &event.event_id).await? {
        if existing != *event {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: format!(
                    "agent spawn event id {} was replayed with a different payload",
                    event.event_id
                ),
            });
        }
        let events = events_for_operation(connection, &event.operation_id).await?;
        let receipt = fold(&events)?;
        persist_receipt(connection, &receipt).await?;
        return Ok(receipt);
    }

    if let Some(existing) =
        event_by_operation_sequence(connection, &event.operation_id, event.sequence).await?
    {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: format!(
                "agent spawn operation {} sequence {} is already owned by event {}",
                event.operation_id, event.sequence, existing.event_id
            ),
        });
    }

    let idempotency_key = planned_idempotency_key(event);
    if let Some(idempotency_key) = idempotency_key {
        if let Some(owner) =
            planned_operation_by_idempotency_key(connection, idempotency_key).await?
        {
            if owner != event.operation_id {
                return Err(DomainStoreErrorV1::IdempotencyConflict {
                    reason: format!(
                        "agent spawn key {idempotency_key:?} already belongs to operation {owner}"
                    ),
                });
            }
        }
    }

    let agent_id = planned_agent_id(event);
    if let Some(agent_id) = agent_id {
        if let Some(owner) = planned_operation_by_agent_id(connection, agent_id).await? {
            if owner != event.operation_id {
                return Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "agent_spawn_agent",
                    id: agent_id.as_str().into(),
                    reason: format!("planned spawn already belongs to operation {owner}"),
                });
            }
        }
    }

    let mut events = events_for_operation(connection, &event.operation_id).await?;
    events.push(event.clone());
    events.sort_by_key(|candidate| candidate.sequence);
    let receipt = fold(&events)?;
    let body_json = serde_json::to_string(&event.body)
        .map_err(|error| serialization("agent_spawn_event", error))?;

    sqlx::query(
        r#"
        INSERT INTO agent_spawn_events (
            event_id,
            operation_id,
            sequence,
            plan_token,
            idempotency_key,
            agent_id,
            body_json,
            recorded_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
    )
    .bind(event.event_id.as_str())
    .bind(event.operation_id.as_str())
    .bind(i64::from(event.sequence))
    .bind(event.plan_token.as_str())
    .bind(idempotency_key)
    .bind(agent_id.map(AgentIdV1::as_str))
    .bind(body_json)
    .bind(event.recorded_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("append_agent_spawn_event", error))?;
    persist_receipt(connection, &receipt).await?;
    Ok(receipt)
}

fn planned_idempotency_key(event: &AgentSpawnJournalEventV1) -> Option<&str> {
    match &event.body {
        AgentSpawnJournalEventBodyV1::Planned { plan } => {
            Some(plan.request.idempotency_key.as_str())
        }
        _ => None,
    }
}

fn planned_agent_id(event: &AgentSpawnJournalEventV1) -> Option<&AgentIdV1> {
    match &event.body {
        AgentSpawnJournalEventBodyV1::Planned { plan } => Some(&plan.agent_id),
        _ => None,
    }
}

async fn persist_receipt(
    connection: &mut SqliteConnection,
    receipt: &AgentSpawnJournalReceiptV1,
) -> Result<(), DomainStoreErrorV1> {
    let receipt_json = serde_json::to_string(receipt)
        .map_err(|error| serialization("agent_spawn_receipt", error))?;
    sqlx::query(
        r#"
        INSERT INTO agent_spawn_receipts (
            operation_id,
            idempotency_key,
            plan_token,
            state,
            last_sequence,
            receipt_json,
            created_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(operation_id) DO UPDATE SET
            idempotency_key = excluded.idempotency_key,
            plan_token = excluded.plan_token,
            state = excluded.state,
            last_sequence = excluded.last_sequence,
            receipt_json = excluded.receipt_json,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms
        "#,
    )
    .bind(receipt.operation_id.as_str())
    .bind(&receipt.plan.request.idempotency_key)
    .bind(receipt.plan.plan_token.as_str())
    .bind(state_name(&receipt.state))
    .bind(i64::from(receipt.last_sequence))
    .bind(receipt_json)
    .bind(receipt.created_at_ms)
    .bind(receipt.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("persist_agent_spawn_receipt", error))?;
    Ok(())
}

pub(crate) async fn validated_receipt_by_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    let events = events_for_operation(connection, operation_id).await?;
    if events.is_empty() {
        if receipt_by_operation(connection, operation_id)
            .await?
            .is_some()
        {
            return Err(storage(
                "orphan_agent_spawn_receipt",
                format!("operation {operation_id} has a receipt but no events"),
            ));
        }
        return Ok(None);
    }
    let folded = fold(&events)?;
    let stored = receipt_by_operation(connection, operation_id)
        .await?
        .ok_or_else(|| {
            storage(
                "missing_agent_spawn_receipt",
                format!("operation {operation_id} has events but no receipt"),
            )
        })?;
    if stored != folded {
        return Err(storage(
            "stale_agent_spawn_receipt",
            format!("operation {operation_id} projection differs from its event stream"),
        ));
    }
    Ok(Some(stored))
}

async fn receipt_by_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    receipt_row(
        sqlx::query(
            r#"
            SELECT
                operation_id,
                idempotency_key,
                plan_token,
                state,
                last_sequence,
                receipt_json,
                created_at_ms,
                updated_at_ms
            FROM agent_spawn_receipts
            WHERE operation_id = ?1
            "#,
        )
        .bind(operation_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_agent_spawn_receipt", error))?,
    )
}

async fn receipt_by_key(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    receipt_row(
        sqlx::query(
            r#"
            SELECT
                operation_id,
                idempotency_key,
                plan_token,
                state,
                last_sequence,
                receipt_json,
                created_at_ms,
                updated_at_ms
            FROM agent_spawn_receipts
            WHERE idempotency_key = ?1
            "#,
        )
        .bind(idempotency_key)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_agent_spawn_receipt", error))?,
    )
}

fn receipt_row(
    row: Option<SqliteRow>,
) -> Result<Option<AgentSpawnJournalReceiptV1>, DomainStoreErrorV1> {
    row.map(receipt_from_row).transpose()
}

async fn planned_operation_by_idempotency_key(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<OperationIdV1>, DomainStoreErrorV1> {
    let operation_id: Option<String> = sqlx::query_scalar(
        "SELECT operation_id FROM agent_spawn_events WHERE idempotency_key = ?1",
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_spawn_event", error))?;
    operation_id
        .map(|value| {
            OperationIdV1::new(value)
                .map_err(|error| corrupt_identifier("agent_spawn_events.operation_id", error))
        })
        .transpose()
}

async fn planned_operation_by_agent_id(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<OperationIdV1>, DomainStoreErrorV1> {
    let operation_id: Option<String> =
        sqlx::query_scalar("SELECT operation_id FROM agent_spawn_events WHERE agent_id = ?1")
            .bind(agent_id.as_str())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| map_sqlx("read_agent_spawn_event", error))?;
    operation_id
        .map(|value| {
            OperationIdV1::new(value)
                .map_err(|error| corrupt_identifier("agent_spawn_events.operation_id", error))
        })
        .transpose()
}

async fn event_by_id(
    connection: &mut SqliteConnection,
    event_id: &OperationEventIdV1,
) -> Result<Option<AgentSpawnJournalEventV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            event_id,
            operation_id,
            sequence,
            plan_token,
            idempotency_key,
            agent_id,
            body_json,
            recorded_at_ms
        FROM agent_spawn_events
        WHERE event_id = ?1
        "#,
    )
    .bind(event_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_spawn_event", error))?;
    row.map(event_from_row).transpose()
}

async fn event_by_operation_sequence(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
    sequence: u32,
) -> Result<Option<AgentSpawnJournalEventV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            event_id,
            operation_id,
            sequence,
            plan_token,
            idempotency_key,
            agent_id,
            body_json,
            recorded_at_ms
        FROM agent_spawn_events
        WHERE operation_id = ?1 AND sequence = ?2
        "#,
    )
    .bind(operation_id.as_str())
    .bind(i64::from(sequence))
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_spawn_event", error))?;
    row.map(event_from_row).transpose()
}

async fn events_for_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Vec<AgentSpawnJournalEventV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT
            event_id,
            operation_id,
            sequence,
            plan_token,
            idempotency_key,
            agent_id,
            body_json,
            recorded_at_ms
        FROM agent_spawn_events
        WHERE operation_id = ?1
        ORDER BY sequence
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_spawn_events", error))?;
    rows.into_iter().map(event_from_row).collect()
}

async fn load_all_events(
    connection: &mut SqliteConnection,
) -> Result<Vec<AgentSpawnJournalEventV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT
            event_id,
            operation_id,
            sequence,
            plan_token,
            idempotency_key,
            agent_id,
            body_json,
            recorded_at_ms
        FROM agent_spawn_events
        ORDER BY operation_id, sequence
        "#,
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_spawn_events", error))?;
    rows.into_iter().map(event_from_row).collect()
}

fn event_from_row(row: SqliteRow) -> Result<AgentSpawnJournalEventV1, DomainStoreErrorV1> {
    let sequence: i64 = row
        .try_get("sequence")
        .map_err(|error| corrupt_row("agent_spawn_events", error))?;
    let sequence = u32::try_from(sequence)
        .map_err(|_| storage("corrupt_agent_spawn_event", "event sequence is outside u32"))?;
    let body_json: String = row
        .try_get("body_json")
        .map_err(|error| corrupt_row("agent_spawn_events", error))?;
    let body: AgentSpawnJournalEventBodyV1 = serde_json::from_str(&body_json)
        .map_err(|error| serialization("agent_spawn_event", error))?;
    let stored_idempotency_key: Option<String> = row
        .try_get("idempotency_key")
        .map_err(|error| corrupt_row("agent_spawn_events", error))?;
    let expected_idempotency_key = match &body {
        AgentSpawnJournalEventBodyV1::Planned { plan } if sequence == 1 => {
            Some(plan.request.idempotency_key.as_str())
        }
        _ => None,
    };
    if stored_idempotency_key.as_deref() != expected_idempotency_key {
        return Err(storage(
            "corrupt_agent_spawn_event",
            "idempotency index differs from the planned event body",
        ));
    }
    let stored_agent_id: Option<String> = row
        .try_get("agent_id")
        .map_err(|error| corrupt_row("agent_spawn_events", error))?;
    let expected_agent_id = match &body {
        AgentSpawnJournalEventBodyV1::Planned { plan } if sequence == 1 => {
            Some(plan.agent_id.as_str())
        }
        _ => None,
    };
    if stored_agent_id.as_deref() != expected_agent_id {
        return Err(storage(
            "corrupt_agent_spawn_event",
            "agent index differs from the planned event body",
        ));
    }
    Ok(AgentSpawnJournalEventV1 {
        event_id: OperationEventIdV1::new(
            row.try_get::<String, _>("event_id")
                .map_err(|error| corrupt_row("agent_spawn_events", error))?,
        )
        .map_err(|error| corrupt_identifier("agent_spawn_events.event_id", error))?,
        operation_id: OperationIdV1::new(
            row.try_get::<String, _>("operation_id")
                .map_err(|error| corrupt_row("agent_spawn_events", error))?,
        )
        .map_err(|error| corrupt_identifier("agent_spawn_events.operation_id", error))?,
        sequence,
        plan_token: AgentSpawnPlanTokenV1::new(
            row.try_get::<String, _>("plan_token")
                .map_err(|error| corrupt_row("agent_spawn_events", error))?,
        )
        .map_err(|error| corrupt_identifier("agent_spawn_events.plan_token", error))?,
        body,
        recorded_at_ms: row
            .try_get("recorded_at_ms")
            .map_err(|error| corrupt_row("agent_spawn_events", error))?,
    })
}

fn receipt_from_row(row: SqliteRow) -> Result<AgentSpawnJournalReceiptV1, DomainStoreErrorV1> {
    let receipt_json: String = row
        .try_get("receipt_json")
        .map_err(|error| corrupt_row("agent_spawn_receipts", error))?;
    let receipt: AgentSpawnJournalReceiptV1 = serde_json::from_str(&receipt_json)
        .map_err(|error| serialization("agent_spawn_receipt", error))?;
    let stored_identity = (
        row.try_get::<String, _>("operation_id")
            .map_err(|error| corrupt_row("agent_spawn_receipts", error))?,
        row.try_get::<String, _>("idempotency_key")
            .map_err(|error| corrupt_row("agent_spawn_receipts", error))?,
        row.try_get::<String, _>("plan_token")
            .map_err(|error| corrupt_row("agent_spawn_receipts", error))?,
        row.try_get::<String, _>("state")
            .map_err(|error| corrupt_row("agent_spawn_receipts", error))?,
        row.try_get::<i64, _>("last_sequence")
            .map_err(|error| corrupt_row("agent_spawn_receipts", error))?,
        row.try_get::<i64, _>("created_at_ms")
            .map_err(|error| corrupt_row("agent_spawn_receipts", error))?,
        row.try_get::<i64, _>("updated_at_ms")
            .map_err(|error| corrupt_row("agent_spawn_receipts", error))?,
    );
    let receipt_identity = (
        receipt.operation_id.as_str().to_owned(),
        receipt.plan.request.idempotency_key.clone(),
        receipt.plan.plan_token.as_str().to_owned(),
        state_name(&receipt.state).to_owned(),
        i64::from(receipt.last_sequence),
        receipt.created_at_ms,
        receipt.updated_at_ms,
    );
    if stored_identity != receipt_identity {
        return Err(storage(
            "corrupt_agent_spawn_receipt",
            "receipt projection columns do not match receipt_json",
        ));
    }
    Ok(receipt)
}

fn state_name(state: &AgentSpawnJournalStateV1) -> &'static str {
    match state {
        AgentSpawnJournalStateV1::Applying => "applying",
        AgentSpawnJournalStateV1::ReadyToSucceed => "ready_to_succeed",
        AgentSpawnJournalStateV1::InspectBeforeRetry => "inspect_before_retry",
        AgentSpawnJournalStateV1::RetryRequired => "retry_required",
        AgentSpawnJournalStateV1::PromptDeliveryUncertain => "prompt_delivery_uncertain",
        AgentSpawnJournalStateV1::Succeeded => "succeeded",
        AgentSpawnJournalStateV1::Failed => "failed",
        AgentSpawnJournalStateV1::ManualInterventionRequired => "manual_intervention_required",
    }
}

fn fold(
    events: &[AgentSpawnJournalEventV1],
) -> Result<AgentSpawnJournalReceiptV1, DomainStoreErrorV1> {
    fold_agent_spawn_journal_v1(events).map_err(|error| DomainStoreErrorV1::InvalidEventStream {
        reason: error.to_string(),
    })
}
