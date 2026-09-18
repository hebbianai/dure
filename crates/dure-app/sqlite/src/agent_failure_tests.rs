use super::*;
use dure_app::{AgentTimelineMessageRoleV1, AgentTurnFailureReasonV1};

fn failure_row(sequence: i64, detail: Option<&str>) -> AgentTimelineMutationV1 {
    AgentTimelineMutationV1::Append {
        item: AgentTimelineItemDraftV1 {
            item_id: AgentTimelineItemIdV1::new(format!("failure-{sequence}")).unwrap(),
            turn_id: Some(start_turn().turn_id),
            client_message_id: Some(start_turn().client_message_id),
            provider_message_id: None,
            body: AgentTimelineItemBodyV1::Lifecycle {
                state: AgentTimelineLifecycleStateV1::TurnFailed,
                detail: detail.map(str::to_string),
            },
            created_at_ms: 200 + sequence,
        },
    }
}

#[tokio::test]
async fn long_failed_input_survives_pagination_and_store_reopen() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("failed-input.sqlite");
    let store = provision(&path).await;
    let intent = start_turn();
    store.record_agent_turn_intent(&intent).await.unwrap();
    for sequence in 1..=130 {
        store
            .apply_agent_provider_event(&provider_event(
                sequence,
                vec![AgentTimelineMutationV1::Append {
                    item: AgentTimelineItemDraftV1 {
                        item_id: AgentTimelineItemIdV1::new(format!("progress-{sequence}"))
                            .unwrap(),
                        turn_id: Some(intent.turn_id.clone()),
                        client_message_id: Some(intent.client_message_id.clone()),
                        provider_message_id: None,
                        body: AgentTimelineItemBodyV1::Message {
                            role: AgentTimelineMessageRoleV1::Assistant,
                            markdown: format!("Progress {sequence}"),
                        },
                        created_at_ms: 200 + sequence,
                    },
                }],
            ))
            .await
            .unwrap();
    }
    store
        .apply_agent_provider_event(&provider_event(
            131,
            vec![failure_row(131, Some("usage_limit"))],
        ))
        .await
        .unwrap();
    let expected = dure_app::AgentTimelineFailureV1 {
        item_id: AgentTimelineItemIdV1::new("failure-131").unwrap(),
        created_at_ms: 331,
        reason: AgentTurnFailureReasonV1::UsageLimit,
        user_input: Some(intent.input),
    };
    let recent = read_page(&store, AgentTimelineReadDirectionV1::Tail, None, 1).await;
    assert_eq!(recent.rows.len(), 1);
    assert!(recent.has_more);
    assert_eq!(recent.latest_failure, Some(expected.clone()));
    let historical = read_page(
        &store,
        AgentTimelineReadDirectionV1::Before,
        Some(recent.final_cursor),
        1,
    )
    .await;
    assert_eq!(historical.latest_failure, Some(expected.clone()));
    let first = read_page(
        &store,
        AgentTimelineReadDirectionV1::After,
        Some(AgentTimelineCursorV1 {
            epoch: interaction_binding().timeline_epoch,
            sequence: 0,
        }),
        1,
    )
    .await;
    assert!(first.has_more);
    assert_eq!(first.latest_failure, Some(expected.clone()));
    drop(store);
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(tail(&reopened).await.latest_failure, Some(expected));
}

#[tokio::test]
async fn current_turn_boundaries_replace_failure_even_on_historical_pages() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("current-boundary.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![failure_row(1, Some("usage_limit"))],
        ))
        .await
        .unwrap();
    let failed = tail(&store).await;
    assert!(failed.latest_failure.is_some());
    for (offset, state) in [
        AgentTimelineLifecycleStateV1::TurnStarted,
        AgentTimelineLifecycleStateV1::TurnCompleted,
        AgentTimelineLifecycleStateV1::TurnCanceled,
    ]
    .into_iter()
    .enumerate()
    {
        let sequence = 2 + offset as i64;
        store
            .apply_agent_provider_event(&provider_event(
                sequence,
                vec![session_lifecycle(
                    &format!("new-boundary-{sequence}"),
                    state,
                    300 + sequence,
                )],
            ))
            .await
            .unwrap();
        let old = read_page(
            &store,
            AgentTimelineReadDirectionV1::Before,
            Some(failed.final_cursor.clone()),
            1,
        )
        .await;
        assert_eq!(old.latest_failure, None);
    }
    store
        .apply_agent_provider_event(&provider_event(5, vec![failure_row(5, Some("rate_limit"))]))
        .await
        .unwrap();
    assert!(tail(&store).await.latest_failure.is_some());
    let mut redirected = start_turn();
    redirected.turn_id = AgentTurnIdV1::new("human-turn").unwrap();
    redirected.client_message_id = AgentClientMessageIdV1::new("human-input").unwrap();
    redirected.input = "A new direction".into();
    store.record_agent_turn_intent(&redirected).await.unwrap();
    assert_eq!(tail(&store).await.latest_failure, None);
}

#[tokio::test]
async fn unknown_failures_and_unrelated_input_never_resurrect_old_recovery() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("failure-identity.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![failure_row(1, Some("usage_limit"))],
        ))
        .await
        .unwrap();
    for (index, detail) in [None, Some("unclassified provider prose")]
        .into_iter()
        .enumerate()
    {
        let sequence = index as i64 + 2;
        store
            .apply_agent_provider_event(&provider_event(
                sequence,
                vec![failure_row(sequence, detail)],
            ))
            .await
            .unwrap();
        assert_eq!(tail(&store).await.latest_failure, None);
    }
    let AgentTimelineMutationV1::Append { mut item } =
        failure_row(4, Some("authentication_failed"))
    else {
        unreachable!()
    };
    item.turn_id = Some(AgentTurnIdV1::new("imported-turn").unwrap());
    item.client_message_id = None;
    store
        .apply_agent_provider_event(&provider_event(
            4,
            vec![AgentTimelineMutationV1::Append { item }],
        ))
        .await
        .unwrap();
    let projected = tail(&store).await.latest_failure.unwrap();
    assert_eq!(
        projected.reason,
        AgentTurnFailureReasonV1::AuthenticationFailed
    );
    assert_eq!(projected.user_input, None);
    store
        .apply_agent_provider_event(&provider_event(
            5,
            vec![session_lifecycle(
                "ready-after-failure",
                AgentTimelineLifecycleStateV1::SessionReady,
                400,
            )],
        ))
        .await
        .unwrap();
    assert_eq!(tail(&store).await.latest_failure, Some(projected));
}
