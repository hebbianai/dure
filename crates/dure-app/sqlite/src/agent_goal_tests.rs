use super::*;
use dure_app::{AgentGoalPutRequestV1, AgentGoalStatusV1, AgentGoalStore, AgentGoalTurnRequestV1};

#[tokio::test]
async fn accepted_human_queue_precedes_an_automatic_goal_turn() {
    use dure_app::AgentQueuedTurnStore;
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("store.sqlite")).await;
    store.put_agent_goal(&goal_request(), 101).await.unwrap();
    store.enqueue_agent_turn(&start_turn()).await.unwrap();
    let next = continuation(&store, 1, "automatic").await;
    assert!(
        store
            .prepare_agent_goal_turn(&next)
            .await
            .unwrap()
            .is_none()
    );
    assert!(tail(&store).await.active_turn.is_none());
    assert_eq!(tail(&store).await.queued_inputs.inputs.len(), 1);
}
fn goal_request() -> AgentGoalPutRequestV1 {
    AgentGoalPutRequestV1 {
        schema_version: 1,
        agent_id: interaction_binding().agent_id,
        expected_revision: 0,
        idempotency_key: "start-goal".into(),
        objective: "Finish the reader's task, including useful follow-up work.".into(),
        status: AgentGoalStatusV1::Active,
        detail: None,
    }
}

async fn continuation(
    store: &SqliteDomainStore,
    revision: u64,
    turn: &str,
) -> AgentGoalTurnRequestV1 {
    let page = tail(store).await;
    AgentGoalTurnRequestV1 {
        agent_id: page.binding.agent_id,
        goal_revision: revision,
        expected_cursor: page.final_cursor,
        intent: AgentStartTurnIntentV1 {
            turn_id: AgentTurnIdV1::new(turn).unwrap(),
            client_message_id: AgentClientMessageIdV1::new(format!("input-{turn}")).unwrap(),
            ..start_turn()
        },
    }
}

fn finish(
    turn: &str,
    sequence: i64,
    state: AgentTimelineLifecycleStateV1,
) -> AgentProviderEventCommitV1 {
    provider_event(
        sequence,
        vec![AgentTimelineMutationV1::Append {
            item: AgentTimelineItemDraftV1 {
                item_id: AgentTimelineItemIdV1::new(format!("finished-{turn}")).unwrap(),
                turn_id: Some(AgentTurnIdV1::new(turn).unwrap()),
                client_message_id: Some(
                    AgentClientMessageIdV1::new(format!("input-{turn}")).unwrap(),
                ),
                provider_message_id: None,
                body: AgentTimelineItemBodyV1::Lifecycle {
                    state,
                    detail: None,
                },
                created_at_ms: 120 + sequence,
            },
        }],
    )
}

#[tokio::test]
async fn successful_segments_continue_once_and_keep_generated_input_distinct_from_people() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("store.sqlite")).await;
    let first = continuation(&store, 1, "first").await;
    assert!(
        store
            .prepare_agent_goal_turn(&first)
            .await
            .unwrap()
            .is_none(),
        "ordinary work has no implicit goal"
    );
    let goal = store.put_agent_goal(&goal_request(), 110).await.unwrap();
    let (left, right) = tokio::join!(
        store.prepare_agent_goal_turn(&first),
        store.prepare_agent_goal_turn(&first)
    );
    assert_eq!(
        usize::from(left.unwrap().is_some()) + usize::from(right.unwrap().is_some()),
        1
    );
    let page = tail(&store).await;
    assert_eq!(page.active_turn.unwrap().turn_id.as_str(), "first");
    assert!(page.rows.iter().any(|row| matches!(&row.item.body,
        AgentTimelineItemBodyV1::GoalContinuation { objective, goal_revision } if objective == &goal.objective && *goal_revision == 1)));
    assert!(!page.rows.iter().any(|row| matches!(
        &row.item.body,
        AgentTimelineItemBodyV1::Message {
            role: dure_app::AgentTimelineMessageRoleV1::User,
            ..
        }
    )));
    // A prepared action whose acceptance is unknown remains the same active
    // turn after restart; the goal loop cannot prepare a replacement action.
    store.close().await;
    let store = SqliteDomainStore::open(root.path().join("store.sqlite"))
        .await
        .unwrap();
    assert!(
        store
            .prepare_agent_goal_turn(&continuation(&store, 1, "too-early").await)
            .await
            .unwrap()
            .is_none()
    );
    store
        .apply_agent_provider_event(&finish(
            "first",
            1,
            AgentTimelineLifecycleStateV1::TurnCompleted,
        ))
        .await
        .unwrap();
    let next = continuation(&store, 1, "second").await;
    assert!(
        store
            .prepare_agent_goal_turn(&next)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .prepare_agent_goal_turn(&next)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn changed_directions_and_human_input_win_before_a_continuation_claim() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("store.sqlite")).await;
    let original = goal_request();
    store.put_agent_goal(&original, 110).await.unwrap();
    let pending = continuation(&store, 1, "old-direction").await;
    let changed = AgentGoalPutRequestV1 {
        expected_revision: 1,
        idempotency_key: "new-direction".into(),
        objective: "Use the team's revised direction".into(),
        ..original.clone()
    };
    let goal = store.put_agent_goal(&changed, 111).await.unwrap();
    assert!(
        store
            .prepare_agent_goal_turn(&pending)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .put_agent_goal(
                &AgentGoalPutRequestV1 {
                    idempotency_key: "stale-completion".into(),
                    status: AgentGoalStatusV1::Complete,
                    ..changed.clone()
                },
                112
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.put_agent_goal(&original, 113).await.unwrap().revision,
        1,
        "replay returns its historical receipt"
    );
    assert_eq!(
        store.agent_goal(&original.agent_id).await.unwrap().unwrap(),
        goal,
        "replay does not replace newer intent"
    );
    let racing = continuation(&store, 2, "racing-input").await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    assert!(
        store
            .prepare_agent_goal_turn(&racing)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        tail(&store).await.active_turn.unwrap().turn_id.as_str(),
        "turn-1"
    );
}

#[tokio::test]
async fn canceling_a_waiting_goal_write_does_not_poison_the_next_goal_write() {
    use sqlx::Connection;
    let root = TempDir::new().unwrap();
    let file = root.path().join("store.sqlite");
    let original = provision(&file).await;
    original.close().await;
    // One pre-opened connection makes the canceled BEGIN and its successor use
    // the same SQLite worker. No provider timing or sleep controls the result.
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .test_before_acquire(false)
        .connect_with(crate::schema::writable_connect_options(&file))
        .await
        .unwrap();
    assert_eq!(pool.num_idle(), 1);
    let store = SqliteDomainStore {
        pool,
        path: original.path.clone(),
        schema_info: original.schema_info.clone(),
    };
    let mut writer =
        sqlx::SqliteConnection::connect_with(&crate::schema::writable_connect_options(&file))
            .await
            .unwrap();
    let lock = writer.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let request = goal_request();
    let mut mutation = store.put_agent_goal(&request, 110);
    tokio::select! {
        biased;
        result = &mut mutation => panic!("the other writer holds the transaction: {result:?}"),
        _ = async {
            while store.pool.num_idle() != 0 { tokio::task::yield_now().await; }
        } => {}
    }
    drop(mutation);
    lock.commit().await.unwrap();
    let next = AgentGoalPutRequestV1 {
        idempotency_key: "after-cancellation".into(),
        ..request
    };
    let result = store.put_agent_goal(&next, 120).await;
    assert!(
        result.is_ok(),
        "the canceled write left the pooled connection inside a transaction: {result:?}"
    );
    assert_eq!(result.unwrap().revision, 1);
}

#[tokio::test]
async fn a_completed_turn_does_not_hide_a_failed_or_canceled_tool_from_the_goal() {
    for (state, expected) in [
        (
            dure_app::AgentTimelineToolStateV1::Failed,
            AgentGoalStatusV1::Failed,
        ),
        (
            dure_app::AgentTimelineToolStateV1::Canceled,
            AgentGoalStatusV1::Paused,
        ),
    ] {
        let root = TempDir::new().unwrap();
        let file = root.path().join("store.sqlite");
        let store = provision(&file).await;
        let original = goal_request();
        store.put_agent_goal(&original, 110).await.unwrap();
        store
            .prepare_agent_goal_turn(&continuation(&store, 1, "tool-failure").await)
            .await
            .unwrap()
            .unwrap();
        let mut event = finish(
            "tool-failure",
            1,
            AgentTimelineLifecycleStateV1::TurnCompleted,
        );
        let AgentTimelineMutationV1::Append { item } = &event.mutations[0] else {
            panic!("lifecycle fixture")
        };
        let tool = AgentTimelineItemDraftV1 {
            item_id: AgentTimelineItemIdV1::new("failed-tool").unwrap(),
            body: AgentTimelineItemBodyV1::Tool {
                tool_call_id: "goal-read".into(),
                name: "mcpToolCall".into(),
                state,
                input: Some(serde_json::json!({"tool": "agent_goal_get"})),
                output: Some(
                    serde_json::json!({"error": {"message": "user rejected MCP tool call"}}),
                ),
            },
            ..item.clone()
        };
        event
            .mutations
            .insert(0, AgentTimelineMutationV1::Append { item: tool });
        store.apply_agent_provider_event(&event).await.unwrap();
        store.close().await;
        let store = SqliteDomainStore::open(&file).await.unwrap();
        assert!(
            store
                .prepare_agent_goal_turn(&continuation(&store, 1, "blind-repeat").await)
                .await
                .unwrap()
                .is_none(),
            "a successful report must not cause a fresh turn after an actual failed tool"
        );
        let stopped = store.agent_goal(&original.agent_id).await.unwrap().unwrap();
        assert_eq!(stopped.status, expected);
        let resumed = store
            .put_agent_goal(
                &AgentGoalPutRequestV1 {
                    expected_revision: stopped.revision,
                    idempotency_key: "explicit-resume".into(),
                    ..original
                },
                140,
            )
            .await
            .unwrap();
        assert!(
            store
                .prepare_agent_goal_turn(&continuation(&store, resumed.revision, "resumed").await)
                .await
                .unwrap()
                .is_some()
        );
    }
}

#[tokio::test]
async fn failed_or_canceled_segments_require_an_explicit_resume_even_after_reopen() {
    for (state, expected) in [
        (
            AgentTimelineLifecycleStateV1::TurnFailed,
            AgentGoalStatusV1::Failed,
        ),
        (
            AgentTimelineLifecycleStateV1::TurnCanceled,
            AgentGoalStatusV1::Paused,
        ),
    ] {
        let root = TempDir::new().unwrap();
        let file = root.path().join("store.sqlite");
        let store = provision(&file).await;
        let original = goal_request();
        store.put_agent_goal(&original, 110).await.unwrap();
        store
            .prepare_agent_goal_turn(&continuation(&store, 1, "failed").await)
            .await
            .unwrap()
            .unwrap();
        store
            .apply_agent_provider_event(&finish("failed", 1, state))
            .await
            .unwrap();
        store.close().await;
        let store = SqliteDomainStore::open(&file).await.unwrap();
        assert!(
            store
                .prepare_agent_goal_turn(&continuation(&store, 1, "blind-retry").await)
                .await
                .unwrap()
                .is_none()
        );
        let failed = store.agent_goal(&original.agent_id).await.unwrap().unwrap();
        assert_eq!(failed.status, expected);
        assert_eq!(failed.revision, 2);
        assert!(store.active_agent_goals().await.unwrap().is_empty());
        let resumed = store
            .put_agent_goal(
                &AgentGoalPutRequestV1 {
                    expected_revision: failed.revision,
                    idempotency_key: "explicit-resume".into(),
                    ..original
                },
                130,
            )
            .await
            .unwrap();
        assert!(
            store
                .prepare_agent_goal_turn(&continuation(&store, resumed.revision, "resumed").await)
                .await
                .unwrap()
                .is_some()
        );
    }
}

#[tokio::test]
async fn waiting_questions_and_explicit_goal_states_do_not_start_another_turn() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("store.sqlite")).await;
    let original = goal_request();
    store.put_agent_goal(&original, 110).await.unwrap();
    store
        .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
            schema_version: 1,
            interaction_session_id: interaction_binding().interaction_session_id,
            runtime: runtime(1),
            observed_through_sequence: 0,
            requests: vec![pending_request()],
            observed_at_ms: 120,
        })
        .await
        .unwrap();
    assert!(
        store
            .prepare_agent_goal_turn(&continuation(&store, 1, "waiting").await)
            .await
            .unwrap()
            .is_none()
    );
    store
        .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
            schema_version: 1,
            interaction_session_id: interaction_binding().interaction_session_id,
            runtime: runtime(1),
            observed_through_sequence: 0,
            requests: vec![],
            observed_at_ms: 121,
        })
        .await
        .unwrap();
    for (revision, status) in [
        (1, AgentGoalStatusV1::Paused),
        (2, AgentGoalStatusV1::Complete),
    ] {
        let goal = store
            .put_agent_goal(
                &AgentGoalPutRequestV1 {
                    expected_revision: revision,
                    idempotency_key: format!("state-{revision}"),
                    status,
                    ..original.clone()
                },
                122,
            )
            .await
            .unwrap();
        assert!(
            store
                .prepare_agent_goal_turn(&continuation(&store, goal.revision, "disabled").await)
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn schema_47_migration_retains_the_existing_conversation_and_accepts_an_explicit_goal() {
    let root = TempDir::new().unwrap();
    let file = root.path().join("store.sqlite");
    let store = provision(&file).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    let before = tail(&store).await;
    store.close().await;
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&file))
        .await
        .unwrap();
    for statement in [
        "DROP TABLE agent_goal_mutations",
        "DROP TABLE agent_goals",
        "UPDATE store_metadata SET schema_version = 47, min_reader_version = 47, min_writer_version = 47",
    ] {
        sqlx::query(statement)
            .execute(&mut connection)
            .await
            .unwrap();
    }
    connection.close().await.unwrap();
    let store = SqliteDomainStore::open(&file).await.unwrap();
    assert_eq!(tail(&store).await, before);
    let goal = store.put_agent_goal(&goal_request(), 120).await.unwrap();
    store.close().await;
    let store = SqliteDomainStore::open(&file).await.unwrap();
    assert_eq!(
        store.agent_goal(&goal.agent_id).await.unwrap(),
        Some(goal.clone())
    );
    assert_eq!(store.active_agent_goals().await.unwrap(), vec![goal]);
}

#[tokio::test]
async fn canceling_a_goal_projection_read_does_not_poison_the_next_write() {
    let root = TempDir::new().unwrap();
    let file = root.path().join("store.sqlite");
    let original = provision(&file).await;
    original.close().await;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .test_before_acquire(false)
        .connect_with(crate::schema::writable_connect_options(&file))
        .await
        .unwrap();
    assert_eq!(pool.num_idle(), 1);
    let store = SqliteDomainStore {
        pool,
        path: original.path.clone(),
        schema_info: original.schema_info.clone(),
    };
    let request = AgentTimelineReadRequestV1 {
        schema_version: 1,
        interaction_session_id: interaction_binding().interaction_session_id,
        direction: AgentTimelineReadDirectionV1::Tail,
        cursor: None,
        limit: 1,
    };
    let mut read = store.read_agent_timeline(&request);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(read.as_mut().poll(&mut context).is_pending());
    assert_eq!(
        store.pool.num_idle(),
        0,
        "the read owns the only connection"
    );
    drop(read);
    let result = store.put_agent_goal(&goal_request(), 110).await;
    assert!(
        result.is_ok(),
        "canceled snapshot poisoned the next goal write: {result:?}"
    );
    assert_eq!(tail(&store).await.goal, Some(result.unwrap()));
}
