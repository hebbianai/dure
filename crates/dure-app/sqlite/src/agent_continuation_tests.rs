use super::*;
use dure_app::{AgentContinueTurnRequestV1, AgentQueuedTurnStore};

async fn request(store: &SqliteDomainStore) -> AgentContinueTurnRequestV1 {
    AgentContinueTurnRequestV1 {
        intent: start_turn(),
        expected_cursor: tail(store).await.final_cursor,
    }
}

fn teammate() -> AgentStartTurnIntentV1 {
    AgentStartTurnIntentV1 {
        turn_id: AgentTurnIdV1::new("teammate-turn").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("teammate-input").unwrap(),
        input: "Use the updated brief".into(),
        ..start_turn()
    }
}

#[tokio::test]
async fn completed_teammate_turn_invalidates_retained_input() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("continuation.sqlite")).await;
    let request = request(&store).await;
    let teammate = teammate();
    store.record_agent_turn_intent(&teammate).await.unwrap();
    let mut completed = session_lifecycle(
        "teammate-done",
        AgentTimelineLifecycleStateV1::TurnCompleted,
        120,
    );
    if let AgentTimelineMutationV1::Append { item } = &mut completed {
        item.turn_id = Some(teammate.turn_id);
        item.client_message_id = Some(teammate.client_message_id);
    }
    store
        .apply_agent_provider_event(&provider_event(1, vec![completed]))
        .await
        .unwrap();
    let settled = tail(&store).await;
    assert!(settled.active_turn.is_none());
    assert_ne!(request.expected_cursor, settled.final_cursor);
    assert!(
        store
            .prepare_agent_continuation_turn(&request)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(tail(&store).await, settled);
}

#[tokio::test]
async fn queued_human_input_precedes_automatic_input_even_at_current_cursor() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("continuation.sqlite")).await;
    store.enqueue_agent_turn(&teammate()).await.unwrap();
    let request = request(&store).await;
    let before = tail(&store).await;
    assert!(before.active_turn.is_none());
    assert_eq!(before.queued_inputs.inputs.len(), 1);
    assert!(
        store
            .prepare_agent_continuation_turn(&request)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(tail(&store).await, before);
}

#[tokio::test]
async fn original_receipt_survives_advanced_cursor_queue_and_store_reopen() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("continuation.sqlite");
    let store = provision(&path).await;
    let request = request(&store).await;
    let prepared = store
        .prepare_agent_continuation_turn(&request)
        .await
        .unwrap()
        .unwrap();
    assert!(prepared.newly_prepared);
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let uncertain = reopened
        .prepare_agent_continuation_turn(&request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(uncertain.state, AgentTurnEffectStateV1::Uncertain);
    assert!(!uncertain.newly_prepared);
    store
        .complete_agent_turn_effect(&dure_app::AgentCompleteTurnEffectV1 {
            schema_version: 1,
            interaction_session_id: request.intent.interaction_session_id.clone(),
            runtime: request.intent.runtime.clone(),
            client_message_id: request.intent.client_message_id.clone(),
            state: AgentTurnEffectStateV1::Accepted,
            provider_receipt: Some(json!({"accepted": true})),
            updated_at_ms: 130,
        })
        .await
        .unwrap();
    store.enqueue_agent_turn(&teammate()).await.unwrap();
    let before = tail(&store).await;
    let replay = reopened
        .prepare_agent_continuation_turn(&request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.state, AgentTurnEffectStateV1::Accepted);
    assert!(!replay.newly_prepared);
    assert_eq!(tail(&store).await, before);
    let mut changed = request.clone();
    changed.intent.input = "Different retained input".into();
    assert!(matches!(
        reopened.prepare_agent_continuation_turn(&changed).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
}

#[tokio::test]
async fn current_cursor_does_not_override_runtime_history_or_pending_work() {
    for boundary in ["active", "pending", "history", "runtime", "epoch"] {
        let root = TempDir::new().unwrap();
        let store = provision(&root.path().join("continuation.sqlite")).await;
        match boundary {
            "active" => {
                store.record_agent_turn_intent(&teammate()).await.unwrap();
            }
            "pending" => {
                store
                    .apply_agent_provider_event(&provider_event(1, vec![]))
                    .await
                    .unwrap();
                store
                    .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
                        schema_version: 1,
                        interaction_session_id: start_turn().interaction_session_id,
                        runtime: runtime(1),
                        observed_through_sequence: 1,
                        requests: vec![pending_request()],
                        observed_at_ms: 130,
                    })
                    .await
                    .unwrap();
                assert_eq!(tail(&store).await.pending_requests.len(), 1);
            }
            "history" => {
                store
                    .record_agent_provider_gap(&AgentProviderGapV1 {
                        schema_version: 1,
                        interaction_session_id: start_turn().interaction_session_id,
                        runtime: runtime(1),
                        requested_after_sequence: 0,
                        dropped_through_sequence: 3,
                        observed_at_ms: 130,
                    })
                    .await
                    .unwrap();
                assert!(!tail(&store).await.binding.history_complete);
            }
            _ => {}
        }
        let mut request = request(&store).await;
        if boundary == "runtime" {
            request.intent.runtime = runtime(2);
        }
        if boundary == "epoch" {
            request.expected_cursor.epoch = AgentTimelineEpochV1::new("old-epoch").unwrap();
        }
        let before = tail(&store).await;
        let result = store.prepare_agent_continuation_turn(&request).await;
        if boundary == "runtime" {
            assert!(result.is_err());
        } else {
            assert!(result.unwrap().is_none(), "{boundary}");
        }
        assert_eq!(tail(&store).await, before, "{boundary}");
    }
}

#[tokio::test]
async fn queued_direction_commits_before_waiting_continuation_admission() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("continuation.sqlite");
    let mut writer = provision(&path).await;
    let observer = SqliteDomainStore::open(&path).await.unwrap();
    let request = request(&observer).await;
    writer.pool.close().await;
    writer.pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(writable_connect_options(&path))
        .await
        .unwrap();
    let (observed, observation) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let mut observed = Some(observed);
    let mut connection = writer.pool.acquire().await.unwrap();
    connection
        .lock_handle()
        .await
        .unwrap()
        .set_update_hook(move |update| {
            if update.table == "agent_queued_turns" {
                if let Some(observed) = observed.take() {
                    let _ = observed.send(());
                    let _ = released.recv();
                }
            }
        });
    drop(connection);
    let queued = tokio::spawn(async move { writer.enqueue_agent_turn(&teammate()).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), observation)
        .await
        .unwrap()
        .unwrap();
    let continuation = observer.prepare_agent_continuation_turn(&request);
    tokio::pin!(continuation);
    tokio::select! {
        result = &mut continuation => panic!("admitted before the queue transaction settled: {result:?}"),
        () = tokio::task::yield_now() => {}
    }
    release.send(()).unwrap();
    queued.await.unwrap().unwrap();
    assert!(continuation.await.unwrap().is_none());
    let page = tail(&observer).await;
    assert!(page.active_turn.is_none());
    assert_eq!(page.queued_inputs.inputs.len(), 1);
}
