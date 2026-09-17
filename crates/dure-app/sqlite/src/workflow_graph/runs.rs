use agent_orchestration::domain::graph::{
    ActionContract, ActionState, CompiledWorkflow, ExecutingWorkflow, RunStatus, RunTrigger,
    WorkflowChangeRequest, WorkflowRun, WorkflowRunSummary, WorkflowVersion,
};
use dure_app::DomainStoreErrorV1;
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

use super::definitions::{
    contract, db, decode, digest, encode, receipt, remember, required, snapshot,
};
use crate::{
    SqliteDomainStore,
    error::storage,
    schema::{begin_immediate, finish_transaction},
};

impl SqliteDomainStore {
    pub async fn active_workflow_run_ids(&self) -> Result<Vec<String>, DomainStoreErrorV1> {
        sqlx::query_scalar(
            "SELECT run_id FROM workflow_run_sources WHERE settled = 0 ORDER BY rowid LIMIT 64",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db)
    }

    pub async fn workflow_run_summaries(
        &self,
        workflow_id: &str,
    ) -> Result<Vec<WorkflowRunSummary>, DomainStoreErrorV1> {
        let rows: Vec<String> = sqlx::query_scalar("SELECT summary_json FROM workflow_run_sources WHERE workflow_id = ?1 ORDER BY rowid DESC LIMIT 128")
            .bind(workflow_id).fetch_all(&self.pool).await.map_err(db)?;
        rows.iter().map(|row| decode(row)).collect()
    }

    pub async fn workflow_runs(
        &self,
        workflow_id: Option<&str>,
        active_only: bool,
    ) -> Result<Vec<WorkflowRun>, DomainStoreErrorV1> {
        let rows: Vec<String> = sqlx::query_scalar("SELECT record_json FROM workflow_run_sources WHERE (?1 IS NULL OR workflow_id = ?1) AND (?2 = 0 OR settled = 0) ORDER BY rowid DESC LIMIT 128")
            .bind(workflow_id).bind(active_only).fetch_all(&self.pool).await.map_err(db)?;
        rows.iter().map(|row| decode(row)).collect()
    }

    pub async fn workflow_run(
        &self,
        run_id: &str,
    ) -> Result<Option<(WorkflowRun, WorkflowVersion)>, DomainStoreErrorV1> {
        let row: Option<(String, String)> = sqlx::query_as("SELECT source.record_json, version.record_json FROM workflow_run_sources AS source JOIN workflow_versions AS version ON version.workflow_id = source.workflow_id AND version.version = source.workflow_version WHERE source.run_id = ?1")
            .bind(run_id).fetch_optional(&self.pool).await.map_err(db)?;
        row.map(|(run, version)| Ok((decode(&run)?, decode(&version)?)))
            .transpose()
    }

    pub async fn manual_workflow_run_receipt(
        &self,
        request: &WorkflowChangeRequest,
    ) -> Result<Option<WorkflowRun>, DomainStoreErrorV1> {
        request.validate().map_err(contract)?;
        let mut connection = self.pool.acquire().await.map_err(db)?;
        receipt(
            &mut connection,
            &request.idempotency_key,
            &digest("run_once", request)?,
        )
        .await
    }

    pub async fn start_manual_workflow_run(
        &self,
        request: &WorkflowChangeRequest,
        compiled: &CompiledWorkflow,
        contracts: &[ActionContract],
        coordinator: &str,
        now: i64,
    ) -> Result<WorkflowRun, DomainStoreErrorV1> {
        request.validate().map_err(contract)?;
        let fingerprint = digest("run_once", request)?;
        let mut connection = self.pool.acquire().await.map_err(db)?;
        begin_immediate(&mut connection, "workflow_run").await?;
        let result = async {
            if let Some(previous) =
                receipt(&mut connection, &request.idempotency_key, &fingerprint).await?
            {
                return Ok(previous);
            }
            let current = required(&mut connection, &request.workflow_id).await?;
            current.check_change(request).map_err(contract)?;
            let version = snapshot(&mut connection, &current, compiled, now).await?;
            let execution = ExecutingWorkflow::admit(
                &version,
                contracts,
                &request.idempotency_key,
                RunTrigger::Manual,
                now,
            )
            .map_err(|_| {
                storage(
                    "workflow_run_invalid",
                    "compiled workflow rejected admission",
                )
            })?;
            insert(
                &mut connection,
                &execution,
                &version,
                &request.idempotency_key,
                coordinator,
            )
            .await?;
            remember(
                &mut connection,
                &request.idempotency_key,
                &fingerprint,
                execution.run(),
            )
            .await?;
            Ok(execution.into_run())
        }
        .await;
        finish_transaction(&mut connection, "workflow_run", result).await
    }

    pub async fn claim_scheduled_workflow_run(
        &self,
        workflow_id: &str,
        active_version: u64,
        minute: i64,
        contracts: &[ActionContract],
        coordinator: &str,
        now: i64,
    ) -> Result<Option<WorkflowRun>, DomainStoreErrorV1> {
        if minute < 0 || minute % 60000 != 0 {
            return Err(storage("workflow_time_invalid", "expected UTC minute"));
        }
        let key = format!(
            "workflow-schedule-{:x}",
            Sha256::digest(format!("{workflow_id}:{minute}"))
        );
        let mut connection = self.pool.acquire().await.map_err(db)?;
        begin_immediate(&mut connection, "workflow_run").await?;
        let result = async {
            let current = required(&mut connection, workflow_id).await?;
            if !current.enabled || current.active_version != Some(active_version) {
                return Ok(None);
            }
            let previous: Option<String> = sqlx::query_scalar(
                "SELECT run_id FROM workflow_run_sources WHERE idempotency_key = ?1",
            )
            .bind(&key)
            .fetch_optional(&mut *connection)
            .await
            .map_err(db)?;
            if previous.is_some() {
                return Ok(None);
            }
            let row: String = sqlx::query_scalar(
                "SELECT record_json FROM workflow_versions WHERE workflow_id = ?1 AND version = ?2",
            )
            .bind(workflow_id)
            .bind(active_version as i64)
            .fetch_one(&mut *connection)
            .await
            .map_err(db)?;
            let version: WorkflowVersion = decode(&row)?;
            let execution = ExecutingWorkflow::admit(
                &version,
                contracts,
                &key,
                RunTrigger::Schedule {
                    scheduled_for_ms: minute,
                },
                now,
            )
            .map_err(|_| storage("workflow_run_invalid", "active workflow rejected admission"))?;
            insert(&mut connection, &execution, &version, &key, coordinator).await?;
            Ok(Some(execution.into_run()))
        }
        .await;
        finish_transaction(&mut connection, "workflow_run", result).await
    }

    /// The pure core owns transitions. SQLite checks the prior durable revision
    /// and commits its canonical projection plus the audit event atomically.
    pub async fn update_workflow_run(
        &self,
        prior: &WorkflowRun,
        next: &ExecutingWorkflow,
    ) -> Result<WorkflowRun, DomainStoreErrorV1> {
        let run = next.run();
        if run == prior {
            return Ok(prior.clone());
        }
        if run.run_id != prior.run_id
            || run.workflow_id != prior.workflow_id
            || run.workflow_version != prior.workflow_version
            || run.source_digest != prior.source_digest
            || run.revision != prior.revision + 1
        {
            return Err(storage(
                "workflow_run_transition_invalid",
                prior.run_id.to_string(),
            ));
        }
        let changed: Vec<_> = prior
            .tasks
            .iter()
            .zip(&run.tasks)
            .filter(|(old, new)| old != new)
            .collect();
        let [(old, task)] = changed.as_slice() else {
            return Err(storage(
                "workflow_run_transition_invalid",
                "expected one dispatch transition",
            ));
        };
        let kind = match (&old.state, &task.state) {
            (ActionState::Pending, ActionState::Started { .. }) => "dispatch_started",
            (ActionState::Started { .. }, ActionState::Started { .. }) => "effect_bound",
            (_, ActionState::Completed { .. }) => "dispatch_completed",
            (_, ActionState::Failed { .. }) => "dispatch_failed",
            _ => {
                return Err(storage(
                    "workflow_run_transition_invalid",
                    "unexpected core transition",
                ));
            }
        };
        let mut connection = self.pool.acquire().await.map_err(db)?;
        begin_immediate(&mut connection, "workflow_run").await?;
        let result = async {
            let current: String = sqlx::query_scalar("SELECT record_json FROM workflow_run_sources WHERE run_id = ?1")
                .bind(prior.run_id.as_str()).fetch_one(&mut *connection).await.map_err(db)?;
            if decode::<WorkflowRun>(&current)? != *prior { return Err(storage("workflow_run_revision_conflict", prior.run_id.to_string())); }
            if let ActionState::Started { effect_ref: Some(operation), .. } = &task.state {
                // This is the Agent adapter's durable effect receipt, not a
                // generated Session identity. Bind before starting the effect.
                sqlx::query("INSERT INTO workflow_action_effects (dispatch_id, operation_id) VALUES (?1, ?2) ON CONFLICT(dispatch_id) DO NOTHING")
                    .bind(task.dispatch_id.as_str()).bind(operation).execute(&mut *connection).await.map_err(db)?;
            }
            let complete = matches!(task.state, ActionState::Completed { .. } | ActionState::Failed { .. });
            sqlx::query("UPDATE workflow_dispatches SET state = ?1, completion_result = ?2, updated_at_ms = ?3 WHERE dispatch_id = ?4")
                .bind(if complete { "completed" } else { "starting" })
                .bind(if complete { Some(encode(&task.state)?) } else { None })
                .bind(run.updated_at_ms).bind(task.dispatch_id.as_str()).execute(&mut *connection).await.map_err(db)?;
            sqlx::query("UPDATE workflow_tasks SET state = ?1, updated_at_ms = ?2 WHERE task_id = ?3")
                .bind(if complete { "completed" } else { "dispatched" }).bind(run.updated_at_ms).bind(task.task_id.as_str()).execute(&mut *connection).await.map_err(db)?;
            sqlx::query("UPDATE workflow_run_sources SET revision = ?1, settled = ?2, record_json = ?3, summary_json = ?4 WHERE run_id = ?5")
                .bind(run.revision as i64).bind(settled(run)).bind(encode(run)?).bind(encode(&run.summary())?).bind(run.run_id.as_str()).execute(&mut *connection).await.map_err(db)?;
            event(&mut connection, run, kind, Some(task.dispatch_id.as_str())).await?;
            Ok(run.clone())
        }.await;
        finish_transaction(&mut connection, "workflow_run", result).await
    }
}

fn settled(run: &WorkflowRun) -> bool {
    matches!(
        run.status(),
        RunStatus::Completed | RunStatus::Failed | RunStatus::Uncertain
    )
}

async fn insert(
    connection: &mut SqliteConnection,
    execution: &ExecutingWorkflow,
    version: &WorkflowVersion,
    key: &str,
    coordinator: &str,
) -> Result<(), DomainStoreErrorV1> {
    if coordinator.is_empty() || coordinator.len() > 256 {
        return Err(storage(
            "workflow_coordinator_invalid",
            "expected service actor",
        ));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM workflow_run_sources WHERE settled = 0")
            .fetch_one(&mut *connection)
            .await
            .map_err(db)?;
    if count >= 64 {
        return Err(storage("workflow_active_run_limit", "64 active runs"));
    }
    let run = execution.run();
    sqlx::query("INSERT INTO workflow_runs (run_id, contribution_id, coordinator_kind, coordinator_ref, created_at_ms) VALUES (?1, 'workflow.graph.v1', 'service', ?2, ?3)")
        .bind(run.run_id.as_str()).bind(coordinator).bind(run.created_at_ms).execute(&mut *connection).await.map_err(db)?;
    for task in &run.tasks {
        let node = version
            .definition
            .nodes
            .iter()
            .find(|node| node.node_id == task.node_id)
            .ok_or_else(|| storage("workflow_snapshot_invalid", &task.node_id))?;
        sqlx::query("INSERT INTO workflow_tasks (task_id, run_id, schema_version, summary, instructions, state, created_at_ms, updated_at_ms) VALUES (?1, ?2, 1, ?3, ?4, 'dispatched', ?5, ?5)")
            .bind(task.task_id.as_str()).bind(run.run_id.as_str()).bind(&node.name).bind(encode(&node.inputs)?).bind(run.created_at_ms).execute(&mut *connection).await.map_err(db)?;
        sqlx::query("INSERT INTO workflow_dispatches (dispatch_id, task_id, runtime_kind_id, target_reference, generation, state, created_at_ms, updated_at_ms) VALUES (?1, ?2, 'runtime.action', ?3, 1, 'starting', ?4, ?4)")
            .bind(task.dispatch_id.as_str()).bind(task.task_id.as_str()).bind(coordinator).bind(run.created_at_ms).execute(&mut *connection).await.map_err(db)?;
    }
    sqlx::query("INSERT INTO workflow_run_sources (run_id, workflow_id, workflow_version, idempotency_key, revision, settled, record_json, summary_json) VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?6)")
        .bind(run.run_id.as_str()).bind(&run.workflow_id).bind(run.workflow_version as i64).bind(key).bind(encode(run)?).bind(encode(&run.summary())?).execute(&mut *connection).await.map_err(db)?;
    event(connection, run, "run_created", None).await
}

async fn event(
    connection: &mut SqliteConnection,
    run: &WorkflowRun,
    kind: &str,
    dispatch: Option<&str>,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query("INSERT INTO workflow_run_events (run_id, revision, kind, dispatch_id, observed_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(run.run_id.as_str()).bind(run.revision as i64).bind(kind).bind(dispatch).bind(run.updated_at_ms).execute(connection).await.map_err(db)?;
    Ok(())
}
