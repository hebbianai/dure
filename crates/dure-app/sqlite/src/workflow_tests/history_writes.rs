use std::collections::BTreeMap;

use super::*;
use agent_orchestration::contract::{
    EventAcknowledgement, InteractionDraft, InteractionDraftCommon, OpenInteractionRequest,
};
use agent_orchestration::domain::MessagePurpose;

/// The tables an authority's orchestration history is stored in, with the
/// statement a persist writes each with. A `BEFORE INSERT` trigger fires for
/// every row an insert attempts, including one an upsert turns into an update
/// and one `DO NOTHING` skips, so the counts are rows written, not only rows
/// changed.
const HISTORY_TABLES: &[(&str, &str)] = &[
    ("workflow_interaction_authorities", "UPDATE"),
    ("workflow_interactions", "INSERT"),
    ("workflow_interaction_events", "INSERT"),
    ("workflow_interaction_deliveries", "INSERT"),
    ("workflow_interaction_idempotency", "INSERT"),
    ("workflow_interaction_acknowledgements", "INSERT"),
    ("workflow_interaction_cursors", "INSERT"),
];

/// Messages already in the authority before the counted operations. The
/// counts must not depend on it.
const HISTORY: usize = 40;

fn worker_update(context: &DispatchContextReceipt, index: usize) -> OpenInteractionRequest {
    OpenInteractionRequest {
        schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        idempotency_key: format!("history-update-{index}"),
        write_capability: context.interaction_capability.clone(),
        expected_dispatch_revision: context.dispatch_revision,
        opened_at_ms: 2_000 + i64::try_from(index).unwrap(),
        interaction: InteractionDraft::Message {
            common: InteractionDraftCommon {
                id: InteractionId::new(format!("history-update-{index}")).unwrap(),
                target: context.target.clone(),
                author: context.participant.clone(),
                audience: Audience {
                    grants: vec![context.coordinator_grant.clone()],
                },
                title: "Progress".into(),
                description_markdown: format!("Progress update {index}."),
            },
            purpose: MessagePurpose::Update,
        },
    }
}

fn coordinator_acknowledgement(
    context: &DispatchContextReceipt,
    through: EventCursor,
    idempotency_key: &str,
) -> ReadEventsRequest {
    let mut request = coordinator_event_read(context, through);
    request.acknowledgement = Some(EventAcknowledgement {
        through,
        idempotency_key: idempotency_key.into(),
        acknowledgement_capability: context.coordinator_grant.delivery_capability.clone(),
    });
    request
}

/// Observes every coordinator Event after `after` and returns the last cursor.
async fn observe_all(
    store: &SqliteDomainStore,
    context: &DispatchContextReceipt,
    mut after: EventCursor,
) -> EventCursor {
    loop {
        let read = store
            .interaction_service()
            .read_events(coordinator_event_read(context, after))
            .await
            .unwrap();
        if read.events.is_empty() {
            return after;
        }
        after = read.next_cursor;
    }
}

async fn count_history_writes(connection: &mut SqliteConnection) {
    sqlx::query(
        "CREATE TABLE history_writes (table_name TEXT PRIMARY KEY, writes INTEGER NOT NULL)",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    for (table, statement) in HISTORY_TABLES {
        sqlx::query("INSERT INTO history_writes (table_name, writes) VALUES (?1, 0)")
            .bind(table)
            .execute(&mut *connection)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TRIGGER count_{table} BEFORE {statement} ON {table} BEGIN \
             UPDATE history_writes SET writes = writes + 1 WHERE table_name = '{table}'; END"
        )))
        .execute(&mut *connection)
        .await
        .unwrap();
    }
}

/// The rows written since the last call, by table.
async fn take_history_writes(connection: &mut SqliteConnection) -> BTreeMap<String, i64> {
    let writes = sqlx::query("SELECT table_name, writes FROM history_writes WHERE writes > 0")
        .fetch_all(&mut *connection)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.get("table_name"), row.get("writes")))
        .collect();
    sqlx::query("UPDATE history_writes SET writes = 0")
        .execute(&mut *connection)
        .await
        .unwrap();
    writes
}

fn writes(expected: &[(&str, i64)]) -> BTreeMap<String, i64> {
    expected
        .iter()
        .map(|(table, count)| ((*table).to_owned(), *count))
        .collect()
}

#[tokio::test]
async fn an_orchestration_operation_writes_only_the_rows_it_adds_or_changes() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let context = prepare_orchestration_context(&store, "history-writes").await;
    let service = store.interaction_service();
    for index in 0..HISTORY {
        service.open(worker_update(&context, index)).await.unwrap();
    }
    let settled = observe_all(&store, &context, EventCursor::BEGINNING).await;
    service
        .read_events(coordinator_acknowledgement(&context, settled, "history"))
        .await
        .unwrap();
    let mut counter = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    count_history_writes(&mut counter).await;

    service
        .open(worker_update(&context, HISTORY))
        .await
        .unwrap();
    assert_eq!(
        take_history_writes(&mut counter).await,
        writes(&[
            ("workflow_interaction_authorities", 1),
            ("workflow_interaction_cursors", 1),
            ("workflow_interaction_deliveries", 1),
            ("workflow_interaction_events", 1),
            ("workflow_interaction_idempotency", 1),
            ("workflow_interactions", 1),
        ]),
        "a Message adds its interaction, Event, delivery and idempotency entry, advances the cursor \
         and moves its Dispatch row's update time to the new Event"
    );

    let latest = observe_all(&store, &context, settled).await;
    assert!(latest > settled);
    assert_eq!(
        take_history_writes(&mut counter).await,
        writes(&[("workflow_interaction_deliveries", 1)]),
        "observing the new Event changes only its delivery"
    );

    service
        .read_events(coordinator_acknowledgement(&context, latest, "latest"))
        .await
        .unwrap();
    assert_eq!(
        take_history_writes(&mut counter).await,
        writes(&[
            ("workflow_interaction_acknowledgements", 1),
            ("workflow_interaction_deliveries", 1),
        ]),
        "an acknowledgement changes the delivery it settles and records itself"
    );

    complete_orchestration_context(&store, &context, "history-writes", 3_000).await;
    assert_eq!(
        take_history_writes(&mut counter).await,
        writes(&[
            ("workflow_interaction_authorities", 1),
            ("workflow_interaction_cursors", 1),
            ("workflow_interaction_deliveries", 1),
            ("workflow_interaction_events", 1),
            ("workflow_interaction_idempotency", 1),
            ("workflow_interactions", 1),
        ]),
        "completion changes its Dispatch's row and adds its report"
    );

    let replayed = service
        .open(worker_update(&context, HISTORY))
        .await
        .unwrap();
    assert!(replayed.idempotent);
    assert_eq!(
        take_history_writes(&mut counter).await,
        BTreeMap::new(),
        "a replayed operation writes nothing"
    );
}
