use super::*;
use dure_app::{AgentCancelQueuedTurnV1, AgentQueuedTurnStateV1, AgentQueuedTurnStore};

fn queued_input(index: usize) -> AgentStartTurnIntentV1 {
    AgentStartTurnIntentV1 {
        turn_id: AgentTurnIdV1::new(format!("queued-turn-{index}")).unwrap(),
        client_message_id: AgentClientMessageIdV1::new(format!("queued-input-{index}")).unwrap(),
        input: format!("Human instruction {index}"),
        ..start_turn()
    }
}

fn cancel(intent: &AgentStartTurnIntentV1) -> AgentCancelQueuedTurnV1 {
    AgentCancelQueuedTurnV1 {
        schema_version: 1,
        interaction_session_id: intent.interaction_session_id.clone(),
        client_message_id: intent.client_message_id.clone(),
    }
}

#[tokio::test]
async fn many_valid_queued_inputs_do_not_overflow_a_conversation_response() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("queue-page.sqlite")).await;
    for index in 0..70 {
        let mut input = queued_input(index);
        input.input = "한글 입력 ".repeat(4000);
        store.enqueue_agent_turn(&input).await.unwrap();
    }
    let encoded = serde_json::to_vec(&tail(&store).await).unwrap();
    // Exercise the existing native transport's 2 MiB response boundary.
    assert!(encoded.len() < 2 * 1024 * 1024, "{} bytes", encoded.len());
    let first = tail(&store).await.queued_inputs;
    assert_eq!(first.inputs.len(), 64);
    assert!(
        first
            .inputs
            .iter()
            .all(|input| input.preview.chars().count() == 512)
    );
    let rest = store
        .read_queued_agent_turns(&first.interaction_session_id, first.next_after.unwrap())
        .await
        .unwrap();
    assert_eq!(rest.inputs.len(), 6);
    assert!(rest.next_after.is_none());
    let identities = first
        .inputs
        .into_iter()
        .chain(rest.inputs)
        .map(|input| input.client_message_id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(identities.len(), 70);
    let canceled = store
        .cancel_queued_agent_turn(&cancel(&queued_input(69)), 500)
        .await
        .unwrap();
    assert_eq!(canceled.intent.input, "한글 입력 ".repeat(4000));
}

#[tokio::test]
async fn queued_input_cannot_bypass_its_execution_claim() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("queue.sqlite")).await;
    let input = queued_input(1);
    store.enqueue_agent_turn(&input).await.unwrap();
    assert!(matches!(
        store.record_agent_turn_intent(&input).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert!(tail(&store).await.active_turn.is_none());
    assert_eq!(tail(&store).await.queued_inputs.inputs.len(), 1);
}

#[tokio::test]
async fn accepted_queue_survives_reopen_and_has_one_execution_claim() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("queue.sqlite");
    let store = provision(&path).await;
    let first = queued_input(1);
    let second = queued_input(2);
    let accepted = store.enqueue_agent_turn(&first).await.unwrap();
    store.enqueue_agent_turn(&second).await.unwrap();
    assert!(tail(&store).await.active_turn.is_none());
    let cursor = tail(&store).await.final_cursor;
    assert_eq!(store.enqueue_agent_turn(&first).await.unwrap(), accepted);
    assert_eq!(tail(&store).await.final_cursor, cursor);
    let mut conflicting = first.clone();
    conflicting.input = "changed input".into();
    assert!(matches!(
        store.enqueue_agent_turn(&conflicting).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
    store.close().await;

    let left = SqliteDomainStore::open(&path).await.unwrap();
    let right = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        tail(&left)
            .await
            .queued_inputs
            .inputs
            .iter()
            .map(|item| &item.client_message_id)
            .collect::<Vec<_>>(),
        vec![&first.client_message_id, &second.client_message_id]
    );
    let (a, b) = tokio::join!(
        left.prepare_queued_agent_turn(&first.interaction_session_id, &first.runtime, 200),
        right.prepare_queued_agent_turn(&first.interaction_session_id, &first.runtime, 200),
    );
    let claims = [a.unwrap(), b.unwrap()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(claims.len(), 1);
    assert!(claims[0].newly_prepared);
    assert_eq!(
        claims[0].intent,
        AgentStartTurnIntentV1 {
            requested_at_ms: 200,
            ..first.clone()
        }
    );
    assert_eq!(
        tail(&right).await.active_turn.unwrap().turn_id,
        first.turn_id
    );
    assert_eq!(
        tail(&right).await.queued_inputs.inputs[0].preview,
        second.input
    );
    assert!(matches!(
        right.cancel_queued_agent_turn(&cancel(&first), 300).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        right.enqueue_agent_turn(&first).await.unwrap().state,
        AgentQueuedTurnStateV1::Dispatched
    );

    left.close().await;
    right.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert!(
        reopened
            .prepare_queued_agent_turn(&first.interaction_session_id, &first.runtime, 200)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        reopened
            .record_agent_turn_intent(&claims[0].intent)
            .await
            .unwrap()
            .state,
        AgentTurnEffectStateV1::Uncertain
    );
}

#[tokio::test]
async fn cancellation_is_durable_and_runtime_replacement_preserves_accepted_input() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("queue.sqlite")).await;
    let first = queued_input(1);
    let second = queued_input(2);
    store.enqueue_agent_turn(&first).await.unwrap();
    store.enqueue_agent_turn(&second).await.unwrap();
    let canceled = store
        .cancel_queued_agent_turn(&cancel(&first), 130)
        .await
        .unwrap();
    assert_eq!(canceled.state, AgentQueuedTurnStateV1::Canceled);
    assert_eq!(
        store
            .cancel_queued_agent_turn(&cancel(&first), 140)
            .await
            .unwrap(),
        canceled
    );
    assert_eq!(store.enqueue_agent_turn(&first).await.unwrap(), canceled);
    assert!(matches!(
        store.record_agent_turn_intent(&first).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: 1,
            interaction_session_id: second.interaction_session_id.clone(),
            expected_binding_revision: 1,
            source: runtime(1),
            source_execution_profile: interaction_binding().execution_profile,
            target: runtime(2),
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("conversation-1".into()),
            replaced_at_ms: 150,
        })
        .await
        .unwrap();
    assert_eq!(
        store.enqueue_agent_turn(&second).await.unwrap().state,
        AgentQueuedTurnStateV1::Queued
    );
    assert!(
        store
            .prepare_queued_agent_turn(&second.interaction_session_id, &runtime(1), 200)
            .await
            .is_err()
    );
    let prepared = store
        .prepare_queued_agent_turn(&second.interaction_session_id, &runtime(2), 200)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prepared.intent.input, second.input);
    assert_eq!(prepared.intent.client_message_id, second.client_message_id);
    assert_eq!(prepared.intent.runtime, runtime(2));
    assert_eq!(prepared.intent.requested_at_ms, 200);
    assert!(tail(&store).await.queued_inputs.inputs.is_empty());
}

#[tokio::test]
async fn schema_48_adds_queue_without_changing_existing_conversation_effects() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("queue-migration.sqlite");
    let store = provision(&path).await;
    let prior = start_turn();
    store.record_agent_turn_intent(&prior).await.unwrap();
    let before = tail(&store).await;
    store.close().await;
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    sqlx::query("DROP TABLE agent_queued_turns")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 48, min_reader_version = 48, min_writer_version = 48 WHERE singleton = 1")
        .execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        dure_app::CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(tail(&migrated).await, before);
    let replay = migrated.record_agent_turn_intent(&prior).await.unwrap();
    assert_eq!(replay.state, AgentTurnEffectStateV1::Uncertain);
    assert!(!replay.newly_prepared);
    let input = queued_input(1);
    migrated.enqueue_agent_turn(&input).await.unwrap();
    assert_eq!(
        tail(&migrated).await.queued_inputs.inputs[0].preview,
        input.input
    );
    assert!(
        migrated
            .prepare_queued_agent_turn(&input.interaction_session_id, &input.runtime, 200)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn input_inspection_reads_original_receipts_without_execution_or_mutation() {
    use dure_app::{AgentCompleteTurnEffectV1, AgentInputReceiptV1};
    let root = TempDir::new().unwrap();
    let path = root.path().join("input-inspection.sqlite");
    let store = provision(&path).await;
    let direct = start_turn();
    assert_eq!(
        store
            .inspect_agent_input(&direct.interaction_session_id, &direct.client_message_id)
            .await
            .unwrap(),
        None
    );
    let prepared = store.record_agent_turn_intent(&direct).await.unwrap();
    assert!(prepared.newly_prepared);
    let queued = queued_input(4);
    let admission = store.enqueue_agent_turn(&queued).await.unwrap();
    let before = tail(&store).await;
    for _ in 0..2 {
        let AgentInputReceiptV1::Turn { receipt } = store
            .inspect_agent_input(&direct.interaction_session_id, &direct.client_message_id)
            .await
            .unwrap()
            .unwrap()
        else {
            panic!("expected effect");
        };
        assert!(!receipt.newly_prepared);
        assert_eq!(receipt.state, AgentTurnEffectStateV1::Prepared);
        assert_eq!(receipt.intent, direct);
        assert_eq!(
            store
                .inspect_agent_input(&queued.interaction_session_id, &queued.client_message_id)
                .await
                .unwrap(),
            Some(AgentInputReceiptV1::Queued {
                receipt: admission.clone()
            })
        );
    }
    assert_eq!(tail(&store).await, before);
    let accepted = store
        .complete_agent_turn_effect(&AgentCompleteTurnEffectV1 {
            schema_version: 1,
            interaction_session_id: direct.interaction_session_id.clone(),
            runtime: direct.runtime.clone(),
            client_message_id: direct.client_message_id.clone(),
            state: AgentTurnEffectStateV1::Accepted,
            provider_receipt: Some(json!({"accepted": true})),
            updated_at_ms: 200,
        })
        .await
        .unwrap();
    let canceled = store
        .cancel_queued_agent_turn(&cancel(&queued), 201)
        .await
        .unwrap();
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .inspect_agent_input(&direct.interaction_session_id, &direct.client_message_id)
            .await
            .unwrap(),
        Some(AgentInputReceiptV1::Turn { receipt: accepted })
    );
    assert_eq!(
        reopened
            .inspect_agent_input(&queued.interaction_session_id, &queued.client_message_id)
            .await
            .unwrap(),
        Some(AgentInputReceiptV1::Queued { receipt: canceled })
    );
    let unknown = AgentInteractionSessionIdV1::new("missing-session").unwrap();
    assert!(matches!(
        reopened
            .inspect_agent_input(&unknown, &direct.client_message_id)
            .await,
        Err(DomainStoreErrorV1::NotFound { .. })
    ));
    assert!(matches!(
        reopened.read_queued_agent_turns(&unknown, 0).await,
        Err(DomainStoreErrorV1::NotFound { .. })
    ));
    reopened.close().await;
}
