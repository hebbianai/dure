use std::collections::BTreeSet;

use dure_app::{
    AgentIdV1, AgentRecordV1, DomainStoreErrorV1, ProjectIdV1, ProjectRecordV1, ProviderIdV1,
    ReviewIdV1, ReviewTargetRecordV1, ReviewTargetRetentionPolicyV1, ReviewTargetRootSnapshotV1,
    ReviewTargetSweepReceiptV1, RuntimeKindIdV1, SessionBindingRecordV1, WorkspaceIdV1,
    WorkspaceRecordV1,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Executor, Row, Sqlite, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, identity_conflict, map_sqlx, storage};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn upsert_project<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    record: &ProjectRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    record.validate()?;
    let result = sqlx::query(
        r#"
        INSERT INTO projects (
            project_id, root_path, display_name, created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(project_id) DO UPDATE SET
            root_path = excluded.root_path,
            display_name = excluded.display_name,
            updated_at_ms = excluded.updated_at_ms
        WHERE projects.created_at_ms = excluded.created_at_ms
          AND excluded.updated_at_ms >= projects.updated_at_ms
        "#,
    )
    .bind(record.project_id.as_str())
    .bind(&record.root_path)
    .bind(&record.display_name)
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .execute(executor)
    .await
    .map_err(|error| map_sqlx("upsert_project", error))?;

    if result.rows_affected() == 0 {
        return Err(identity_conflict(
            "project",
            record.project_id.as_str(),
            "createdAtMs is immutable and updatedAtMs may not move backward",
        ));
    }
    Ok(())
}

pub(crate) async fn project<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    project_id: &ProjectIdV1,
) -> Result<Option<ProjectRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT project_id, root_path, display_name, created_at_ms, updated_at_ms
        FROM projects
        WHERE project_id = ?1
        "#,
    )
    .bind(project_id.as_str())
    .fetch_optional(executor)
    .await
    .map_err(|error| map_sqlx("read_project", error))?;
    row.map(project_from_row).transpose()
}

pub(crate) async fn upsert_workspace<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    record: &WorkspaceRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    record.validate()?;
    let result = sqlx::query(
        r#"
        INSERT INTO workspaces (
            workspace_id, project_id, root_path, base_commit_sha, created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(workspace_id) DO UPDATE SET
            root_path = excluded.root_path,
            base_commit_sha = excluded.base_commit_sha,
            updated_at_ms = excluded.updated_at_ms
        WHERE workspaces.project_id = excluded.project_id
          AND workspaces.created_at_ms = excluded.created_at_ms
          AND excluded.updated_at_ms >= workspaces.updated_at_ms
        "#,
    )
    .bind(record.workspace_id.as_str())
    .bind(record.project_id.as_str())
    .bind(&record.root_path)
    .bind(&record.base_commit_sha)
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .execute(executor)
    .await
    .map_err(|error| map_sqlx("upsert_workspace", error))?;

    if result.rows_affected() == 0 {
        return Err(identity_conflict(
            "workspace",
            record.workspace_id.as_str(),
            "projectId and createdAtMs are immutable, and updatedAtMs may not move backward",
        ));
    }
    Ok(())
}

pub(crate) async fn workspace(
    pool: &SqlitePool,
    workspace_id: &WorkspaceIdV1,
) -> Result<Option<WorkspaceRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_workspace", error))?;
    workspace_on(&mut connection, workspace_id).await
}

pub(crate) async fn workspace_on(
    connection: &mut SqliteConnection,
    workspace_id: &WorkspaceIdV1,
) -> Result<Option<WorkspaceRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT workspace_id, project_id, root_path, base_commit_sha, created_at_ms, updated_at_ms
        FROM workspaces
        WHERE workspace_id = ?1
        "#,
    )
    .bind(workspace_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_workspace", error))?;
    row.map(workspace_from_row).transpose()
}

pub(crate) async fn upsert_agent<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    record: &AgentRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    record.validate()?;
    let result = sqlx::query(
        r#"
        INSERT INTO agents (
            agent_id, workspace_id, provider_id, display_name, created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(agent_id) DO UPDATE SET
            display_name = excluded.display_name,
            updated_at_ms = excluded.updated_at_ms
        WHERE agents.workspace_id = excluded.workspace_id
          AND agents.provider_id = excluded.provider_id
          AND agents.created_at_ms = excluded.created_at_ms
          AND excluded.updated_at_ms >= agents.updated_at_ms
        "#,
    )
    .bind(record.agent_id.as_str())
    .bind(record.workspace_id.as_str())
    .bind(record.provider_id.as_str())
    .bind(&record.display_name)
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .execute(executor)
    .await
    .map_err(|error| map_sqlx("upsert_agent", error))?;

    if result.rows_affected() == 0 {
        return Err(identity_conflict(
            "agent",
            record.agent_id.as_str(),
            "workspaceId, providerId, and createdAtMs are immutable, and updatedAtMs may not move backward",
        ));
    }
    Ok(())
}

pub(crate) async fn agent<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT agent_id, workspace_id, provider_id, display_name, created_at_ms, updated_at_ms
        FROM agents
        WHERE agent_id = ?1
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(executor)
    .await
    .map_err(|error| map_sqlx("read_agent", error))?;
    row.map(agent_from_row).transpose()
}

pub(crate) async fn upsert_session_binding(
    pool: &SqlitePool,
    record: &SessionBindingRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    record.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("upsert_session_binding", error))?;
    begin_immediate(&mut connection, "upsert_session_binding").await?;

    let result = async {
        let existing = session_binding_on(&mut connection, &record.agent_id).await?;
        match existing {
            None => {
                sqlx::query(
                    r#"
                    INSERT INTO session_bindings (
                        agent_id,
                        runtime_kind_id,
                        session_id,
                        provider_conversation_id,
                        credential_reference_id,
                        binding_generation,
                        bound_at_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    "#,
                )
                .bind(record.agent_id.as_str())
                .bind(record.runtime_kind_id.as_str())
                .bind(&record.session_id)
                .bind(&record.provider_conversation_id)
                .bind(&record.credential_reference_id)
                .bind(record.binding_generation)
                .bind(record.bound_at_ms)
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("upsert_session_binding", error))?;
            }
            Some(existing) if existing == *record => {}
            Some(existing) if record.binding_generation <= existing.binding_generation => {
                return Err(identity_conflict(
                    "session_binding",
                    record.agent_id.as_str(),
                    "a generation may only be replayed exactly or advance",
                ));
            }
            Some(existing) if record.bound_at_ms < existing.bound_at_ms => {
                return Err(identity_conflict(
                    "session_binding",
                    record.agent_id.as_str(),
                    "boundAtMs may not move backward when a generation advances",
                ));
            }
            Some(_) => {
                sqlx::query(
                    r#"
                    UPDATE session_bindings SET
                        runtime_kind_id = ?2,
                        session_id = ?3,
                        provider_conversation_id = ?4,
                        credential_reference_id = ?5,
                        binding_generation = ?6,
                        bound_at_ms = ?7
                    WHERE agent_id = ?1
                    "#,
                )
                .bind(record.agent_id.as_str())
                .bind(record.runtime_kind_id.as_str())
                .bind(&record.session_id)
                .bind(&record.provider_conversation_id)
                .bind(&record.credential_reference_id)
                .bind(record.binding_generation)
                .bind(record.bound_at_ms)
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("upsert_session_binding", error))?;
            }
        }
        Ok(())
    }
    .await;

    finish_transaction(&mut connection, "upsert_session_binding", result).await
}

pub(crate) async fn session_binding(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<SessionBindingRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_session_binding", error))?;
    session_binding_on(&mut connection, agent_id).await
}

pub(crate) async fn create_review_target(
    pool: &SqlitePool,
    record: &ReviewTargetRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    record.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("create_review_target", error))?;
    begin_immediate(&mut connection, "create_review_target").await?;

    let result = async {
        match review_target_on(&mut connection, &record.review_id).await? {
            Some(existing) if existing != *record => {
                return Err(identity_conflict(
                    "review_target",
                    record.review_id.as_str(),
                    "review target identity is immutable",
                ));
            }
            Some(_) => {}
            None => {
                sqlx::query(
                    r#"
                    INSERT INTO review_targets (
                        review_id,
                        worktree_path,
                        worktree_git_dir,
                        base_ref,
                        base_commit_sha,
                        head_commit_sha,
                        source_session_id,
                        feedback_agent_id,
                        created_at_ms
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                    "#,
                )
                .bind(record.review_id.as_str())
                .bind(&record.worktree_path)
                .bind(&record.worktree_git_dir)
                .bind(&record.base_ref)
                .bind(&record.base_commit_sha)
                .bind(&record.head_commit_sha)
                .bind(&record.source_session_id)
                .bind(record.feedback_agent_id.as_ref().map(AgentIdV1::as_str))
                .bind(record.created_at_ms)
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("create_review_target", error))?;
            }
        }

        // A target starts inactive until a persisted Dock layout roots it. If
        // the app crashes before that layout write, retention can eventually
        // reclaim the otherwise orphaned immutable record.
        sqlx::query(
            r#"
            INSERT INTO review_target_lifecycle (
                review_id,
                inactive_since_ms,
                observed_at_ms
            ) VALUES (?1, ?2, ?2)
            ON CONFLICT(review_id) DO NOTHING
            "#,
        )
        .bind(record.review_id.as_str())
        .bind(record.created_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("create_review_target_lifecycle", error))?;
        Ok(())
    }
    .await;

    finish_transaction(&mut connection, "create_review_target", result).await
}

pub(crate) async fn review_target(
    pool: &SqlitePool,
    review_id: &ReviewIdV1,
) -> Result<Option<ReviewTargetRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_review_target", error))?;
    review_target_on(&mut connection, review_id).await
}

async fn review_target_on(
    connection: &mut SqliteConnection,
    review_id: &ReviewIdV1,
) -> Result<Option<ReviewTargetRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            review_id,
            worktree_path,
            worktree_git_dir,
            base_ref,
            base_commit_sha,
            head_commit_sha,
            source_session_id,
            feedback_agent_id,
            created_at_ms
        FROM review_targets
        WHERE review_id = ?1
        "#,
    )
    .bind(review_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_review_target", error))?;
    row.map(review_target_from_row).transpose()
}

pub(crate) async fn reconcile_review_target_roots(
    pool: &SqlitePool,
    snapshot: &ReviewTargetRootSnapshotV1,
    policy: &ReviewTargetRetentionPolicyV1,
) -> Result<ReviewTargetSweepReceiptV1, DomainStoreErrorV1> {
    snapshot.validate()?;
    policy.validate()?;
    let active_review_ids = snapshot
        .active_review_ids
        .iter()
        .map(ReviewIdV1::as_str)
        .collect::<BTreeSet<_>>();
    let cutoff = snapshot
        .observed_at_ms
        .saturating_sub(policy.inactive_retention_ms);
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("reconcile_review_target_roots", error))?;
    begin_immediate(&mut connection, "reconcile_review_target_roots").await?;

    let result = async {
        let lifecycle_rows = sqlx::query(
            r#"
            SELECT review_id, inactive_since_ms, observed_at_ms
            FROM review_target_lifecycle
            "#,
        )
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_review_target_lifecycle", error))?;

        for row in lifecycle_rows {
            let review_id: String = row
                .try_get("review_id")
                .map_err(|error| corrupt_row("review_target_lifecycle", error))?;
            let inactive_since_ms: Option<i64> = row
                .try_get("inactive_since_ms")
                .map_err(|error| corrupt_row("review_target_lifecycle", error))?;
            let observed_at_ms: i64 = row
                .try_get("observed_at_ms")
                .map_err(|error| corrupt_row("review_target_lifecycle", error))?;
            let active = active_review_ids.contains(review_id.as_str());
            let should_update = snapshot.observed_at_ms > observed_at_ms
                || (snapshot.observed_at_ms == observed_at_ms
                    && active
                    && inactive_since_ms.is_some());
            if !should_update {
                continue;
            }
            sqlx::query(
                r#"
                UPDATE review_target_lifecycle SET
                    inactive_since_ms = ?2,
                    observed_at_ms = ?3
                WHERE review_id = ?1
                "#,
            )
            .bind(&review_id)
            .bind(if active {
                None
            } else {
                inactive_since_ms.or(Some(snapshot.observed_at_ms))
            })
            .bind(snapshot.observed_at_ms)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("update_review_target_lifecycle", error))?;
        }

        // A root can be persisted just before target creation finishes. Seed a
        // missing lifecycle row only when the immutable target already exists;
        // the Diff panel retries reconciliation after creation as well.
        for review_id in &snapshot.active_review_ids {
            sqlx::query(
                r#"
                INSERT INTO review_target_lifecycle (
                    review_id,
                    inactive_since_ms,
                    observed_at_ms
                )
                SELECT review_id, NULL, ?2
                FROM review_targets
                WHERE review_id = ?1
                ON CONFLICT(review_id) DO UPDATE SET
                    inactive_since_ms = NULL,
                    observed_at_ms = excluded.observed_at_ms
                WHERE excluded.observed_at_ms > review_target_lifecycle.observed_at_ms
                   OR (
                       excluded.observed_at_ms = review_target_lifecycle.observed_at_ms
                       AND review_target_lifecycle.inactive_since_ms IS NOT NULL
                   )
                "#,
            )
            .bind(review_id.as_str())
            .bind(snapshot.observed_at_ms)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("root_review_target", error))?;
        }

        let inactive_before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM review_target_lifecycle WHERE inactive_since_ms IS NOT NULL",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| map_sqlx("count_inactive_review_targets", error))?;
        let excess = inactive_before.saturating_sub(i64::from(policy.max_inactive_targets));
        let candidates = sqlx::query_scalar::<_, String>(
            r#"
            SELECT review_id
            FROM review_target_lifecycle
            WHERE inactive_since_ms IS NOT NULL
              AND inactive_since_ms <= ?1
            ORDER BY inactive_since_ms ASC, review_id ASC
            LIMIT ?2
            "#,
        )
        .bind(cutoff)
        .bind(excess)
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| map_sqlx("select_review_target_sweep", error))?;

        for review_id in &candidates {
            sqlx::query("DELETE FROM review_targets WHERE review_id = ?1")
                .bind(review_id)
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("delete_review_target", error))?;
        }

        let active_targets: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM review_target_lifecycle WHERE inactive_since_ms IS NULL",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| map_sqlx("count_active_review_targets", error))?;
        let inactive_targets: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM review_target_lifecycle WHERE inactive_since_ms IS NOT NULL",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| map_sqlx("count_inactive_review_targets", error))?;
        Ok(ReviewTargetSweepReceiptV1 {
            active_targets: u64::try_from(active_targets)
                .map_err(|error| storage("invalid_count", error.to_string()))?,
            inactive_targets: u64::try_from(inactive_targets)
                .map_err(|error| storage("invalid_count", error.to_string()))?,
            deleted_targets: u64::try_from(candidates.len())
                .map_err(|error| storage("invalid_count", error.to_string()))?,
        })
    }
    .await;

    finish_transaction(&mut connection, "reconcile_review_target_roots", result).await
}

pub(crate) async fn session_binding_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<SessionBindingRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            agent_id,
            runtime_kind_id,
            session_id,
            provider_conversation_id,
            credential_reference_id,
            binding_generation,
            bound_at_ms
        FROM session_bindings
        WHERE agent_id = ?1
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_session_binding", error))?;
    row.map(session_binding_from_row).transpose()
}

fn review_target_from_row(row: SqliteRow) -> Result<ReviewTargetRecordV1, DomainStoreErrorV1> {
    let feedback_agent_id = row
        .try_get::<Option<String>, _>("feedback_agent_id")
        .map_err(|error| corrupt_row("review_targets", error))?
        .map(|value| durable_id("review_targets.feedback_agent_id", value, AgentIdV1::new))
        .transpose()?;
    Ok(ReviewTargetRecordV1 {
        review_id: durable_id(
            "review_targets.review_id",
            row.try_get("review_id")
                .map_err(|error| corrupt_row("review_targets", error))?,
            ReviewIdV1::new,
        )?,
        worktree_path: row
            .try_get("worktree_path")
            .map_err(|error| corrupt_row("review_targets", error))?,
        worktree_git_dir: row
            .try_get("worktree_git_dir")
            .map_err(|error| corrupt_row("review_targets", error))?,
        base_ref: row
            .try_get("base_ref")
            .map_err(|error| corrupt_row("review_targets", error))?,
        base_commit_sha: row
            .try_get("base_commit_sha")
            .map_err(|error| corrupt_row("review_targets", error))?,
        head_commit_sha: row
            .try_get("head_commit_sha")
            .map_err(|error| corrupt_row("review_targets", error))?,
        source_session_id: row
            .try_get("source_session_id")
            .map_err(|error| corrupt_row("review_targets", error))?,
        feedback_agent_id,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("review_targets", error))?,
    })
}

fn project_from_row(row: SqliteRow) -> Result<ProjectRecordV1, DomainStoreErrorV1> {
    Ok(ProjectRecordV1 {
        project_id: durable_id(
            "projects.project_id",
            row.try_get("project_id")
                .map_err(|error| corrupt_row("projects", error))?,
            ProjectIdV1::new,
        )?,
        root_path: row
            .try_get("root_path")
            .map_err(|error| corrupt_row("projects", error))?,
        display_name: row
            .try_get("display_name")
            .map_err(|error| corrupt_row("projects", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("projects", error))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("projects", error))?,
    })
}

pub(crate) fn workspace_from_row(row: SqliteRow) -> Result<WorkspaceRecordV1, DomainStoreErrorV1> {
    Ok(WorkspaceRecordV1 {
        workspace_id: durable_id(
            "workspaces.workspace_id",
            row.try_get("workspace_id")
                .map_err(|error| corrupt_row("workspaces", error))?,
            WorkspaceIdV1::new,
        )?,
        project_id: durable_id(
            "workspaces.project_id",
            row.try_get("project_id")
                .map_err(|error| corrupt_row("workspaces", error))?,
            ProjectIdV1::new,
        )?,
        root_path: row
            .try_get("root_path")
            .map_err(|error| corrupt_row("workspaces", error))?,
        base_commit_sha: row
            .try_get("base_commit_sha")
            .map_err(|error| corrupt_row("workspaces", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("workspaces", error))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("workspaces", error))?,
    })
}

fn agent_from_row(row: SqliteRow) -> Result<AgentRecordV1, DomainStoreErrorV1> {
    let provider_id: String = row
        .try_get("provider_id")
        .map_err(|error| corrupt_row("agents", error))?;
    Ok(AgentRecordV1 {
        agent_id: durable_id(
            "agents.agent_id",
            row.try_get("agent_id")
                .map_err(|error| corrupt_row("agents", error))?,
            AgentIdV1::new,
        )?,
        workspace_id: durable_id(
            "agents.workspace_id",
            row.try_get("workspace_id")
                .map_err(|error| corrupt_row("agents", error))?,
            WorkspaceIdV1::new,
        )?,
        provider_id: ProviderIdV1::new(provider_id)
            .map_err(|error| corrupt_identifier("agents.provider_id", error))?,
        display_name: row
            .try_get("display_name")
            .map_err(|error| corrupt_row("agents", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("agents", error))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("agents", error))?,
    })
}

fn session_binding_from_row(row: SqliteRow) -> Result<SessionBindingRecordV1, DomainStoreErrorV1> {
    let runtime_kind_id: String = row
        .try_get("runtime_kind_id")
        .map_err(|error| corrupt_row("session_bindings", error))?;
    Ok(SessionBindingRecordV1 {
        agent_id: durable_id(
            "session_bindings.agent_id",
            row.try_get("agent_id")
                .map_err(|error| corrupt_row("session_bindings", error))?,
            AgentIdV1::new,
        )?,
        runtime_kind_id: RuntimeKindIdV1::new(runtime_kind_id)
            .map_err(|error| corrupt_identifier("session_bindings.runtime_kind_id", error))?,
        session_id: row
            .try_get("session_id")
            .map_err(|error| corrupt_row("session_bindings", error))?,
        provider_conversation_id: row
            .try_get("provider_conversation_id")
            .map_err(|error| corrupt_row("session_bindings", error))?,
        credential_reference_id: row
            .try_get("credential_reference_id")
            .map_err(|error| corrupt_row("session_bindings", error))?,
        binding_generation: row
            .try_get("binding_generation")
            .map_err(|error| corrupt_row("session_bindings", error))?,
        bound_at_ms: row
            .try_get("bound_at_ms")
            .map_err(|error| corrupt_row("session_bindings", error))?,
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
