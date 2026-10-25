use agent_orchestration::contract::DeliveryReceipt;

use super::*;

/// An unread delivery whose last wake proved that nothing was written, with
/// the exact worker Session currently bound to its Dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedOrchestrationWakeV1 {
    pub session: WorkflowSessionGenerationV1,
    pub delivery: DeliveryReceipt,
    pub opened_at_ms: i64,
}

/// Rediscover queued wakes from SQLite on every call, including after a
/// restart. A completed Dispatch still qualifies: its worker can receive
/// updates. Only the listed refusal reasons qualify: they name a target that
/// was not ready yet, not one that can never take a prompt.
pub(crate) async fn queued(
    pool: &SqlitePool,
    reason_codes: &[&str],
    queued_before_ms: i64,
    opened_after_ms: i64,
    limit: u32,
) -> Result<Vec<QueuedOrchestrationWakeV1>, DomainStoreErrorV1> {
    if reason_codes.is_empty() {
        return Ok(Vec::new());
    }
    let reasons = vec!["?"; reason_codes.len()].join(", ");
    let query = format!(
        "SELECT authority.worker_session_json,
                json_extract(delivery.delivery_json, '$.receipt') AS receipt_json,
                json_extract(event.event_json, '$.recordedAtMs') AS opened_at_ms
         FROM workflow_interaction_deliveries AS delivery
         JOIN workflow_interaction_authorities AS authority
           ON authority.authority_key = delivery.authority_key
         JOIN workflow_interaction_events AS event
           ON event.authority_key = delivery.authority_key AND event.cursor = delivery.event_cursor
         WHERE json_extract(delivery.delivery_json, '$.receipt.state') = 'queued'
           AND json_extract(delivery.delivery_json, '$.receipt.wake.state') = 'queued_until_next_turn'
           AND json_extract(delivery.delivery_json, '$.receipt.wake.reasonCode') IN ({reasons})
           AND json_extract(delivery.delivery_json, '$.receipt.wake.updatedAtMs') <= ?
           AND json_extract(event.event_json, '$.recordedAtMs') >= ?
         ORDER BY json_extract(delivery.delivery_json, '$.receipt.wake.updatedAtMs')
         LIMIT ?"
    );
    let mut statement = sqlx::query(&query);
    for reason_code in reason_codes {
        statement = statement.bind(*reason_code);
    }
    statement
        .bind(queued_before_ms)
        .bind(opened_after_ms)
        .bind(i64::from(limit))
        .fetch_all(pool)
        .await
        .map_err(|error| map_sqlx("read_queued_orchestration_wakes", error))?
        .into_iter()
        .map(|row| {
            let column = |name| {
                row.try_get::<String, _>(name).map_err(|error| {
                    storage("corrupt_queued_orchestration_wake", error.to_string())
                })
            };
            Ok(QueuedOrchestrationWakeV1 {
                session: decode_domain(
                    column("worker_session_json")?,
                    "orchestration worker Session",
                )?,
                delivery: decode_domain(column("receipt_json")?, "orchestration delivery receipt")?,
                opened_at_ms: row.try_get("opened_at_ms").map_err(|error| {
                    storage("corrupt_queued_orchestration_wake", error.to_string())
                })?,
            })
        })
        .collect()
}
