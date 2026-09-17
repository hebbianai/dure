use dure_app::{
    DomainStoreErrorV1, SCHEDULE_SCHEMA_VERSION_V1, ScheduleDeleteRequestV1, ScheduleIdV1,
    SchedulePutRequestV1, ScheduleRecordV1,
};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

const MAX_SCHEDULES: usize = 128;

pub(crate) async fn put(
    pool: &SqlitePool,
    request: &SchedulePutRequestV1,
    observed_at_ms: i64,
) -> Result<ScheduleRecordV1, DomainStoreErrorV1> {
    request.validate().map_err(invalid_contract)?;
    validate_observed_at(observed_at_ms)?;
    let digest = request_digest("put", request)?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("put_schedule", error))?;
    begin_immediate(&mut connection, "put_schedule").await?;
    let result = async {
        if let Some(record) =
            mutation_receipt(&mut connection, request.idempotency_key.as_str(), &digest).await?
        {
            return Ok(record);
        }
        let current = schedule_on(&mut connection, &request.schedule_id).await?;
        let actual_revision = current.as_ref().map(|record| record.revision);
        if current
            .as_ref()
            .is_some_and(|record| record.deleted_at_ms.is_some())
        {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "schedule",
                id: request.schedule_id.to_string(),
                reason: "schedule_deleted".into(),
            });
        }
        if actual_revision.unwrap_or(0) != request.expected_revision {
            return Err(revision_conflict(
                request.schedule_id.as_str(),
                request.expected_revision,
                actual_revision,
            ));
        }
        let revision = request.expected_revision.checked_add(1).ok_or_else(|| {
            storage(
                "schedule_revision_exhausted",
                request.schedule_id.to_string(),
            )
        })?;
        let created_at_ms = current
            .as_ref()
            .map_or(observed_at_ms, |record| record.created_at_ms);
        let updated_at_ms = current.as_ref().map_or(observed_at_ms, |record| {
            observed_at_ms.max(record.updated_at_ms)
        });
        let record = ScheduleRecordV1 {
            schema_version: SCHEDULE_SCHEMA_VERSION_V1,
            schedule_id: request.schedule_id.clone(),
            revision,
            name: request.name.clone(),
            enabled: request.enabled,
            expression: request.expression.clone(),
            timezone: request.timezone.clone(),
            run_template: request.run_template.clone(),
            created_at_ms,
            updated_at_ms,
            deleted_at_ms: None,
        };
        record.validate().map_err(invalid_contract)?;
        let template_json = serde_json::to_string(&record.run_template)
            .map_err(|error| serialization("schedule run template", error))?;
        sqlx::query(
            r#"
            INSERT INTO schedules (
                schedule_id, schema_version, revision, name, enabled, expression,
                timezone, run_template_json, created_at_ms, updated_at_ms, deleted_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
            ON CONFLICT(schedule_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                revision = excluded.revision,
                name = excluded.name,
                enabled = excluded.enabled,
                expression = excluded.expression,
                timezone = excluded.timezone,
                run_template_json = excluded.run_template_json,
                updated_at_ms = excluded.updated_at_ms,
                deleted_at_ms = NULL
            "#,
        )
        .bind(record.schedule_id.as_str())
        .bind(i64::from(record.schema_version))
        .bind(to_i64("schedule revision", record.revision)?)
        .bind(&record.name)
        .bind(record.enabled)
        .bind(&record.expression)
        .bind(&record.timezone)
        .bind(template_json)
        .bind(record.created_at_ms)
        .bind(record.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("put_schedule", error))?;
        write_mutation_receipt(
            &mut connection,
            &request.idempotency_key,
            &digest,
            "put",
            &record,
            observed_at_ms,
        )
        .await?;
        Ok(record)
    }
    .await;
    finish_transaction(&mut connection, "put_schedule", result).await
}

pub(crate) async fn delete(
    pool: &SqlitePool,
    request: &ScheduleDeleteRequestV1,
    observed_at_ms: i64,
) -> Result<ScheduleRecordV1, DomainStoreErrorV1> {
    request.validate().map_err(invalid_contract)?;
    validate_observed_at(observed_at_ms)?;
    let digest = request_digest("delete", request)?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("delete_schedule", error))?;
    begin_immediate(&mut connection, "delete_schedule").await?;
    let result = async {
        if let Some(record) = mutation_receipt(&mut connection, &request.idempotency_key, &digest).await? {
            return Ok(record);
        }
        let mut record = schedule_on(&mut connection, &request.schedule_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "schedule",
                id: request.schedule_id.to_string(),
            })?;
        if record.deleted_at_ms.is_some() {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "schedule",
                id: request.schedule_id.to_string(),
                reason: "schedule_deleted".into(),
            });
        }
        if record.revision != request.expected_revision {
            return Err(revision_conflict(
                request.schedule_id.as_str(),
                request.expected_revision,
                Some(record.revision),
            ));
        }
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or_else(|| storage("schedule_revision_exhausted", request.schedule_id.to_string()))?;
        record.updated_at_ms = observed_at_ms.max(record.updated_at_ms);
        record.deleted_at_ms = Some(record.updated_at_ms);
        sqlx::query(
            "UPDATE schedules SET revision = ?2, updated_at_ms = ?3, deleted_at_ms = ?3 WHERE schedule_id = ?1",
        )
        .bind(record.schedule_id.as_str())
        .bind(to_i64("schedule revision", record.revision)?)
        .bind(record.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("delete_schedule", error))?;
        write_mutation_receipt(
            &mut connection,
            &request.idempotency_key,
            &digest,
            "delete",
            &record,
            observed_at_ms,
        )
        .await?;
        Ok(record)
    }
    .await;
    finish_transaction(&mut connection, "delete_schedule", result).await
}

pub(crate) async fn get(
    pool: &SqlitePool,
    schedule_id: &ScheduleIdV1,
) -> Result<Option<ScheduleRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_schedule", error))?;
    let record = schedule_on(&mut connection, schedule_id).await?;
    Ok(record.filter(|record| record.deleted_at_ms.is_none()))
}

pub(crate) async fn list(
    pool: &SqlitePool,
    maximum: usize,
) -> Result<(Vec<ScheduleRecordV1>, bool), DomainStoreErrorV1> {
    if !(1..=MAX_SCHEDULES).contains(&maximum) {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "maxItems",
            reason: "schedule query limit is out of bounds".into(),
        });
    }
    let limit = i64::try_from(maximum + 1)
        .map_err(|error| storage("schedule_limit_invalid", error.to_string()))?;
    let rows = sqlx::query(
        "SELECT * FROM schedules WHERE deleted_at_ms IS NULL ORDER BY schedule_id LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|error| map_sqlx("list_schedules", error))?;
    let complete = rows.len() <= maximum;
    let records = rows
        .into_iter()
        .take(maximum)
        .map(schedule_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((records, complete))
}

pub(crate) async fn schedule_on(
    connection: &mut SqliteConnection,
    schedule_id: &ScheduleIdV1,
) -> Result<Option<ScheduleRecordV1>, DomainStoreErrorV1> {
    sqlx::query("SELECT * FROM schedules WHERE schedule_id = ?1")
        .bind(schedule_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_schedule", error))?
        .map(schedule_from_row)
        .transpose()
}

pub(crate) async fn schedule_admitted_through_on(
    connection: &mut SqliteConnection,
    schedule_id: &ScheduleIdV1,
) -> Result<Option<i64>, DomainStoreErrorV1> {
    let value: Option<i64> =
        sqlx::query_scalar("SELECT admitted_through_ms FROM schedules WHERE schedule_id = ?1")
            .bind(schedule_id.as_str())
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| map_sqlx("read_schedule_admission_watermark", error))?;
    if value.is_some_and(|value| value < 0 || value % 60_000 != 0) {
        return Err(storage(
            "corrupt_schedule_admission_watermark",
            schedule_id.to_string(),
        ));
    }
    Ok(value)
}

fn schedule_from_row(row: SqliteRow) -> Result<ScheduleRecordV1, DomainStoreErrorV1> {
    let run_template_json: String = row
        .try_get("run_template_json")
        .map_err(|error| corrupt_row("schedules", error))?;
    let record = ScheduleRecordV1 {
        schema_version: to_u16(&row, "schema_version", "schedules")?,
        schedule_id: ScheduleIdV1::new(
            row.try_get::<String, _>("schedule_id")
                .map_err(|error| corrupt_row("schedules", error))?,
        )
        .map_err(|error| corrupt_identifier("schedule_id", error))?,
        revision: to_u64(&row, "revision", "schedules")?,
        name: row
            .try_get("name")
            .map_err(|error| corrupt_row("schedules", error))?,
        enabled: row
            .try_get("enabled")
            .map_err(|error| corrupt_row("schedules", error))?,
        expression: row
            .try_get("expression")
            .map_err(|error| corrupt_row("schedules", error))?,
        timezone: row
            .try_get("timezone")
            .map_err(|error| corrupt_row("schedules", error))?,
        run_template: serde_json::from_str(&run_template_json)
            .map_err(|error| serialization("schedule run template", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("schedules", error))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("schedules", error))?,
        deleted_at_ms: row
            .try_get("deleted_at_ms")
            .map_err(|error| corrupt_row("schedules", error))?,
    };
    record.validate().map_err(invalid_contract)?;
    Ok(record)
}

async fn mutation_receipt(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
    expected_digest: &str,
) -> Result<Option<ScheduleRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        "SELECT request_digest, result_json FROM schedule_mutation_receipts WHERE idempotency_key = ?1",
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_schedule_mutation_receipt", error))?;
    let Some(row) = row else { return Ok(None) };
    let digest: String = row
        .try_get("request_digest")
        .map_err(|error| corrupt_row("schedule_mutation_receipts", error))?;
    if digest != expected_digest {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "schedule mutation key was reused with different input".into(),
        });
    }
    let result_json: String = row
        .try_get("result_json")
        .map_err(|error| corrupt_row("schedule_mutation_receipts", error))?;
    let record: ScheduleRecordV1 = serde_json::from_str(&result_json)
        .map_err(|error| serialization("schedule mutation receipt", error))?;
    record.validate().map_err(invalid_contract)?;
    Ok(Some(record))
}

async fn write_mutation_receipt(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
    request_digest: &str,
    mutation_kind: &str,
    record: &ScheduleRecordV1,
    recorded_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    let result_json = serde_json::to_string(record)
        .map_err(|error| serialization("schedule mutation receipt", error))?;
    sqlx::query(
        r#"
        INSERT INTO schedule_mutation_receipts (
            idempotency_key, request_digest, mutation_kind, schedule_id,
            result_json, recorded_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
    )
    .bind(idempotency_key)
    .bind(request_digest)
    .bind(mutation_kind)
    .bind(record.schedule_id.as_str())
    .bind(result_json)
    .bind(recorded_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("write_schedule_mutation_receipt", error))?;
    Ok(())
}

fn request_digest(
    kind: &str,
    request: &impl serde::Serialize,
) -> Result<String, DomainStoreErrorV1> {
    let bytes = serde_json::to_vec(&(kind, request))
        .map_err(|error| serialization("schedule mutation request", error))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub(crate) fn revision_conflict(
    schedule_id: &str,
    expected: u64,
    actual: Option<u64>,
) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::IdentityConflict {
        entity: "schedule",
        id: schedule_id.into(),
        reason: format!(
            "schedule_revision_conflict:expected={expected}:actual={}",
            actual.map_or_else(|| "none".into(), |value| value.to_string())
        ),
    }
}

pub(crate) fn invalid_contract(error: dure_app::ScheduleMutationErrorV1) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field: "schedule",
        reason: error.to_string(),
    }
}

pub(crate) fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub(crate) fn validate_observed_at(value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 0 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "observedAtMs",
            reason: "timestamp must be non-negative".into(),
        });
    }
    Ok(())
}

pub(crate) fn to_i64(field: &'static str, value: u64) -> Result<i64, DomainStoreErrorV1> {
    i64::try_from(value).map_err(|error| storage("integer_overflow", format!("{field}: {error}")))
}

pub(crate) fn to_u64(
    row: &SqliteRow,
    field: &'static str,
    table: &'static str,
) -> Result<u64, DomainStoreErrorV1> {
    let value: i64 = row
        .try_get(field)
        .map_err(|error| corrupt_row(table, error))?;
    u64::try_from(value)
        .map_err(|error| storage("corrupt_integer", format!("{table}.{field}: {error}")))
}

pub(crate) fn to_u16(
    row: &SqliteRow,
    field: &'static str,
    table: &'static str,
) -> Result<u16, DomainStoreErrorV1> {
    let value: i64 = row
        .try_get(field)
        .map_err(|error| corrupt_row(table, error))?;
    u16::try_from(value)
        .map_err(|error| storage("corrupt_integer", format!("{table}.{field}: {error}")))
}

impl crate::SqliteDomainStore {
    pub async fn put_schedule(
        &self,
        request: &dure_app::SchedulePutRequestV1,
        observed_at_ms: i64,
    ) -> Result<dure_app::ScheduleRecordV1, DomainStoreErrorV1> {
        put(&self.pool, request, observed_at_ms).await
    }

    pub async fn delete_schedule(
        &self,
        request: &dure_app::ScheduleDeleteRequestV1,
        observed_at_ms: i64,
    ) -> Result<dure_app::ScheduleRecordV1, DomainStoreErrorV1> {
        delete(&self.pool, request, observed_at_ms).await
    }

    pub async fn schedule(
        &self,
        schedule_id: &dure_app::ScheduleIdV1,
    ) -> Result<Option<dure_app::ScheduleRecordV1>, DomainStoreErrorV1> {
        get(&self.pool, schedule_id).await
    }

    pub async fn schedules(
        &self,
        maximum: usize,
    ) -> Result<(Vec<dure_app::ScheduleRecordV1>, bool), DomainStoreErrorV1> {
        list(&self.pool, maximum).await
    }
}
