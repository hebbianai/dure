use agent_orchestration::domain::graph::{
    CompiledWorkflow, WorkflowChangeRequest, WorkflowPutRequest, WorkflowRecord, WorkflowSummary,
    WorkflowVersion,
};
use dure_app::DomainStoreErrorV1;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

use crate::{
    SqliteDomainStore,
    error::{map_sqlx, serialization, storage},
    schema::{begin_immediate, finish_transaction},
};

impl SqliteDomainStore {
    pub async fn workflow_summaries(&self) -> Result<Vec<WorkflowSummary>, DomainStoreErrorV1> {
        let rows: Vec<(String, i64, String, bool, Option<i64>, i64)> = sqlx::query_as("SELECT workflow_id, revision, json_extract(record_json, '$.name'), json_extract(record_json, '$.enabled'), json_extract(record_json, '$.activeVersion'), json_array_length(record_json, '$.definition.nodes') FROM workflow_definitions ORDER BY workflow_id LIMIT 128")
            .fetch_all(&self.pool).await.map_err(db)?;
        rows.into_iter()
            .map(
                |(workflow_id, revision, name, enabled, active_version, count)| {
                    Ok(WorkflowSummary {
                        schema_version: 1,
                        workflow_id,
                        revision: u64::try_from(revision)
                            .map_err(|_| storage("workflow_snapshot_invalid", "revision"))?,
                        name,
                        enabled,
                        active_version: active_version
                            .map(u64::try_from)
                            .transpose()
                            .map_err(|_| storage("workflow_snapshot_invalid", "version"))?,
                        node_count: usize::try_from(count)
                            .map_err(|_| storage("workflow_snapshot_invalid", "node count"))?,
                    })
                },
            )
            .collect()
    }

    pub async fn workflow_activation_receipt(
        &self,
        request: &WorkflowChangeRequest,
    ) -> Result<Option<WorkflowRecord>, DomainStoreErrorV1> {
        request.validate().map_err(contract)?;
        let mut connection = self.pool.acquire().await.map_err(db)?;
        receipt(
            &mut connection,
            &request.idempotency_key,
            &digest("activate", request)?,
        )
        .await
    }

    pub async fn workflow_definition(
        &self,
        workflow_id: &str,
    ) -> Result<Option<WorkflowRecord>, DomainStoreErrorV1> {
        let mut connection = self.pool.acquire().await.map_err(db)?;
        read(&mut connection, workflow_id).await
    }

    pub async fn workflow_version(
        &self,
        workflow_id: &str,
        version: u64,
    ) -> Result<Option<WorkflowVersion>, DomainStoreErrorV1> {
        let version =
            i64::try_from(version).map_err(|_| storage("workflow_version_invalid", workflow_id))?;
        let row: Option<String> = sqlx::query_scalar(
            "SELECT record_json FROM workflow_versions WHERE workflow_id = ?1 AND version = ?2",
        )
        .bind(workflow_id)
        .bind(version)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?;
        row.map(|row| decode(&row)).transpose()
    }

    pub async fn put_workflow_definition(
        &self,
        request: &WorkflowPutRequest,
        now: i64,
    ) -> Result<WorkflowRecord, DomainStoreErrorV1> {
        request.validate().map_err(contract)?;
        let digest = digest("put", request)?;
        let mut connection = self.pool.acquire().await.map_err(db)?;
        begin_immediate(&mut connection, "workflow_definition").await?;
        let result = async {
            if let Some(previous) =
                receipt(&mut connection, &request.idempotency_key, &digest).await?
            {
                return Ok(previous);
            }
            let current = read(&mut connection, &request.workflow_id).await?;
            if current.is_none() {
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_definitions")
                    .fetch_one(&mut *connection)
                    .await
                    .map_err(db)?;
                if count >= 128 {
                    return Err(storage("workflow_limit_reached", "128 workflows"));
                }
            }
            let record = WorkflowRecord::save(current.as_ref(), request, now).map_err(contract)?;
            write(&mut connection, &record).await?;
            remember(&mut connection, &request.idempotency_key, &digest, &record).await?;
            Ok(record)
        }
        .await;
        finish_transaction(&mut connection, "workflow_definition", result).await
    }

    pub async fn pause_workflow_definition(
        &self,
        request: &WorkflowChangeRequest,
        now: i64,
    ) -> Result<WorkflowRecord, DomainStoreErrorV1> {
        request.validate().map_err(contract)?;
        let digest = digest("pause", request)?;
        let mut connection = self.pool.acquire().await.map_err(db)?;
        begin_immediate(&mut connection, "workflow_definition").await?;
        let result = async {
            if let Some(previous) =
                receipt(&mut connection, &request.idempotency_key, &digest).await?
            {
                return Ok(previous);
            }
            let current = required(&mut connection, &request.workflow_id).await?;
            let record = current.pause(request, now).map_err(contract)?;
            write(&mut connection, &record).await?;
            remember(&mut connection, &request.idempotency_key, &digest, &record).await?;
            Ok(record)
        }
        .await;
        finish_transaction(&mut connection, "workflow_definition", result).await
    }

    /// Compiled input is compared against the CAS-protected draft inside the
    /// transaction. Admission can never pin a version validated from stale data.
    pub async fn activate_workflow_definition(
        &self,
        request: &WorkflowChangeRequest,
        compiled: &CompiledWorkflow,
        now: i64,
    ) -> Result<WorkflowRecord, DomainStoreErrorV1> {
        request.validate().map_err(contract)?;
        let digest = digest("activate", request)?;
        let mut connection = self.pool.acquire().await.map_err(db)?;
        begin_immediate(&mut connection, "workflow_definition").await?;
        let result = async {
            if let Some(previous) =
                receipt(&mut connection, &request.idempotency_key, &digest).await?
            {
                return Ok(previous);
            }
            let current = required(&mut connection, &request.workflow_id).await?;
            current.check_change(request).map_err(contract)?;
            let version = snapshot(&mut connection, &current, compiled, now).await?;
            let record = current.activate(request, &version, now).map_err(contract)?;
            write(&mut connection, &record).await?;
            remember(&mut connection, &request.idempotency_key, &digest, &record).await?;
            Ok(record)
        }
        .await;
        finish_transaction(&mut connection, "workflow_definition", result).await
    }
}

pub(super) async fn snapshot(
    connection: &mut SqliteConnection,
    current: &WorkflowRecord,
    compiled: &CompiledWorkflow,
    now: i64,
) -> Result<WorkflowVersion, DomainStoreErrorV1> {
    let next: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM workflow_versions WHERE workflow_id = ?1",
    )
    .bind(&current.workflow_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(db)?;
    let version = current
        .snapshot(compiled, next as u64, now)
        .map_err(contract)?;
    sqlx::query(
        "INSERT INTO workflow_versions (workflow_id, version, record_json) VALUES (?1, ?2, ?3)",
    )
    .bind(&version.workflow_id)
    .bind(next)
    .bind(encode(&version)?)
    .execute(&mut *connection)
    .await
    .map_err(db)?;
    Ok(version)
}

pub(super) async fn read(
    connection: &mut SqliteConnection,
    id: &str,
) -> Result<Option<WorkflowRecord>, DomainStoreErrorV1> {
    let row: Option<String> =
        sqlx::query_scalar("SELECT record_json FROM workflow_definitions WHERE workflow_id = ?1")
            .bind(id)
            .fetch_optional(connection)
            .await
            .map_err(db)?;
    row.map(|row| decode(&row)).transpose()
}

pub(super) async fn required(
    connection: &mut SqliteConnection,
    id: &str,
) -> Result<WorkflowRecord, DomainStoreErrorV1> {
    read(connection, id)
        .await?
        .ok_or_else(|| storage("workflow_not_found", id))
}

async fn write(
    connection: &mut SqliteConnection,
    record: &WorkflowRecord,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query("INSERT INTO workflow_definitions (workflow_id, revision, record_json) VALUES (?1, ?2, ?3) ON CONFLICT(workflow_id) DO UPDATE SET revision = excluded.revision, record_json = excluded.record_json")
        .bind(&record.workflow_id).bind(record.revision as i64).bind(encode(record)?)
        .execute(connection).await.map_err(db)?;
    Ok(())
}

pub(super) fn encode(value: &impl Serialize) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(value).map_err(|error| serialization("workflow definition", error))
}

pub(super) fn decode<T: DeserializeOwned>(value: &str) -> Result<T, DomainStoreErrorV1> {
    serde_json::from_str(value).map_err(|error| serialization("workflow definition", error))
}

pub(super) fn digest(
    operation: &str,
    value: &impl Serialize,
) -> Result<String, DomainStoreErrorV1> {
    Ok(format!(
        "{:x}",
        Sha256::digest(encode(&(operation, value))?)
    ))
}

pub(super) async fn receipt<T: DeserializeOwned>(
    connection: &mut SqliteConnection,
    key: &str,
    expected: &str,
) -> Result<Option<T>, DomainStoreErrorV1> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT request_digest, result_json FROM workflow_definition_receipts WHERE idempotency_key = ?1")
        .bind(key).fetch_optional(connection).await.map_err(db)?;
    row.map(|(digest, value)| {
        if digest != expected {
            return Err(storage("workflow_idempotency_conflict", key));
        }
        decode(&value)
    })
    .transpose()
}

pub(super) async fn remember(
    connection: &mut SqliteConnection,
    key: &str,
    digest: &str,
    result: &impl Serialize,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query("INSERT INTO workflow_definition_receipts (idempotency_key, request_digest, result_json) VALUES (?1, ?2, ?3)")
        .bind(key).bind(digest).bind(encode(result)?).execute(connection).await.map_err(db)?;
    Ok(())
}

pub(super) fn db(error: sqlx::Error) -> DomainStoreErrorV1 {
    map_sqlx("workflow_definition", error)
}
pub(super) fn contract(
    issue: agent_orchestration::domain::graph::GraphIssue,
) -> DomainStoreErrorV1 {
    storage("workflow_contract_invalid", issue.code)
}
