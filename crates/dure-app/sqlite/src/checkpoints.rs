use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointIdentityV1, AgentCheckpointRecordV1,
    AgentCheckpointWriteReceiptV1, AgentCheckpointWriteRequestV1, AgentIdV1, DomainStoreErrorV1,
};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, storage};
use crate::records::session_binding_on;
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn checkpoint(
    pool: &SqlitePool,
    identity: &AgentCheckpointIdentityV1,
) -> Result<Option<AgentCheckpointRecordV1>, DomainStoreErrorV1> {
    identity.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_checkpoint", error))?;
    sqlx::query("BEGIN")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_agent_checkpoint", error))?;

    let result = async {
        validate_exact_binding(&mut connection, identity).await?;
        checkpoint_on(&mut connection, &identity.agent_id).await
    }
    .await;

    finish_transaction(&mut connection, "read_agent_checkpoint", result).await
}

pub(crate) async fn write_checkpoint(
    pool: &SqlitePool,
    request: &AgentCheckpointWriteRequestV1,
) -> Result<AgentCheckpointWriteReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("write_agent_checkpoint", error))?;
    begin_immediate(&mut connection, "write_agent_checkpoint").await?;

    let result = async {
        if let Some(receipt) = receipt_for_request(&mut connection, request).await? {
            return Ok(receipt);
        }

        validate_exact_binding(&mut connection, &request.identity).await?;
        let current = checkpoint_on(&mut connection, &request.identity.agent_id).await?;
        let actual_revision = current.as_ref().map(|record| record.revision);
        if request.expected_revision != actual_revision.unwrap_or(0) {
            return Err(DomainStoreErrorV1::RevisionConflict {
                agent_id: request.identity.agent_id.to_string(),
                expected_revision: request.expected_revision,
                actual_revision,
            });
        }
        let revision = actual_revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| storage("revision_exhausted", "Agent checkpoint revision overflow"))?;
        let now = now_ms()?;
        let updated_at_ms = current
            .as_ref()
            .map_or(now, |record| now.max(record.updated_at_ms));
        let record = AgentCheckpointRecordV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            agent_id: request.identity.agent_id.clone(),
            checkpoint: request.checkpoint.clone(),
            revision,
            updated_by_session_id: request.identity.session_id.clone(),
            updated_by_binding_generation: request.identity.binding_generation,
            updated_at_ms,
        };
        record.validate()?;

        sqlx::query(
            r#"
            INSERT INTO agent_checkpoints (
                agent_id,
                schema_version,
                checkpoint_text,
                revision,
                updated_by_session_id,
                updated_by_binding_generation,
                updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(agent_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                checkpoint_text = excluded.checkpoint_text,
                revision = excluded.revision,
                updated_by_session_id = excluded.updated_by_session_id,
                updated_by_binding_generation = excluded.updated_by_binding_generation,
                updated_at_ms = excluded.updated_at_ms
            "#,
        )
        .bind(request.identity.agent_id.as_str())
        .bind(i64::from(record.schema_version))
        .bind(&record.checkpoint)
        .bind(record.revision)
        .bind(&record.updated_by_session_id)
        .bind(record.updated_by_binding_generation)
        .bind(record.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("write_agent_checkpoint", error))?;

        sqlx::query(
            r#"
            INSERT INTO agent_checkpoint_receipts (
                idempotency_key,
                schema_version,
                agent_id,
                session_id,
                binding_generation,
                expected_revision,
                checkpoint_text,
                result_revision,
                result_updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
        )
        .bind(&request.idempotency_key)
        .bind(i64::from(request.schema_version))
        .bind(request.identity.agent_id.as_str())
        .bind(&request.identity.session_id)
        .bind(request.identity.binding_generation)
        .bind(request.expected_revision)
        .bind(&request.checkpoint)
        .bind(record.revision)
        .bind(record.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("write_agent_checkpoint_receipt", error))?;

        Ok(AgentCheckpointWriteReceiptV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            idempotency_key: request.idempotency_key.clone(),
            record,
        })
    }
    .await;

    finish_transaction(&mut connection, "write_agent_checkpoint", result).await
}

async fn validate_exact_binding(
    connection: &mut SqliteConnection,
    identity: &AgentCheckpointIdentityV1,
) -> Result<(), DomainStoreErrorV1> {
    let Some(binding) = session_binding_on(connection, &identity.agent_id).await? else {
        return Err(DomainStoreErrorV1::NotFound {
            entity: "session_binding",
            id: identity.agent_id.to_string(),
        });
    };
    if binding.session_id != identity.session_id
        || binding.binding_generation != identity.binding_generation
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent_checkpoint_binding",
            id: identity.agent_id.to_string(),
            reason: "sessionId and bindingGeneration must match the durable Agent binding".into(),
        });
    }
    Ok(())
}

async fn checkpoint_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentCheckpointRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            agent_id,
            schema_version,
            checkpoint_text,
            revision,
            updated_by_session_id,
            updated_by_binding_generation,
            updated_at_ms
        FROM agent_checkpoints
        WHERE agent_id = ?1
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_checkpoint", error))?;
    row.map(checkpoint_from_row).transpose()
}

fn checkpoint_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<AgentCheckpointRecordV1, DomainStoreErrorV1> {
    let agent_id = row
        .try_get::<String, _>("agent_id")
        .map_err(|error| corrupt_row("agent_checkpoints", error))?;
    let record = AgentCheckpointRecordV1 {
        schema_version: stored_schema_version(&row, "agent_checkpoints")?,
        agent_id: AgentIdV1::new(agent_id)
            .map_err(|error| corrupt_identifier("agent_checkpoints.agent_id", error))?,
        checkpoint: row
            .try_get("checkpoint_text")
            .map_err(|error| corrupt_row("agent_checkpoints", error))?,
        revision: row
            .try_get("revision")
            .map_err(|error| corrupt_row("agent_checkpoints", error))?,
        updated_by_session_id: row
            .try_get("updated_by_session_id")
            .map_err(|error| corrupt_row("agent_checkpoints", error))?,
        updated_by_binding_generation: row
            .try_get("updated_by_binding_generation")
            .map_err(|error| corrupt_row("agent_checkpoints", error))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("agent_checkpoints", error))?,
    };
    record
        .validate()
        .map_err(|error| storage("corrupt_agent_checkpoint", error.to_string()))?;
    Ok(record)
}

async fn receipt_for_request(
    connection: &mut SqliteConnection,
    request: &AgentCheckpointWriteRequestV1,
) -> Result<Option<AgentCheckpointWriteReceiptV1>, DomainStoreErrorV1> {
    let Some(row) = sqlx::query(
        r#"
        SELECT
            idempotency_key,
            schema_version,
            agent_id,
            session_id,
            binding_generation,
            expected_revision,
            checkpoint_text,
            result_revision,
            result_updated_at_ms
        FROM agent_checkpoint_receipts
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(&request.idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_checkpoint_receipt", error))?
    else {
        return Ok(None);
    };

    let schema_version = stored_schema_version(&row, "agent_checkpoint_receipts")?;
    let stored_agent_id = row
        .try_get::<String, _>("agent_id")
        .map_err(|error| corrupt_row("agent_checkpoint_receipts", error))?;
    let agent_id = AgentIdV1::new(&stored_agent_id)
        .map_err(|error| corrupt_identifier("agent_checkpoint_receipts.agent_id", error))?;
    let session_id: String = row
        .try_get("session_id")
        .map_err(|error| corrupt_row("agent_checkpoint_receipts", error))?;
    let binding_generation: i64 = row
        .try_get("binding_generation")
        .map_err(|error| corrupt_row("agent_checkpoint_receipts", error))?;
    let expected_revision: i64 = row
        .try_get("expected_revision")
        .map_err(|error| corrupt_row("agent_checkpoint_receipts", error))?;
    let checkpoint: String = row
        .try_get("checkpoint_text")
        .map_err(|error| corrupt_row("agent_checkpoint_receipts", error))?;

    let receipt = AgentCheckpointWriteReceiptV1 {
        schema_version,
        idempotency_key: request.idempotency_key.clone(),
        record: AgentCheckpointRecordV1 {
            schema_version,
            agent_id,
            checkpoint,
            revision: row
                .try_get("result_revision")
                .map_err(|error| corrupt_row("agent_checkpoint_receipts", error))?,
            updated_by_session_id: session_id,
            updated_by_binding_generation: binding_generation,
            updated_at_ms: row
                .try_get("result_updated_at_ms")
                .map_err(|error| corrupt_row("agent_checkpoint_receipts", error))?,
        },
    };
    receipt
        .validate()
        .map_err(|error| storage("corrupt_agent_checkpoint_receipt", error.to_string()))?;
    if receipt.schema_version != request.schema_version
        || receipt.record.agent_id != request.identity.agent_id
        || receipt.record.updated_by_session_id != request.identity.session_id
        || receipt.record.updated_by_binding_generation != request.identity.binding_generation
        || expected_revision != request.expected_revision
        || receipt.record.checkpoint != request.checkpoint
    {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "Agent checkpoint idempotency key belongs to a different request".into(),
        });
    }
    Ok(Some(receipt))
}

fn stored_schema_version(
    row: &sqlx::sqlite::SqliteRow,
    table: &'static str,
) -> Result<u16, DomainStoreErrorV1> {
    let value: i64 = row
        .try_get("schema_version")
        .map_err(|error| corrupt_row(table, error))?;
    u16::try_from(value).map_err(|error| storage("corrupt_schema_version", error.to_string()))
}

fn now_ms() -> Result<i64, DomainStoreErrorV1> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| storage("system_clock", error.to_string()))?
        .as_millis();
    i64::try_from(milliseconds).map_err(|error| storage("system_clock", error.to_string()))
}
