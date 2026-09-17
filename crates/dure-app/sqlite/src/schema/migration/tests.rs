use super::super::*;
use crate::SqliteDomainStore;
use crate::workflow_graph::{execution_schema as graph, schema as definitions};
use dure_app::DomainStore;

#[tokio::test]
async fn agent_roots_migration_preserves_unconfirmed_registration_without_inventing_membership() {
    use dure_app::{
        AgentIdV1, OperationIdV1, SessionCheckoutBindingV1, SessionCheckoutIdentityV1,
        SessionCheckoutOwnerV1,
    };
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let binding = SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            runtime_namespace: "/fixture/discovery".into(),
            owner: SessionCheckoutOwnerV1::Agent {
                agent_id: AgentIdV1::new("agent").unwrap(),
                registration_id: OperationIdV1::new("registration").unwrap(),
            },
        },
        "/fixture/checkout".into(),
        None,
    );
    let before = store.prepare_session_checkout(&binding).await.unwrap();
    for sql in [
        "DROP TABLE agent_checkout_roots",
        "UPDATE store_metadata SET schema_version = 46, min_reader_version = 46, min_writer_version = 46",
    ] {
        sqlx::query(sql).execute(&store.pool).await.unwrap();
    }
    store.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.session_checkout(&binding.identity).await.unwrap(),
        Some(before)
    );
    assert!(
        store
            .agent_checkout_roots(&binding)
            .await
            .unwrap()
            .is_empty()
    );
    let metadata = read_pool_metadata(&store.pool).await.unwrap();
    assert_eq!(
        metadata.schema_info.schema_version,
        dure_app::CURRENT_STORE_SCHEMA_VERSION
    );
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .is_empty()
    );
    store.close().await;
}

async fn v40(path: &Path) -> SqliteConnection {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
    let added = [
        crate::session_checkout::CREATE_BINDINGS,
        crate::agent_runtime_checkout::roots::CREATE_ROOTS,
        crate::agent_runtime_checkout::roots::ROOTS_BY_REGISTRATION,
        crate::agent_runtime_checkout::ADD_AGENT_CHECKOUT_OWNER,
        definitions::DEFINITIONS,
        definitions::VERSIONS,
        definitions::RECEIPTS,
        graph::SOURCES,
        graph::EFFECTS,
        graph::EVENTS,
        graph::ACTIVE_INDEX,
    ];
    for statement in CURRENT_SCHEMA_STATEMENTS {
        if added.contains(statement) {
            continue;
        }
        if *statement == graph::RUNS {
            sqlx::query(CREATE_WORKFLOW_RUNS)
                .execute(&mut connection)
                .await
                .unwrap();
        } else if *statement == graph::DISPATCHES {
            sqlx::query(CREATE_WORKFLOW_DISPATCHES_V13_TO_V16)
                .execute(&mut connection)
                .await
                .unwrap();
            // Historical stores append completion_result after the timestamps.
            sqlx::query(ADD_WORKFLOW_COMPLETION_RESULT)
                .execute(&mut connection)
                .await
                .unwrap();
        } else {
            sqlx::query(statement)
                .execute(&mut connection)
                .await
                .unwrap();
        }
    }
    for statement in [
        "INSERT INTO store_metadata (singleton, schema_version, min_reader_version, min_writer_version) VALUES (1, 40, 40, 40)",
        "INSERT INTO workflow_runs VALUES ('old-run', 'contribution', 'agent', 'session', 7, 100)",
        "INSERT INTO workflow_tasks VALUES ('old-task', 'old-run', 1, 'Review', 'Instructions', 'completed', 100, 200)",
        "INSERT INTO workflow_dispatches VALUES ('old-dispatch', 'old-task', 'codex', 'runtime.hmux', 'session', 1, 'completed', 100, 200, 'Retained report')",
        "INSERT INTO workflow_delegate_once_receipts VALUES ('old-key', 'old-digest', 'old-run', 'old-task', 'old-dispatch')",
    ] {
        sqlx::query(statement)
            .execute(&mut connection)
            .await
            .unwrap();
    }
    connection
}

#[tokio::test]
async fn workflow_graph_migration_preserves_agent_identity_results_and_references() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    v40(&path).await.close().await.unwrap();
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let row = sqlx::query("SELECT * FROM workflow_runs WHERE run_id = 'old-run'")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("coordinator_kind"), "agent");
    assert_eq!(row.get::<String, _>("coordinator_session_id"), "session");
    assert_eq!(row.get::<i64, _>("coordinator_binding_generation"), 7);
    let row = sqlx::query("SELECT * FROM workflow_dispatches WHERE dispatch_id = 'old-dispatch'")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("completion_result"), "Retained report");
    assert_eq!(row.get::<i64, _>("created_at_ms"), 100);
    assert_eq!(row.get::<i64, _>("updated_at_ms"), 200);
    assert_eq!(row.get::<String, _>("provider_id"), "codex");
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        sqlx::query("DELETE FROM workflow_runs WHERE run_id = 'old-run'")
            .execute(&store.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM workflow_dispatches WHERE dispatch_id = 'old-dispatch'")
            .execute(&store.pool)
            .await
            .is_err()
    );
    assert_eq!(
        store.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn workflow_graph_migration_rolls_back_rebuild_on_foreign_key_violation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let mut connection = v40(&path).await;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_tasks SET run_id = 'missing' WHERE task_id = 'old-task'")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    assert!(SqliteDomainStore::open(&path).await.is_err());
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    let version: i64 = sqlx::query_scalar("SELECT schema_version FROM store_metadata")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(version, 40);
    assert!(
        sqlx::query("SELECT coordinator_kind FROM workflow_runs")
            .fetch_one(&mut connection)
            .await
            .is_err()
    );
    let report: String = sqlx::query_scalar("SELECT completion_result FROM workflow_dispatches")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(report, "Retained report");
}
