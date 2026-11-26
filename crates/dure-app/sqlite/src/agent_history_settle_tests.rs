//! A runtime that reconciles its provider's history through its own events
//! settles it once it has attached: the store decides from its rows whether
//! the timeline holds the whole history the provider resumes from.

use super::*;
use dure_app::{
    AgentContinueTurnRequestV1, AgentTimelineMessageRoleV1, AgentTimelinePageV1,
    PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1, PROVIDER_TRANSCRIPT_WINDOW_HISTORY_BOUNDARY_V1,
};

fn row(id: &str, body: AgentTimelineItemBodyV1) -> AgentTimelineMutationV1 {
    AgentTimelineMutationV1::Append {
        item: AgentTimelineItemDraftV1 {
            item_id: AgentTimelineItemIdV1::new(id).unwrap(),
            turn_id: None,
            client_message_id: None,
            provider_message_id: None,
            body,
            created_at_ms: 0,
        },
    }
}

fn message(id: &str, role: AgentTimelineMessageRoleV1) -> AgentTimelineMutationV1 {
    row(
        id,
        AgentTimelineItemBodyV1::Message {
            role,
            markdown: format!("text of {id}"),
        },
    )
}

fn boundary(reason: &str) -> AgentTimelineMutationV1 {
    row(
        &format!("boundary-{reason}"),
        AgentTimelineItemBodyV1::HistoryBoundary {
            reason: reason.into(),
            requested_after_provider_sequence: 0,
            dropped_through_provider_sequence: 1,
        },
    )
}

fn settle() -> AgentTimelineMutationV1 {
    AgentTimelineMutationV1::SettleHistory { settled_at_ms: 150 }
}

/// A Terminal Agent moved into Chat: the binding names the provider
/// conversation, whose history the runtime has yet to reconcile.
async fn moved_into_chat(root: &TempDir) -> SqliteDomainStore {
    provision_with_binding(
        &root.path().join("settle.sqlite"),
        AgentInteractionBindingV1 {
            history_complete: false,
            ..interaction_binding()
        },
    )
    .await
}

async fn commit(store: &SqliteDomainStore, sequence: i64, mutations: Vec<AgentTimelineMutationV1>) {
    store
        .apply_agent_provider_event(&provider_event(sequence, mutations))
        .await
        .unwrap();
}

async fn continuation(store: &SqliteDomainStore) -> Option<dure_app::AgentTurnEffectReceiptV1> {
    let page: AgentTimelinePageV1 = tail(store).await;
    store
        .prepare_agent_continuation_turn(&AgentContinueTurnRequestV1 {
            intent: start_turn(),
            expected_cursor: page.final_cursor,
        })
        .await
        .unwrap()
}

/// Before the settle, nothing ever completed a history reconciled through
/// provider events, so an Agent moved into Chat never took automatic input:
/// its goal never continued and provider recovery never started.
#[tokio::test]
async fn a_history_reconciled_through_provider_events_settles_complete() {
    let root = TempDir::new().unwrap();
    let store = moved_into_chat(&root).await;
    commit(
        &store,
        1,
        vec![
            message("terminal-user", AgentTimelineMessageRoleV1::User),
            message("terminal-answer", AgentTimelineMessageRoleV1::Assistant),
        ],
    )
    .await;
    assert!(!tail(&store).await.binding.history_complete);
    assert!(continuation(&store).await.is_none());

    let receipt = store
        .apply_agent_provider_event(&provider_event(2, vec![settle()]))
        .await
        .unwrap();
    assert!(receipt.timeline_changed, "views read the settled binding");
    let page = tail(&store).await;
    assert!(page.binding.history_complete);
    assert_eq!(page.rows.len(), 2, "settling appends no row");
    assert!(continuation(&store).await.is_some());

    let replay = store
        .apply_agent_provider_event(&provider_event(2, vec![settle()]))
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert!(!replay.timeline_changed);
}

/// A Chat-created Agent's history is complete. After a Terminal round trip
/// longer than the attach reads, the window's boundary leaves history out.
#[tokio::test]
async fn a_window_left_out_settles_a_complete_history_incomplete() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("settle.sqlite")).await;
    commit(
        &store,
        1,
        vec![message("chat-user", AgentTimelineMessageRoleV1::User)],
    )
    .await;
    commit(
        &store,
        2,
        vec![
            boundary(PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1),
            message("terminal-answer", AgentTimelineMessageRoleV1::Assistant),
        ],
    )
    .await;
    assert!(tail(&store).await.binding.history_complete);

    let receipt = store
        .apply_agent_provider_event(&provider_event(3, vec![settle()]))
        .await
        .unwrap();
    assert!(receipt.timeline_changed);
    assert!(!tail(&store).await.binding.history_complete);
    assert!(continuation(&store).await.is_none());

    // A later attach that meets the held rows settles the same way.
    let again = store
        .apply_agent_provider_event(&provider_event(4, vec![settle()]))
        .await
        .unwrap();
    assert!(!again.timeline_changed);
    assert!(!tail(&store).await.binding.history_complete);
}

/// Every boundary but a compaction's leaves out history the provider resumes
/// from, whether or not a reader can page it in.
#[tokio::test]
async fn only_a_compaction_boundary_settles_complete() {
    for (reason, complete) in [
        (PROVIDER_COMPACTION_HISTORY_BOUNDARY_V1, true),
        (PROVIDER_TRANSCRIPT_WINDOW_HISTORY_BOUNDARY_V1, false),
        (PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1, false),
    ] {
        let root = TempDir::new().unwrap();
        let store = moved_into_chat(&root).await;
        commit(
            &store,
            1,
            vec![
                boundary(reason),
                message("window-user", AgentTimelineMessageRoleV1::User),
            ],
        )
        .await;
        commit(&store, 2, vec![settle()]).await;
        assert_eq!(
            tail(&store).await.binding.history_complete,
            complete,
            "{reason}"
        );
    }
}

/// Provider events the host dropped stay missing: settling does not undo the
/// replay gap's boundary.
#[tokio::test]
async fn a_replay_gap_keeps_a_settled_history_incomplete() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("settle.sqlite")).await;
    store
        .record_agent_provider_gap(&AgentProviderGapV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: interaction_binding().interaction_session_id,
            runtime: runtime(1),
            requested_after_sequence: 0,
            dropped_through_sequence: 3,
            observed_at_ms: 130,
        })
        .await
        .unwrap();
    assert!(!tail(&store).await.binding.history_complete);
    let receipt = store
        .apply_agent_provider_event(&provider_event(4, vec![settle()]))
        .await
        .unwrap();
    assert!(!receipt.timeline_changed);
    assert!(!tail(&store).await.binding.history_complete);
}
