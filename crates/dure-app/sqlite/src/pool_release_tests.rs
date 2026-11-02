use std::time::Duration;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;

use super::SqliteDomainStore;
use super::schema::{MAX_CONNECTIONS, release_outside_transaction};

/// The control plane drops a request future at its response deadline. A store
/// operation dropped between its `BEGIN IMMEDIATE` and its `COMMIT` or
/// `ROLLBACK` must not hand its connection back to the pool inside that
/// transaction: the write lock would block every later writer, and each later
/// `BEGIN` on that connection would fail, until the connection expired.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_transaction_does_not_strand_its_write_lock_in_the_pool() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp_dir.path().join("domain.sqlite"))
        .await
        .unwrap();

    let pool = store.pool.clone();
    let cancelled = tokio::time::timeout(Duration::from_millis(100), async move {
        let mut connection = pool.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .unwrap();
        std::future::pending::<()>().await;
    })
    .await;
    assert!(
        cancelled.is_err(),
        "the operation must be cancelled mid-transaction"
    );

    // Hold every slot at once so the cancelled operation's connection, had it
    // been returned, is among them. Each must open a write transaction well
    // within the five-second busy timeout.
    let mut connections = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        let mut connection = store.pool.acquire().await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query("BEGIN IMMEDIATE").execute(&mut *connection),
        )
        .await
        .expect("the cancelled transaction still holds the write lock")
        .expect("a pooled connection is still inside the cancelled transaction");
        sqlx::query("ROLLBACK")
            .execute(&mut *connection)
            .await
            .unwrap();
        connections.push(connection);
    }
}

#[tokio::test]
async fn release_keeps_idle_connections_and_closes_ones_inside_a_transaction() {
    let temp_dir = TempDir::new().unwrap();
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(temp_dir.path().join("release.sqlite"))
            .create_if_missing(true),
    )
    .await
    .unwrap();

    assert!(release_outside_transaction(&mut connection).await.unwrap());
    // The probe leaves an idle connection idle.
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .unwrap();

    assert!(!release_outside_transaction(&mut connection).await.unwrap());
    // The probe neither commits nor ends the transaction it found.
    sqlx::query("ROLLBACK")
        .execute(&mut connection)
        .await
        .unwrap();
}
