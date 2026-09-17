use std::collections::HashMap;

use dure_app::{
    DomainStoreErrorV1, OperationEventBodyV1, OperationEventIdV1, OperationEventV1, OperationIdV1,
    OperationReceiptStateV1, OperationReceiptV1, fold_operation_events,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn append_event(
    pool: &SqlitePool,
    event: &OperationEventV1,
) -> Result<OperationReceiptV1, DomainStoreErrorV1> {
    event.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("append_operation_event", error))?;
    begin_immediate(&mut connection, "append_operation_event").await?;

    let result = append_event_on(&mut connection, event).await;
    finish_transaction(&mut connection, "append_operation_event", result).await
}

pub(crate) async fn operation_receipt(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
) -> Result<Option<OperationReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            operation_kind,
            state,
            last_sequence,
            current_stage,
            terminal_code,
            created_at_ms,
            updated_at_ms
        FROM operation_receipts
        WHERE operation_id = ?1
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| map_sqlx("read_operation_receipt", error))?;
    row.map(receipt_from_row).transpose()
}

pub(crate) async fn rebuild_receipts(pool: &SqlitePool) -> Result<usize, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("rebuild_operation_receipts", error))?;
    begin_immediate(&mut connection, "rebuild_operation_receipts").await?;

    let result = async {
        let events = load_all_events(&mut connection).await?;
        let mut streams: Vec<Vec<OperationEventV1>> = Vec::new();
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
        let mut idempotency_owners: HashMap<String, OperationIdV1> = HashMap::new();
        for stream in streams {
            let receipt = fold_operation_events(&stream)?;
            if let Some(owner) = idempotency_owners.insert(
                receipt.idempotency_key.clone(),
                receipt.operation_id.clone(),
            ) {
                if owner != receipt.operation_id {
                    return Err(DomainStoreErrorV1::IdempotencyConflict {
                        reason: format!(
                            "key {:?} is claimed by operations {} and {}",
                            receipt.idempotency_key, owner, receipt.operation_id
                        ),
                    });
                }
            }
            receipts.push(receipt);
        }

        sqlx::query("DELETE FROM operation_receipts")
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("rebuild_operation_receipts", error))?;
        for receipt in &receipts {
            persist_receipt(&mut connection, receipt).await?;
        }
        Ok(receipts.len())
    }
    .await;

    finish_transaction(&mut connection, "rebuild_operation_receipts", result).await
}

async fn append_event_on(
    connection: &mut SqliteConnection,
    event: &OperationEventV1,
) -> Result<OperationReceiptV1, DomainStoreErrorV1> {
    if let Some(existing) = event_by_id(connection, &event.event_id).await? {
        if existing != *event {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: format!(
                    "event id {} was replayed with a different payload",
                    event.event_id
                ),
            });
        }
        if let Some(receipt) = receipt_by_operation(connection, &event.operation_id).await? {
            return Ok(receipt);
        }
        let events = events_for_operation(connection, &event.operation_id).await?;
        let receipt = fold_operation_events(&events)?;
        persist_receipt(connection, &receipt).await?;
        return Ok(receipt);
    }

    if let Some(existing) =
        event_by_operation_sequence(connection, &event.operation_id, event.sequence).await?
    {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: format!(
                "operation {} sequence {} is already owned by event {}",
                event.operation_id, event.sequence, existing.event_id
            ),
        });
    }

    if let OperationEventBodyV1::Started {
        idempotency_key, ..
    } = &event.body
    {
        if let Some(existing) = receipt_by_idempotency_key(connection, idempotency_key).await? {
            if existing.operation_id != event.operation_id {
                return Err(DomainStoreErrorV1::IdempotencyConflict {
                    reason: format!(
                        "key {idempotency_key:?} already belongs to operation {}",
                        existing.operation_id
                    ),
                });
            }
        }
    }

    let mut events = events_for_operation(connection, &event.operation_id).await?;
    events.push(event.clone());
    events.sort_by_key(|candidate| candidate.sequence);
    let receipt = fold_operation_events(&events)?;
    let body_json = serde_json::to_string(&event.body)
        .map_err(|error| serialization("operation_event", error))?;

    sqlx::query(
        r#"
        INSERT INTO operation_events (
            event_id, operation_id, sequence, body_json, created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
    )
    .bind(event.event_id.as_str())
    .bind(event.operation_id.as_str())
    .bind(event.sequence)
    .bind(body_json)
    .bind(event.created_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("append_operation_event", error))?;
    persist_receipt(connection, &receipt).await?;
    Ok(receipt)
}

async fn persist_receipt(
    connection: &mut SqliteConnection,
    receipt: &OperationReceiptV1,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        r#"
        INSERT INTO operation_receipts (
            operation_id,
            idempotency_key,
            operation_kind,
            state,
            last_sequence,
            current_stage,
            terminal_code,
            created_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(operation_id) DO UPDATE SET
            idempotency_key = excluded.idempotency_key,
            operation_kind = excluded.operation_kind,
            state = excluded.state,
            last_sequence = excluded.last_sequence,
            current_stage = excluded.current_stage,
            terminal_code = excluded.terminal_code,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms
        "#,
    )
    .bind(receipt.operation_id.as_str())
    .bind(&receipt.idempotency_key)
    .bind(&receipt.operation_kind)
    .bind(receipt.state.as_str())
    .bind(receipt.last_sequence)
    .bind(&receipt.current_stage)
    .bind(&receipt.terminal_code)
    .bind(receipt.created_at_ms)
    .bind(receipt.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("persist_operation_receipt", error))?;
    Ok(())
}

async fn receipt_by_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<OperationReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            operation_kind,
            state,
            last_sequence,
            current_stage,
            terminal_code,
            created_at_ms,
            updated_at_ms
        FROM operation_receipts
        WHERE operation_id = ?1
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_operation_receipt", error))?;
    row.map(receipt_from_row).transpose()
}

async fn receipt_by_idempotency_key(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<OperationReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            operation_kind,
            state,
            last_sequence,
            current_stage,
            terminal_code,
            created_at_ms,
            updated_at_ms
        FROM operation_receipts
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_operation_receipt", error))?;
    row.map(receipt_from_row).transpose()
}

async fn event_by_id(
    connection: &mut SqliteConnection,
    event_id: &OperationEventIdV1,
) -> Result<Option<OperationEventV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, created_at_ms
        FROM operation_events
        WHERE event_id = ?1
        "#,
    )
    .bind(event_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_operation_event", error))?;
    row.map(event_from_row).transpose()
}

async fn event_by_operation_sequence(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
    sequence: i64,
) -> Result<Option<OperationEventV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, created_at_ms
        FROM operation_events
        WHERE operation_id = ?1 AND sequence = ?2
        "#,
    )
    .bind(operation_id.as_str())
    .bind(sequence)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_operation_event", error))?;
    row.map(event_from_row).transpose()
}

async fn events_for_operation(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Vec<OperationEventV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, created_at_ms
        FROM operation_events
        WHERE operation_id = ?1
        ORDER BY sequence
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_operation_events", error))?;
    rows.into_iter().map(event_from_row).collect()
}

async fn load_all_events(
    connection: &mut SqliteConnection,
) -> Result<Vec<OperationEventV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT event_id, operation_id, sequence, body_json, created_at_ms
        FROM operation_events
        ORDER BY operation_id, sequence
        "#,
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_operation_events", error))?;
    rows.into_iter().map(event_from_row).collect()
}

fn event_from_row(row: SqliteRow) -> Result<OperationEventV1, DomainStoreErrorV1> {
    let body_json: String = row
        .try_get("body_json")
        .map_err(|error| corrupt_row("operation_events", error))?;
    let event = OperationEventV1 {
        event_id: durable_id(
            "operation_events.event_id",
            row.try_get("event_id")
                .map_err(|error| corrupt_row("operation_events", error))?,
            OperationEventIdV1::new,
        )?,
        operation_id: durable_id(
            "operation_events.operation_id",
            row.try_get("operation_id")
                .map_err(|error| corrupt_row("operation_events", error))?,
            OperationIdV1::new,
        )?,
        sequence: row
            .try_get("sequence")
            .map_err(|error| corrupt_row("operation_events", error))?,
        body: serde_json::from_str(&body_json)
            .map_err(|error| serialization("operation_event", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("operation_events", error))?,
    };
    event.validate()?;
    Ok(event)
}

fn receipt_from_row(row: SqliteRow) -> Result<OperationReceiptV1, DomainStoreErrorV1> {
    let state: String = row
        .try_get("state")
        .map_err(|error| corrupt_row("operation_receipts", error))?;
    let state = match state.as_str() {
        "running" => OperationReceiptStateV1::Running,
        "succeeded" => OperationReceiptStateV1::Succeeded,
        "failed" => OperationReceiptStateV1::Failed,
        other => {
            return Err(storage(
                "corrupt_operation_receipt",
                format!("unknown receipt state {other:?}"),
            ));
        }
    };
    Ok(OperationReceiptV1 {
        operation_id: durable_id(
            "operation_receipts.operation_id",
            row.try_get("operation_id")
                .map_err(|error| corrupt_row("operation_receipts", error))?,
            OperationIdV1::new,
        )?,
        idempotency_key: row
            .try_get("idempotency_key")
            .map_err(|error| corrupt_row("operation_receipts", error))?,
        operation_kind: row
            .try_get("operation_kind")
            .map_err(|error| corrupt_row("operation_receipts", error))?,
        state,
        last_sequence: row
            .try_get("last_sequence")
            .map_err(|error| corrupt_row("operation_receipts", error))?,
        current_stage: row
            .try_get("current_stage")
            .map_err(|error| corrupt_row("operation_receipts", error))?,
        terminal_code: row
            .try_get("terminal_code")
            .map_err(|error| corrupt_row("operation_receipts", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("operation_receipts", error))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("operation_receipts", error))?,
    })
}

fn durable_id<T, E>(
    field: &'static str,
    value: String,
    constructor: impl FnOnce(String) -> Result<T, E>,
) -> Result<T, DomainStoreErrorV1>
where
    E: std::fmt::Display,
{
    constructor(value).map_err(|error| corrupt_identifier(field, error))
}
