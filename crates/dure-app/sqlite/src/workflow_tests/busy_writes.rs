use super::*;
use agent_orchestration::contract::{EventAcknowledgement, ServiceError};

/// Short waits over a long window: the test releases the lock while the
/// acknowledgement waits, a slow machine cannot exhaust the schedule before
/// that release is visible, and the write resumes soon after it.
const RETRY_UNTIL_RELEASED: &[Duration] = &[Duration::from_millis(25); 400];

/// Exhausts quickly, so a lock held past the bound surfaces as a busy store.
const RETRY_BRIEFLY: &[Duration] = &[Duration::from_millis(10), Duration::from_millis(10)];

/// How long an acknowledgement must stay pending while another connection
/// holds the write lock. With a zero busy timeout, one that does not retry
/// fails well within this.
const STILL_WAITING: Duration = Duration::from_millis(250);

/// A completed Dispatch whose coordinator Events were observed, and the
/// coordinator's acknowledgement through the last of them.
async fn observed_events_acknowledgement(
    store: &SqliteDomainStore,
    suffix: &str,
) -> (DispatchContextReceipt, ReadEventsRequest) {
    let context = prepare_orchestration_context(store, suffix).await;
    complete_orchestration_context(store, &context, suffix, 1_900).await;
    let observed = store
        .interaction_service()
        .read_events(coordinator_event_read(&context, EventCursor::BEGINNING))
        .await
        .unwrap();
    let mut acknowledge = coordinator_event_read(&context, observed.next_cursor);
    acknowledge.acknowledgement = Some(EventAcknowledgement {
        through: observed.events.last().unwrap().cursor,
        idempotency_key: format!("ack-{suffix}"),
        acknowledgement_capability: context.coordinator_grant.delivery_capability.clone(),
    });
    (context, acknowledge)
}

#[tokio::test]
async fn a_busy_event_acknowledgement_waits_for_the_writer_and_commits_once() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let (context, acknowledge) = observed_events_acknowledgement(&store, "busy-ack").await;
    let other = store.contending_writer(RETRY_UNTIL_RELEASED).await;
    let service = other.interaction_service();
    let mut writer = held_writer(&path).await;
    let mut acknowledgement = Box::pin(service.read_events(acknowledge));

    assert!(
        tokio::time::timeout(STILL_WAITING, acknowledgement.as_mut())
            .await
            .is_err(),
        "an acknowledgement that finds the write lock held must wait, not fail"
    );
    assert_eq!(
        stored_coordinator_delivery_state(&mut writer, &context).await,
        DeliveryState::Observed
    );
    sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();

    let receipt = tokio::time::timeout(READ_HANG_DEADLINE, acknowledgement)
        .await
        .expect("the acknowledgement must resume after the writer releases")
        .unwrap();
    let acknowledged = receipt.acknowledgement.unwrap();
    assert!(!acknowledged.idempotent);
    assert_eq!(acknowledged.delivery.state, DeliveryState::Acknowledged);
    assert_eq!(
        stored_coordinator_delivery_state(&mut writer, &context).await,
        DeliveryState::Acknowledged
    );
}

#[tokio::test]
async fn a_lock_held_past_the_retry_bound_reports_a_busy_store_and_acknowledges_nothing() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let (context, acknowledge) = observed_events_acknowledgement(&store, "busy-bound").await;
    let other = store.contending_writer(RETRY_BRIEFLY).await;
    let mut writer = held_writer(&path).await;

    let refused = other
        .interaction_service()
        .read_events(acknowledge.clone())
        .await;
    assert_eq!(
        refused,
        Err(ServiceError::StorageUnavailable {
            code: "adapter_busy"
        })
    );
    assert_eq!(
        stored_coordinator_delivery_state(&mut writer, &context).await,
        DeliveryState::Observed
    );
    sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();

    // The refused attempt wrote nothing, so the same request is the first
    // acknowledgement rather than a replay.
    let receipt = other
        .interaction_service()
        .read_events(acknowledge)
        .await
        .unwrap();
    assert!(!receipt.acknowledgement.unwrap().idempotent);
    assert_eq!(
        stored_coordinator_delivery_state(&mut writer, &context).await,
        DeliveryState::Acknowledged
    );
}
