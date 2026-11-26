use std::time::Duration;

use super::*;

/// Short waits over a long window: the test releases the lock while the write
/// waits, a slow machine cannot exhaust the schedule before that release is
/// visible, and the write resumes soon after it.
const RETRY_UNTIL_RELEASED: &[Duration] = &[Duration::from_millis(25); 400];

/// Exhausts quickly, so a lock held past the bound surfaces as `Busy`.
const RETRY_BRIEFLY: &[Duration] = &[Duration::from_millis(10), Duration::from_millis(10)];

/// How long a spawn journal write must stay pending while another connection
/// holds the write lock. With a zero busy timeout, one that does not retry
/// fails well within this.
const STILL_WAITING: Duration = Duration::from_millis(250);

async fn stored_event_count(store: &SqliteDomainStore) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM agent_spawn_events")
        .fetch_one(&store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_busy_stage_append_waits_for_the_writer_and_records_once() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let plan = spawn_plan("spawn-busy", "spawn-busy", false);
    let events = successful_events(&plan);
    store.append_agent_spawn_event(&events[0]).await.unwrap();
    let other = store.contending_writer(RETRY_UNTIL_RELEASED).await;
    let lock = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let mut append = other.append_agent_spawn_event(&events[1]);

    assert!(
        tokio::time::timeout(STILL_WAITING, append.as_mut())
            .await
            .is_err(),
        "a stage that finds the write lock held must wait, not fail the Run"
    );
    // Roll back explicitly: dropping the transaction releases the write lock
    // asynchronously, after the caller has moved on.
    lock.rollback().await.unwrap();
    let receipt = append.await.unwrap();
    assert_eq!(receipt.last_sequence, 2);
    assert_eq!(stored_event_count(&store).await, 2);
    assert_eq!(
        store.agent_spawn_receipt(&plan.operation_id).await.unwrap(),
        Some(receipt)
    );
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn a_lock_held_past_the_retry_bound_reports_busy_and_records_nothing() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(database_path(&temp_dir))
        .await
        .unwrap();
    let plan = spawn_plan("spawn-held", "spawn-held", false);
    let events = successful_events(&plan);
    store.append_agent_spawn_event(&events[0]).await.unwrap();
    let other = store.contending_writer(RETRY_BRIEFLY).await;
    let lock = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();

    assert!(matches!(
        other.append_agent_spawn_event(&events[1]).await,
        Err(DomainStoreErrorV1::Busy {
            operation: "append_agent_spawn_event"
        })
    ));
    lock.rollback().await.unwrap();
    assert_eq!(stored_event_count(&store).await, 1);
    // The refused stage was not recorded, so the same event is still next.
    assert_eq!(
        other
            .append_agent_spawn_event(&events[1])
            .await
            .unwrap()
            .last_sequence,
        2
    );
    other.close().await;
    store.close().await;
}
