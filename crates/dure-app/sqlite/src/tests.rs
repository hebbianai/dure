use std::path::{Path, PathBuf};
use std::sync::Arc;

use dure_app::{
    AgentIdV1, AgentRecordV1, CURRENT_STORE_SCHEMA_VERSION, CURRENT_STORE_WRITER_VERSION,
    DomainStore, DomainStoreErrorV1, OperationEventBodyV1, OperationEventIdV1, OperationEventV1,
    OperationIdV1, OperationReceiptStateV1, ProjectIdV1, ProjectRecordV1, ProviderIdV1, ReviewIdV1,
    ReviewTargetRecordV1, ReviewTargetRetentionPolicyV1, ReviewTargetRootSnapshotV1,
    RuntimeKindIdV1, SessionBindingRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;
use tokio::sync::Barrier;

use super::SqliteDomainStore;
use super::schema::{
    CREATE_METADATA, CREATE_PLUGIN_NATIVE_TARGET_BINDINGS, V1_SCHEMA_STATEMENTS,
    V2_SCHEMA_STATEMENTS, V3_SCHEMA_STATEMENTS, V4_SCHEMA_STATEMENTS, V5_SCHEMA_STATEMENTS,
    V6_SCHEMA_STATEMENTS, V7_SCHEMA_STATEMENTS, V8_SCHEMA_STATEMENTS,
    downgrade_workflow_launch_fixture_to_v31, execute_statements, is_recoverable_backup,
    read_metadata, writable_connect_options,
};

fn database_path(temp_dir: &TempDir) -> PathBuf {
    temp_dir.path().join("domain.sqlite")
}

fn project() -> ProjectRecordV1 {
    ProjectRecordV1 {
        project_id: ProjectIdV1::new("project-1").unwrap(),
        root_path: "/workspace/project".into(),
        display_name: "Project".into(),
        created_at_ms: 10,
        updated_at_ms: 10,
    }
}

fn workspace() -> WorkspaceRecordV1 {
    WorkspaceRecordV1 {
        workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
        project_id: ProjectIdV1::new("project-1").unwrap(),
        root_path: "/workspace/project/.worktrees/agent-1".into(),
        base_commit_sha: Some("0123456789abcdef".into()),
        created_at_ms: 20,
        updated_at_ms: 20,
    }
}

fn agent() -> AgentRecordV1 {
    AgentRecordV1 {
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
        provider_id: ProviderIdV1::new("provider.codex").unwrap(),
        display_name: "Codex".into(),
        created_at_ms: 30,
        updated_at_ms: 30,
    }
}

fn binding(generation: i64) -> SessionBindingRecordV1 {
    SessionBindingRecordV1 {
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        session_id: format!("session-{generation}"),
        provider_conversation_id: Some(format!("conversation-{generation}")),
        credential_reference_id: Some("credential.crispy".into()),
        binding_generation: generation,
        bound_at_ms: 30 + generation,
    }
}

fn review_target() -> ReviewTargetRecordV1 {
    ReviewTargetRecordV1 {
        review_id: ReviewIdV1::new("review-1").unwrap(),
        worktree_path: "/workspace/project/.worktrees/agent-1".into(),
        worktree_git_dir: "/workspace/project/.git/worktrees/agent-1".into(),
        base_ref: "origin/main".into(),
        base_commit_sha: "a".repeat(40),
        head_commit_sha: "b".repeat(40),
        source_session_id: Some("session-1".into()),
        feedback_agent_id: Some(AgentIdV1::new("agent-1").unwrap()),
        created_at_ms: 40,
    }
}

fn review_target_at(review_id: &str, created_at_ms: i64) -> ReviewTargetRecordV1 {
    let mut target = review_target();
    target.review_id = ReviewIdV1::new(review_id).unwrap();
    target.created_at_ms = created_at_ms;
    target
}

fn retention_policy(
    inactive_retention_ms: i64,
    max_inactive_targets: u32,
) -> ReviewTargetRetentionPolicyV1 {
    ReviewTargetRetentionPolicyV1 {
        inactive_retention_ms,
        max_inactive_targets,
    }
}

fn roots(active_review_ids: &[&str], observed_at_ms: i64) -> ReviewTargetRootSnapshotV1 {
    ReviewTargetRootSnapshotV1 {
        active_review_ids: active_review_ids
            .iter()
            .map(|review_id| ReviewIdV1::new(*review_id).unwrap())
            .collect(),
        observed_at_ms,
    }
}

fn event(
    event_id: &str,
    operation_id: &str,
    sequence: i64,
    body: OperationEventBodyV1,
) -> OperationEventV1 {
    OperationEventV1 {
        event_id: OperationEventIdV1::new(event_id).unwrap(),
        operation_id: OperationIdV1::new(operation_id).unwrap(),
        sequence,
        body,
        created_at_ms: 100 + sequence,
    }
}

fn started(event_id: &str, operation_id: &str, idempotency_key: &str) -> OperationEventV1 {
    event(
        event_id,
        operation_id,
        1,
        OperationEventBodyV1::Started {
            idempotency_key: idempotency_key.into(),
            operation_kind: "agent.create".into(),
        },
    )
}

async fn fixture_connection(path: &Path) -> SqliteConnection {
    SqliteConnection::connect_with(&writable_connect_options(path))
        .await
        .unwrap()
}

async fn create_v1_fixture(path: &Path, with_events: bool) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V1_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 1, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();

    if with_events {
        for fixture_event in [
            started("event-1", "operation-1", "request-1"),
            event(
                "event-2",
                "operation-1",
                2,
                OperationEventBodyV1::Succeeded {
                    result_code: Some("created".into()),
                },
            ),
        ] {
            sqlx::query(
                r#"
                INSERT INTO operation_events (
                    event_id, operation_id, sequence, body_json, created_at_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
            )
            .bind(fixture_event.event_id.as_str())
            .bind(fixture_event.operation_id.as_str())
            .bind(fixture_event.sequence)
            .bind(serde_json::to_string(&fixture_event.body).unwrap())
            .bind(fixture_event.created_at_ms)
            .execute(&mut connection)
            .await
            .unwrap();
        }
    }

    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_v2_fixture(path: &Path) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V2_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 2, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_v3_fixture(path: &Path, target: &ReviewTargetRecordV1) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V3_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 3, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
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
    .bind(target.review_id.as_str())
    .bind(&target.worktree_path)
    .bind(&target.worktree_git_dir)
    .bind(&target.base_ref)
    .bind(&target.base_commit_sha)
    .bind(&target.head_commit_sha)
    .bind(&target.source_session_id)
    .bind(target.feedback_agent_id.as_ref().map(AgentIdV1::as_str))
    .bind(target.created_at_ms)
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_v4_fixture(path: &Path) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V4_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 4, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_v5_fixture(path: &Path) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V5_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 5, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_v6_fixture(path: &Path) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V6_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 6, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_v7_fixture(path: &Path) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V7_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 7, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_v8_fixture(path: &Path, native_target_only: bool) {
    let mut connection = fixture_connection(path).await;
    execute_statements(&mut connection, V8_SCHEMA_STATEMENTS, "test_fixture")
        .await
        .unwrap();
    if native_target_only {
        execute_statements(
            &mut connection,
            &[
                "DROP TABLE agent_checkpoint_receipts",
                "DROP TABLE agent_checkpoints",
                CREATE_PLUGIN_NATIVE_TARGET_BINDINGS,
            ],
            "test_fixture",
        )
        .await
        .unwrap();
    } else {
        execute_statements(
            &mut connection,
            &[
                "INSERT INTO projects VALUES ('project-v8', '/project-v8', 'Project v8', 1, 1)",
                "INSERT INTO workspaces VALUES ('workspace-v8', 'project-v8', '/project-v8/worktree', NULL, 2, 2)",
                "INSERT INTO agents VALUES ('agent-v8', 'workspace-v8', 'provider.codex', 'Agent v8', 3, 3)",
                "INSERT INTO agent_checkpoints VALUES ('agent-v8', 1, 'checkpoint-v8', 1, 'session-v8', 1, 4)",
            ],
            "test_fixture",
        )
        .await
        .unwrap();
    }
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, 8, 1, 1)
        "#,
    )
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn create_metadata_fixture(
    path: &Path,
    schema_version: u32,
    min_reader_version: u32,
    min_writer_version: u32,
) {
    let mut connection = fixture_connection(path).await;
    sqlx::query(CREATE_METADATA)
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO store_metadata (
            singleton, schema_version, min_reader_version, min_writer_version
        ) VALUES (1, ?1, ?2, ?3)
        "#,
    )
    .bind(i64::from(schema_version))
    .bind(i64::from(min_reader_version))
    .bind(i64::from(min_writer_version))
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn mark_interrupted_migration(path: &Path, backup_path: &Path) {
    let mut connection = fixture_connection(path).await;
    sqlx::query(
        r#"
        UPDATE store_metadata SET
            migration_from_version = 1,
            migration_to_version = 2,
            migration_backup_path = ?1
        WHERE singleton = 1
        "#,
    )
    .bind(backup_path.to_str().unwrap())
    .execute(&mut connection)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

#[tokio::test]
async fn fresh_store_round_trips_records_and_events_transactionally() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let store = SqliteDomainStore::open(&path).await.unwrap();

    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );

    let project = project();
    let workspace = workspace();
    let agent = agent();
    let binding = binding(1);
    let review_target = review_target();
    store.upsert_project(&project).await.unwrap();
    store.upsert_workspace(&workspace).await.unwrap();
    store.upsert_agent(&agent).await.unwrap();
    store.upsert_session_binding(&binding).await.unwrap();
    store.create_review_target(&review_target).await.unwrap();

    assert_eq!(
        store.project(&project.project_id).await.unwrap(),
        Some(project.clone())
    );
    assert_eq!(
        store.workspace(&workspace.workspace_id).await.unwrap(),
        Some(workspace.clone())
    );
    assert_eq!(
        store.agent(&agent.agent_id).await.unwrap(),
        Some(agent.clone())
    );
    assert_eq!(
        store.session_binding(&agent.agent_id).await.unwrap(),
        Some(binding)
    );
    assert_eq!(
        store.review_target(&review_target.review_id).await.unwrap(),
        Some(review_target.clone())
    );

    let started = started("event-1", "operation-1", "request-1");
    let receipt = store.append_operation_event(&started).await.unwrap();
    assert_eq!(receipt.last_sequence, 1);
    assert_eq!(receipt.state, OperationReceiptStateV1::Running);

    let invalid_gap = event(
        "event-3",
        "operation-1",
        3,
        OperationEventBodyV1::Succeeded {
            result_code: Some("created".into()),
        },
    );
    assert!(matches!(
        store.append_operation_event(&invalid_gap).await,
        Err(DomainStoreErrorV1::InvalidEventStream { .. })
    ));
    assert_eq!(
        store
            .operation_receipt(&started.operation_id)
            .await
            .unwrap()
            .unwrap()
            .last_sequence,
        1
    );

    let progressed = event(
        "event-2",
        "operation-1",
        2,
        OperationEventBodyV1::Progressed {
            stage: "worktree.ready".into(),
        },
    );
    store.append_operation_event(&progressed).await.unwrap();
    let receipt = store.append_operation_event(&invalid_gap).await.unwrap();
    assert_eq!(receipt.state, OperationReceiptStateV1::Succeeded);
    assert_eq!(receipt.last_sequence, 3);

    let replay_receipt = store.append_operation_event(&started).await.unwrap();
    assert_eq!(replay_receipt, receipt);

    let conflicting_replay = event(
        "event-2",
        "operation-1",
        2,
        OperationEventBodyV1::Progressed {
            stage: "runtime.ready".into(),
        },
    );
    assert!(matches!(
        store.append_operation_event(&conflicting_replay).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));

    sqlx::query("DELETE FROM operation_receipts")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .operation_receipt(&started.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.rebuild_operation_receipts().await.unwrap(), 1);
    assert_eq!(
        store
            .operation_receipt(&started.operation_id)
            .await
            .unwrap(),
        Some(receipt)
    );

    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened.project(&project.project_id).await.unwrap(),
        Some(project)
    );
    assert_eq!(
        reopened
            .review_target(&review_target.review_id)
            .await
            .unwrap(),
        Some(review_target)
    );
}

#[tokio::test]
async fn immutable_core_identity_and_binding_generations_fail_explicitly() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let project = project();
    let workspace = workspace();
    let agent = agent();
    store.upsert_project(&project).await.unwrap();
    store.upsert_workspace(&workspace).await.unwrap();
    store.upsert_agent(&agent).await.unwrap();
    store.upsert_session_binding(&binding(2)).await.unwrap();
    let review_target = review_target();
    store.create_review_target(&review_target).await.unwrap();
    store.create_review_target(&review_target).await.unwrap();

    let mut newer_project = project.clone();
    newer_project.display_name = "Newer project".into();
    newer_project.updated_at_ms = 20;
    store.upsert_project(&newer_project).await.unwrap();

    let mut stale_project = project.clone();
    stale_project.display_name = "Stale project".into();
    stale_project.updated_at_ms = 15;
    assert!(matches!(
        store.upsert_project(&stale_project).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "project",
            ..
        })
    ));

    let mut conflicting_project = project.clone();
    conflicting_project.created_at_ms += 1;
    conflicting_project.updated_at_ms += 1;
    assert!(matches!(
        store.upsert_project(&conflicting_project).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "project",
            ..
        })
    ));
    assert!(matches!(
        store.upsert_session_binding(&binding(1)).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "session_binding",
            ..
        })
    ));
    let mut time_traveling_binding = binding(3);
    time_traveling_binding.bound_at_ms = binding(2).bound_at_ms - 1;
    assert!(matches!(
        store.upsert_session_binding(&time_traveling_binding).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "session_binding",
            ..
        })
    ));

    let mut conflicting_review = review_target;
    conflicting_review.base_commit_sha = "c".repeat(40);
    assert!(matches!(
        store.create_review_target(&conflicting_review).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "review_target",
            ..
        })
    ));
}

#[tokio::test]
async fn previous_schema_is_backed_up_migrated_and_projected() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v1_fixture(&path, true).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let receipt = store
        .operation_receipt(&OperationIdV1::new("operation-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, OperationReceiptStateV1::Succeeded);

    let backups = std::fs::read_dir(temp_dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|candidate| {
            candidate
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".bak"))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        backups.len(),
        usize::try_from(CURRENT_STORE_SCHEMA_VERSION - 1).unwrap()
    );
    assert!(backups.iter().all(|path| is_recoverable_backup(path)));

    let v1_backup = backups
        .iter()
        .find(|path| path.to_string_lossy().contains("schema-1-to-2"))
        .unwrap();
    let options = SqliteConnectOptions::new()
        .filename(v1_backup)
        .read_only(true);
    let mut backup = SqliteConnection::connect_with(&options).await.unwrap();
    assert_eq!(
        read_metadata(&mut backup)
            .await
            .unwrap()
            .schema_info
            .schema_version,
        1
    );
}

#[tokio::test]
async fn schema_24_migrates_legacy_agent_provider_ids_to_hmux_provider_ids() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    store.upsert_project(&project()).await.unwrap();
    store.upsert_workspace(&workspace()).await.unwrap();
    let mut legacy_agent = agent();
    legacy_agent.provider_id = ProviderIdV1::new("provider.claude").unwrap();
    store.upsert_agent(&legacy_agent).await.unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&store.pool).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 24, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    let projected = migrated
        .agent(&legacy_agent.agent_id)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(projected.provider_id.as_str(), "claude");
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn schema_two_migrates_additively_to_review_targets() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v2_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let target = review_target();
    store.create_review_target(&target).await.unwrap();
    assert_eq!(
        store.review_target(&target.review_id).await.unwrap(),
        Some(target)
    );
}

#[tokio::test]
async fn schema_three_migrates_existing_reviews_as_inactive_until_layout_reconciliation() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let target = review_target_at("review-migrated", 40);
    create_v3_fixture(&path, &target).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let lifecycle: (Option<i64>, i64) = sqlx::query_as(
        r#"
        SELECT inactive_since_ms, observed_at_ms
        FROM review_target_lifecycle
        WHERE review_id = ?1
        "#,
    )
    .bind(target.review_id.as_str())
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(lifecycle, (Some(40), 40));

    store
        .reconcile_review_target_roots(&roots(&["review-migrated"], 100), &retention_policy(10, 1))
        .await
        .unwrap();
    let inactive_since_ms: Option<i64> = sqlx::query_scalar(
        "SELECT inactive_since_ms FROM review_target_lifecycle WHERE review_id = ?1",
    )
    .bind(target.review_id.as_str())
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(inactive_since_ms, None);
    assert_eq!(
        store.review_target(&target.review_id).await.unwrap(),
        Some(target)
    );
}

#[tokio::test]
async fn schema_four_migrates_additively_to_plugin_apply_journal_tables() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v4_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('plugin_apply_events', 'plugin_apply_receipts')
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(table_count, 2);
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn schema_five_migrates_additively_to_native_ownership_tables() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v5_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
              'plugin_native_ownership_events',
              'plugin_native_ownership'
          )
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(table_count, 2);
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn schema_six_migrates_plugin_apply_receipts_for_compensated_state() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v6_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let table_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plugin_apply_receipts'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(table_sql.contains("'compensated'"));
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn schema_seven_migrates_additively_to_complete_authority_tables() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v7_fixture(&path).await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let table_count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
              'agent_checkpoints',
              'agent_checkpoint_receipts',
              'plugin_native_target_bindings'
          )
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(table_count, 3);
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn divergent_schema_eight_authority_shapes_converge_to_schema_nine() {
    for native_target_only in [false, true] {
        let temp_dir = TempDir::new().unwrap();
        let path = database_path(&temp_dir);
        create_v8_fixture(&path, native_target_only).await;

        let store = SqliteDomainStore::open(&path).await.unwrap();
        let table_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM sqlite_master
            WHERE type = 'table'
              AND name IN (
                  'agent_checkpoints',
                  'agent_checkpoint_receipts',
                  'plugin_native_target_bindings'
              )
            "#,
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(table_count, 3);
        if !native_target_only {
            let checkpoint_text: String = sqlx::query_scalar(
                "SELECT checkpoint_text FROM agent_checkpoints WHERE agent_id = 'agent-v8'",
            )
            .fetch_one(&store.pool)
            .await
            .unwrap();
            assert_eq!(checkpoint_text, "checkpoint-v8");
        }
        assert_eq!(
            store.schema_info().schema_version,
            CURRENT_STORE_SCHEMA_VERSION
        );
    }
}

#[tokio::test]
async fn review_target_sweep_deletes_only_old_inactive_records_beyond_the_cap() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    for (review_id, created_at_ms) in [
        ("review-active", 10),
        ("review-old-a", 20),
        ("review-old-b", 30),
        ("review-young-a", 90),
        ("review-young-b", 95),
    ] {
        store
            .create_review_target(&review_target_at(review_id, created_at_ms))
            .await
            .unwrap();
    }

    let first = store
        .reconcile_review_target_roots(&roots(&["review-active"], 100), &retention_policy(20, 1))
        .await
        .unwrap();
    assert_eq!(first.active_targets, 1);
    assert_eq!(first.inactive_targets, 2);
    assert_eq!(first.deleted_targets, 2);
    for review_id in ["review-active", "review-young-a", "review-young-b"] {
        assert!(
            store
                .review_target(&ReviewIdV1::new(review_id).unwrap())
                .await
                .unwrap()
                .is_some()
        );
    }

    let second = store
        .reconcile_review_target_roots(&roots(&["review-active"], 200), &retention_policy(20, 1))
        .await
        .unwrap();
    assert_eq!(second.active_targets, 1);
    assert_eq!(second.inactive_targets, 1);
    assert_eq!(second.deleted_targets, 1);
    assert!(
        store
            .review_target(&ReviewIdV1::new("review-active").unwrap())
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_equal_time_reconciliation_fails_safe_toward_an_active_root() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    first_store
        .create_review_target(&review_target_at("review-raced", 10))
        .await
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let active = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store
            .reconcile_review_target_roots(&roots(&["review-raced"], 100), &retention_policy(1, 1))
            .await
    });
    let second_barrier = Arc::clone(&barrier);
    let inactive = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store
            .reconcile_review_target_roots(&roots(&[], 100), &retention_policy(1, 1))
            .await
    });

    barrier.wait().await;
    active.await.unwrap().unwrap();
    inactive.await.unwrap().unwrap();

    let store = SqliteDomainStore::open(&path).await.unwrap();
    let lifecycle: (Option<i64>, i64) = sqlx::query_as(
        r#"
        SELECT inactive_since_ms, observed_at_ms
        FROM review_target_lifecycle
        WHERE review_id = 'review-raced'
        "#,
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(lifecycle, (None, 100));

    // A delayed stale close and an identical retry cannot reverse the active
    // state or delete the immutable target.
    store
        .reconcile_review_target_roots(&roots(&[], 99), &retention_policy(1, 1))
        .await
        .unwrap();
    store
        .reconcile_review_target_roots(&roots(&["review-raced"], 100), &retention_policy(1, 1))
        .await
        .unwrap();
    assert!(
        store
            .review_target(&ReviewIdV1::new("review-raced").unwrap())
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn newer_schema_fails_closed_without_changing_database_bytes() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_metadata_fixture(
        &path,
        CURRENT_STORE_SCHEMA_VERSION + 1,
        CURRENT_STORE_SCHEMA_VERSION + 1,
        CURRENT_STORE_SCHEMA_VERSION + 1,
    )
    .await;
    let before = std::fs::read(&path).unwrap();

    let error = match SqliteDomainStore::open(&path).await {
        Ok(_) => panic!("newer schema unexpectedly opened"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        DomainStoreErrorV1::Compatibility {
            code: "reader_too_old",
            ..
        }
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn newer_writer_requirement_fails_closed_without_changing_database_bytes() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_metadata_fixture(
        &path,
        CURRENT_STORE_SCHEMA_VERSION,
        1,
        CURRENT_STORE_WRITER_VERSION + 1,
    )
    .await;
    let before = std::fs::read(&path).unwrap();

    let error = match SqliteDomainStore::open(&path).await {
        Ok(_) => panic!("newer writer requirement unexpectedly opened"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        DomainStoreErrorV1::Compatibility {
            code: "writer_too_old",
            ..
        }
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn interrupted_migration_resumes_only_with_a_recoverable_backup() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v1_fixture(&path, true).await;
    let backup_path = temp_dir.path().join("interrupted-v1.bak");
    std::fs::copy(&path, &backup_path).unwrap();
    mark_interrupted_migration(&path, &backup_path).await;

    let preflight_error = SqliteDomainStore::preflight(&path).await.unwrap_err();
    assert!(matches!(
        preflight_error,
        DomainStoreErrorV1::InterruptedMigration {
            from_version: 1,
            to_version: 2,
            ..
        }
    ));

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert!(
        store
            .operation_receipt(&OperationIdV1::new("operation-1").unwrap())
            .await
            .unwrap()
            .is_some()
    );

    let missing_path = temp_dir.path().join("missing.sqlite");
    create_v1_fixture(&missing_path, false).await;
    let missing_backup = temp_dir.path().join("missing-v1.bak");
    mark_interrupted_migration(&missing_path, &missing_backup).await;
    let error = match SqliteDomainStore::open(&missing_path).await {
        Ok(_) => panic!("migration without a backup unexpectedly resumed"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        DomainStoreErrorV1::InterruptedMigration {
            from_version: 1,
            to_version: 2,
            ..
        }
    ));

    let mut connection = fixture_connection(&missing_path).await;
    let metadata = read_metadata(&mut connection).await.unwrap();
    assert_eq!(metadata.schema_info.schema_version, 1);
    assert!(metadata.migration.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_previous_schema_opens_converge_on_current_schema() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    create_v1_fixture(&path, true).await;

    let first_path = path.clone();
    let second_path = path.clone();
    let (first, second) = tokio::join!(
        SqliteDomainStore::open(first_path),
        SqliteDomainStore::open(second_path)
    );

    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(
        first.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        second.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writers_serialize_idempotency_key_ownership() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let first_store = SqliteDomainStore::open(&path).await.unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store
            .append_operation_event(&started("event-a", "operation-a", "shared-request"))
            .await
    });
    let second_barrier = Arc::clone(&barrier);
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store
            .append_operation_event(&started("event-b", "operation-b", "shared-request"))
            .await
    });

    barrier.wait().await;
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(DomainStoreErrorV1::IdempotencyConflict { .. })))
            .count(),
        1
    );
}
