use dure_app::{
    DomainStoreErrorV1, SCHEDULE_OCCURRENCE_SCHEMA_VERSION_V2, ScheduleIdV1, ScheduleLaunchStateV1,
    ScheduleOccurrenceRecordV2, ScheduleRunTemplateV1, ScheduleTriggerV1,
};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

use crate::SqliteDomainStore;
use crate::error::{corrupt_row, map_sqlx, serialization, storage};
use crate::schedules::{
    invalid_contract, revision_conflict, schedule_admitted_through_on, schedule_on, to_i64, to_u64,
    valid_token, validate_observed_at,
};
use crate::schema::{begin_immediate, finish_transaction};

const MAX_OCCURRENCES: usize = 256;

impl SqliteDomainStore {
    pub async fn claim_schedule_occurrence(
        &self,
        schedule_id: &ScheduleIdV1,
        schedule_revision: u64,
        scheduled_for_ms: i64,
        idempotency_key: &str,
        observed_at_ms: i64,
    ) -> Result<Option<(ScheduleOccurrenceRecordV2, ScheduleRunTemplateV1)>, DomainStoreErrorV1>
    {
        self.admit_schedule_occurrence(
            schedule_id,
            schedule_revision,
            ScheduleTriggerV1::Scheduled { scheduled_for_ms },
            idempotency_key,
            observed_at_ms,
        )
        .await
    }

    pub async fn run_schedule_once(
        &self,
        schedule_id: &ScheduleIdV1,
        schedule_revision: u64,
        idempotency_key: &str,
        observed_at_ms: i64,
    ) -> Result<ScheduleOccurrenceRecordV2, DomainStoreErrorV1> {
        let (mut record, _) = self
            .admit_schedule_occurrence(
                schedule_id,
                schedule_revision,
                ScheduleTriggerV1::Manual,
                idempotency_key,
                observed_at_ms,
            )
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "schedule",
                id: schedule_id.to_string(),
            })?;
        record.run = crate::schedule_runs::inspect(&self.pool, idempotency_key)
            .await?
            .map(|(summary, _)| summary);
        Ok(record)
    }

    async fn admit_schedule_occurrence(
        &self,
        schedule_id: &ScheduleIdV1,
        schedule_revision: u64,
        trigger: ScheduleTriggerV1,
        idempotency_key: &str,
        observed_at_ms: i64,
    ) -> Result<Option<(ScheduleOccurrenceRecordV2, ScheduleRunTemplateV1)>, DomainStoreErrorV1>
    {
        validate_observed_at(observed_at_ms)?;
        if schedule_revision == 0
            || !valid_token(idempotency_key)
            || trigger
                .scheduled_for_ms()
                .is_some_and(|ms| ms < 0 || ms % 60_000 != 0 || ms > observed_at_ms)
        {
            return Err(storage(
                "schedule_occurrence_invalid",
                "invalid admission identity",
            ));
        }
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|e| map_sqlx("admit_schedule_occurrence", e))?;
        begin_immediate(&mut connection, "admit_schedule_occurrence").await?;
        let result = async {
            if let Some(existing) = occurrence_on(&mut connection, idempotency_key).await? {
                if existing.0.schedule_id != *schedule_id
                    || existing.0.trigger != trigger
                    || existing.0.schedule_revision != schedule_revision
                {
                    return Err(DomainStoreErrorV1::IdempotencyConflict {
                        reason: "schedule occurrence identity changed".into(),
                    });
                }
                return Ok(
                    if trigger == ScheduleTriggerV1::Manual
                        || existing.0.launch_state == ScheduleLaunchStateV1::Pending
                    {
                        Some(existing)
                    } else {
                        None
                    },
                );
            }
            let Some(schedule) = schedule_on(&mut connection, schedule_id).await? else {
                return Ok(None);
            };
            if schedule.deleted_at_ms.is_some() {
                return Ok(None);
            }
            if schedule.revision != schedule_revision {
                if trigger == ScheduleTriggerV1::Manual {
                    return Err(revision_conflict(
                        schedule_id.as_str(),
                        schedule_revision,
                        Some(schedule.revision),
                    ));
                }
                return Ok(None);
            }
            if let Some(minute) = trigger.scheduled_for_ms() {
                // A durable watermark prevents replay even after old launch receipts are compacted.
                if !schedule.enabled
                    || schedule_admitted_through_on(&mut connection, schedule_id)
                        .await?
                        .is_some_and(|watermark| minute <= watermark)
                {
                    return Ok(None);
                }
            }
            let template = serde_json::to_string(&schedule.run_template)
                .map_err(|e| serialization("schedule occurrence run template", e))?;
            sqlx::query(
                r#"INSERT INTO schedule_occurrences (
                idempotency_key, schedule_id, scheduled_for_ms, schema_version, schedule_revision,
                run_template_json, state, created_at_ms, updated_at_ms
            ) VALUES (?1, ?2, ?3, 2, ?4, ?5, 'pending', ?6, ?6)"#,
            )
            .bind(idempotency_key)
            .bind(schedule_id.as_str())
            .bind(trigger.scheduled_for_ms())
            .bind(to_i64("schedule revision", schedule_revision)?)
            .bind(template)
            .bind(observed_at_ms)
            .execute(&mut *connection)
            .await
            .map_err(|e| map_sqlx("admit_schedule_occurrence", e))?;
            if let Some(minute) = trigger.scheduled_for_ms() {
                sqlx::query("UPDATE schedules SET admitted_through_ms = ?2 WHERE schedule_id = ?1")
                    .bind(schedule_id.as_str())
                    .bind(minute)
                    .execute(&mut *connection)
                    .await
                    .map_err(|e| map_sqlx("admit_schedule_occurrence", e))?;
            }
            occurrence_on(&mut connection, idempotency_key).await
        }
        .await;
        finish_transaction(&mut connection, "admit_schedule_occurrence", result).await
    }

    pub async fn pending_schedule_occurrences(
        &self,
        maximum: usize,
    ) -> Result<Vec<(ScheduleOccurrenceRecordV2, ScheduleRunTemplateV1)>, DomainStoreErrorV1> {
        validate_limit(maximum)?;
        let rows = sqlx::query("SELECT * FROM schedule_occurrences WHERE state = 'pending' ORDER BY created_at_ms, idempotency_key LIMIT ?1")
            .bind(maximum as i64).fetch_all(&self.pool).await.map_err(|e| map_sqlx("pending_schedule_occurrences", e))?;
        rows.into_iter().map(from_row).collect()
    }

    /// Persist the launch identity before an agent can enroll its reporting Run.
    pub async fn bind_schedule_spawn(
        &self,
        key: &str,
        operation_id: &str,
    ) -> Result<(), DomainStoreErrorV1> {
        let changed = sqlx::query(
            r#"UPDATE schedule_occurrences SET operation_id = ?2
            WHERE idempotency_key = ?1 AND state = 'pending'
              AND (operation_id IS NULL OR operation_id = ?2)
              AND EXISTS (SELECT 1 FROM agent_spawn_receipts
                  WHERE operation_id = ?2 AND idempotency_key = ?1)"#,
        )
        .bind(key)
        .bind(operation_id)
        .execute(&self.pool)
        .await
        .map_err(|e| map_sqlx("bind_schedule_spawn", e))?;
        if changed.rows_affected() != 1 {
            return Err(storage(
                "schedule_spawn_conflict",
                "launch identity is not authoritative",
            ));
        }
        Ok(())
    }

    pub async fn finish_schedule_launch(
        &self,
        key: &str,
        operation_id: Option<&str>,
        error_code: Option<&str>,
        observed_at_ms: i64,
    ) -> Result<ScheduleOccurrenceRecordV2, DomainStoreErrorV1> {
        validate_observed_at(observed_at_ms)?;
        if (operation_id.is_none() && error_code.is_none())
            || operation_id.is_some_and(|s| !valid_token(s))
            || error_code.is_some_and(|s| !valid_token(s))
        {
            return Err(storage(
                "schedule_launch_outcome_invalid",
                "an operation or error is required",
            ));
        }
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|e| map_sqlx("finish_schedule_launch", e))?;
        begin_immediate(&mut connection, "finish_schedule_launch").await?;
        let result = async {
            let (current, _) = occurrence_on(&mut connection, key).await?.ok_or_else(||
                DomainStoreErrorV1::NotFound { entity: "schedule occurrence", id: key.into() })?;
            if current.launch_state != ScheduleLaunchStateV1::Pending {
                return if current.operation_id.as_deref() == operation_id && current.error_code.as_deref() == error_code {
                    Ok(current)
                } else { Err(storage("schedule_launch_outcome_conflict", "terminal launch outcome changed")) };
            }
            if current.operation_id.as_deref().is_some_and(|bound| Some(bound) != operation_id) {
                return Err(storage("schedule_spawn_conflict", "bound launch identity changed"));
            }
            let launch_state = if error_code.is_some() { ScheduleLaunchStateV1::Failed } else { ScheduleLaunchStateV1::Started };
            sqlx::query("UPDATE schedule_occurrences SET state = ?2, operation_id = ?3, error_code = ?4, updated_at_ms = MAX(updated_at_ms, ?5) WHERE idempotency_key = ?1")
                .bind(key).bind(launch_state.as_str()).bind(operation_id).bind(error_code).bind(observed_at_ms)
                .execute(&mut *connection).await.map_err(|e| map_sqlx("finish_schedule_launch", e))?;
            let (record, _) = occurrence_on(&mut connection, key).await?.ok_or_else(|| storage("schedule_occurrence_missing", key))?;
            // Keep pending work and missing reports. Manual keys stay durable so
            // retrying a manual request can never admit the same effect again.
            sqlx::query(r#"DELETE FROM schedule_occurrences WHERE rowid IN (
                SELECT occurrence.rowid FROM schedule_occurrences AS occurrence
                LEFT JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = occurrence.dispatch_id
                WHERE occurrence.schedule_id = ?1 AND occurrence.scheduled_for_ms IS NOT NULL
                  AND (occurrence.state = 'failed' OR dispatch.state = 'completed')
                ORDER BY occurrence.scheduled_for_ms DESC LIMIT -1 OFFSET 256
            )"#).bind(record.schedule_id.as_str()).execute(&mut *connection).await
                .map_err(|e| map_sqlx("compact_finished_schedule_occurrences", e))?;
            Ok(record)
        }.await;
        finish_transaction(&mut connection, "finish_schedule_launch", result).await
    }

    pub async fn schedule_occurrences(
        &self,
        schedule_id: Option<&ScheduleIdV1>,
        maximum: usize,
    ) -> Result<Vec<ScheduleOccurrenceRecordV2>, DomainStoreErrorV1> {
        validate_limit(maximum)?;
        let rows = sqlx::query("SELECT * FROM schedule_occurrences WHERE (?1 IS NULL OR schedule_id = ?1) ORDER BY created_at_ms DESC, idempotency_key LIMIT ?2")
            .bind(schedule_id.map(ScheduleIdV1::as_str)).bind(maximum as i64).fetch_all(&self.pool).await
            .map_err(|e| map_sqlx("list_schedule_occurrences", e))?;
        let mut records = Vec::with_capacity(rows.len());
        for row in rows {
            let (mut record, _) = from_row(row)?;
            record.run = crate::schedule_runs::inspect(&self.pool, &record.idempotency_key)
                .await?
                .map(|(summary, _)| summary);
            records.push(record);
        }
        Ok(records)
    }

    pub async fn schedule_occurrence(
        &self,
        key: &str,
    ) -> Result<Option<(ScheduleOccurrenceRecordV2, Option<String>)>, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|e| map_sqlx("read_schedule_occurrence", e))?;
        let Some((mut record, _)) = occurrence_on(&mut connection, key).await? else {
            return Ok(None);
        };
        drop(connection);
        let result =
            if let Some((run, result)) = crate::schedule_runs::inspect(&self.pool, key).await? {
                record.run = Some(run);
                result
            } else {
                None
            };
        Ok(Some((record, result)))
    }
}

pub(crate) async fn occurrence_on(
    connection: &mut SqliteConnection,
    key: &str,
) -> Result<Option<(ScheduleOccurrenceRecordV2, ScheduleRunTemplateV1)>, DomainStoreErrorV1> {
    sqlx::query("SELECT * FROM schedule_occurrences WHERE idempotency_key = ?1")
        .bind(key)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|e| map_sqlx("read_schedule_occurrence", e))?
        .map(from_row)
        .transpose()
}

fn from_row(
    row: SqliteRow,
) -> Result<(ScheduleOccurrenceRecordV2, ScheduleRunTemplateV1), DomainStoreErrorV1> {
    let read_error = |error| corrupt_row("schedule_occurrences", error);
    let state: String = row.try_get("state").map_err(read_error)?;
    let launch_state = match state.as_str() {
        "pending" => ScheduleLaunchStateV1::Pending,
        "started" => ScheduleLaunchStateV1::Started,
        "failed" => ScheduleLaunchStateV1::Failed,
        _ => {
            return Err(storage(
                "corrupt_schedule_occurrence",
                "unknown launch state",
            ));
        }
    };
    let template: String = row.try_get("run_template_json").map_err(read_error)?;
    let template: ScheduleRunTemplateV1 =
        serde_json::from_str(&template).map_err(|e| serialization("schedule run template", e))?;
    let scheduled_for_ms: Option<i64> = row.try_get("scheduled_for_ms").map_err(read_error)?;
    let record = ScheduleOccurrenceRecordV2 {
        schema_version: SCHEDULE_OCCURRENCE_SCHEMA_VERSION_V2,
        schedule_id: ScheduleIdV1::new(
            row.try_get::<String, _>("schedule_id")
                .map_err(read_error)?,
        )
        .map_err(invalid_contract)?,
        schedule_revision: to_u64(&row, "schedule_revision", "schedule_occurrences")?,
        trigger: scheduled_for_ms.map_or(ScheduleTriggerV1::Manual, |scheduled_for_ms| {
            ScheduleTriggerV1::Scheduled { scheduled_for_ms }
        }),
        idempotency_key: row.try_get("idempotency_key").map_err(read_error)?,
        launch_state,
        run: None,
        operation_id: row.try_get("operation_id").map_err(read_error)?,
        error_code: row.try_get("error_code").map_err(read_error)?,
        created_at_ms: row.try_get("created_at_ms").map_err(read_error)?,
        updated_at_ms: row.try_get("updated_at_ms").map_err(read_error)?,
    };
    record.validate().map_err(invalid_contract)?;
    template.validate().map_err(invalid_contract)?;
    Ok((record, template))
}

fn validate_limit(maximum: usize) -> Result<(), DomainStoreErrorV1> {
    if !(1..=MAX_OCCURRENCES).contains(&maximum) {
        return Err(storage(
            "schedule_limit_invalid",
            "occurrence limit is out of bounds",
        ));
    }
    Ok(())
}
