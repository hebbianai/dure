//! A timeline that already holds part of a provider conversation continues
//! with what the provider recorded after it, for example in a Terminal between
//! two Chat sessions, without inserting older history ahead of its rows.

use super::*;
use dure_app::{AgentTimelineMessageRoleV1, PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1};

fn message(
    id: &str,
    role: AgentTimelineMessageRoleV1,
    provider_message_id: Option<&str>,
) -> AgentTimelineItemDraftV1 {
    AgentTimelineItemDraftV1 {
        item_id: AgentTimelineItemIdV1::new(id).unwrap(),
        turn_id: None,
        client_message_id: None,
        provider_message_id: provider_message_id
            .map(|id| AgentProviderMessageIdV1::new(id).unwrap()),
        body: AgentTimelineItemBodyV1::Message {
            role,
            markdown: format!("text of {id}"),
        },
        created_at_ms: 0,
    }
}

fn user(id: &str) -> AgentTimelineItemDraftV1 {
    message(id, AgentTimelineMessageRoleV1::User, None)
}

fn assistant(id: &str, provider_message_id: &str) -> AgentTimelineItemDraftV1 {
    message(
        id,
        AgentTimelineMessageRoleV1::Assistant,
        Some(provider_message_id),
    )
}

fn boundary(reason: &str, dropped_through: i64) -> AgentTimelineItemDraftV1 {
    AgentTimelineItemDraftV1 {
        item_id: AgentTimelineItemIdV1::new("history-boundary").unwrap(),
        turn_id: None,
        client_message_id: None,
        provider_message_id: None,
        body: AgentTimelineItemBodyV1::HistoryBoundary {
            reason: reason.into(),
            requested_after_provider_sequence: 0,
            dropped_through_provider_sequence: dropped_through,
        },
        created_at_ms: 0,
    }
}

fn interaction() -> AgentInteractionSessionIdV1 {
    AgentInteractionSessionIdV1::new("interaction-1").unwrap()
}

/// A Chat session's own rows: what the live provider stream committed.
async fn live(store: &SqliteDomainStore, sequence: i64, items: Vec<AgentTimelineItemDraftV1>) {
    store
        .apply_agent_provider_event(&provider_event(
            sequence,
            items
                .into_iter()
                .map(|item| AgentTimelineMutationV1::Append { item })
                .collect(),
        ))
        .await
        .unwrap();
}

async fn snapshot(
    store: &SqliteDomainStore,
    items: Vec<AgentTimelineItemDraftV1>,
) -> AgentHistorySnapshotV1 {
    AgentHistorySnapshotV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        binding: store
            .agent_interaction(&interaction())
            .await
            .unwrap()
            .unwrap(),
        items,
        observed_at_ms: 200,
    }
}

fn item_ids(page: &dure_app::AgentTimelinePageV1) -> Vec<String> {
    page.rows
        .iter()
        .map(|row| row.item.item_id.to_string())
        .collect()
}

/// The provider history ran on in a Terminal after a Chat session: Chat
/// opens again with those turns after its own, each once and in order.
#[tokio::test]
async fn continued_history_appends_what_followed_the_newest_held_provider_message() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("domain.sqlite")).await;
    // Seeded before the first Chat session, then that session's own turn.
    live(
        &store,
        1,
        vec![
            user("seeded-user"),
            assistant("seeded-answer", "msg_1"),
            user("chat-user"),
            assistant("chat-answer", "msg_2"),
        ],
    )
    .await;
    assert_eq!(
        store
            .agent_history_hydration_authority(&interaction())
            .await
            .unwrap()
            .disposition,
        AgentHistoryHydrationDispositionV1::Continuable
    );

    // The provider's history now: everything above as the provider recorded
    // it, then the turns made in the Terminal.
    let history = snapshot(
        &store,
        vec![
            user("history-1"),
            assistant("history-2", "msg_1"),
            user("history-3"),
            assistant("history-4", "msg_2"),
            user("terminal-user"),
            assistant("terminal-answer", "msg_3"),
        ],
    )
    .await;
    let receipt = store.continue_agent_history(&history).await.unwrap();
    assert!(receipt.timeline_changed);
    assert!(!receipt.newly_completed);
    assert!(receipt.binding.history_complete);
    let expected = [
        "seeded-user",
        "seeded-answer",
        "chat-user",
        "chat-answer",
        "terminal-user",
        "terminal-answer",
    ];
    assert_eq!(item_ids(&tail(&store).await), expected);
    assert_eq!(
        store
            .agent_provider_cursor(&interaction(), &runtime(1))
            .await
            .unwrap()
            .committed_through_sequence,
        1,
        "history never advances the live provider cursor"
    );

    // Another attachment reads the same history and appends nothing.
    let replay = store.continue_agent_history(&history).await.unwrap();
    assert!(!replay.timeline_changed);
    assert_eq!(item_ids(&tail(&store).await), expected);
}

/// A Chat session that sent nothing still meets the provider history at the
/// newest message seeded before it; rows held from that seed are not
/// repeated even when the provider history carries them after it.
#[tokio::test]
async fn continued_history_meets_seeded_rows_and_skips_the_items_it_holds() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("domain.sqlite")).await;
    live(
        &store,
        1,
        vec![assistant("seeded-answer", "msg_1"), user("seeded-question")],
    )
    .await;
    let history = snapshot(
        &store,
        vec![
            assistant("seeded-answer", "msg_1"),
            user("seeded-question"),
            assistant("terminal-answer", "msg_2"),
        ],
    )
    .await;
    store.continue_agent_history(&history).await.unwrap();
    assert_eq!(
        item_ids(&tail(&store).await),
        ["seeded-answer", "seeded-question", "terminal-answer"]
    );
}

/// The Terminal recorded more than the newest window the provider history
/// holds: the window follows the held rows behind a boundary that marks the
/// skipped history, at no transcript place a view could page into, and the
/// history is no longer complete.
#[tokio::test]
async fn continued_history_behind_a_window_marks_the_gap_and_leaves_the_history_incomplete() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("domain.sqlite")).await;
    live(&store, 1, vec![assistant("chat-answer", "msg_1")]).await;
    let history = snapshot(
        &store,
        vec![
            boundary("provider_transcript_window", 9_000),
            user("window-user"),
            assistant("window-answer", "msg_9"),
        ],
    )
    .await;
    let receipt = store.continue_agent_history(&history).await.unwrap();
    assert!(receipt.timeline_changed);
    assert!(!receipt.binding.history_complete);

    let page = tail(&store).await;
    assert_eq!(page.rows.len(), 4);
    assert_eq!(page.rows[0].item.item_id.as_str(), "chat-answer");
    assert!(matches!(
        &page.rows[1].item.body,
        AgentTimelineItemBodyV1::HistoryBoundary {
            reason,
            requested_after_provider_sequence: 0,
            dropped_through_provider_sequence: 1,
        } if reason == PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1
    ));
    assert_eq!(item_ids(&page)[2..], ["window-user", "window-answer"]);

    let replay = store.continue_agent_history(&history).await.unwrap();
    assert!(!replay.timeline_changed);
    assert_eq!(tail(&store).await.rows.len(), 4);
}

/// The provider compacted the conversation in the Terminal. Its summary
/// follows the held rows behind the gap boundary, and the history stays
/// complete: the provider resumes from that summary.
#[tokio::test]
async fn continued_history_from_a_compaction_marks_the_gap_and_stays_complete() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("domain.sqlite")).await;
    live(&store, 1, vec![assistant("chat-answer", "msg_1")]).await;
    let history = snapshot(
        &store,
        vec![
            boundary(PROVIDER_COMPACTION_HISTORY_BOUNDARY_V1, 4_096),
            user("compaction-summary"),
            assistant("after-compaction", "msg_9"),
        ],
    )
    .await;
    let receipt = store.continue_agent_history(&history).await.unwrap();
    assert!(receipt.timeline_changed);
    assert!(receipt.binding.history_complete);
    let page = tail(&store).await;
    assert!(matches!(
        &page.rows[1].item.body,
        AgentTimelineItemBodyV1::HistoryBoundary { reason, .. }
            if reason == PROVIDER_HISTORY_TRUNCATED_BOUNDARY_V1
    ));
    assert_eq!(
        item_ids(&page)[2..],
        ["compaction-summary", "after-compaction"]
    );
}

/// A provider history that neither meets the held rows nor opens at a window
/// or compaction has no place after them, and nothing is appended. So is a
/// history offered while a turn is in flight.
#[tokio::test]
async fn continued_history_appends_nothing_it_cannot_place() {
    let root = TempDir::new().unwrap();

    // The whole history from its start, but no message the timeline holds.
    let store = provision(&root.path().join("unmatched.sqlite")).await;
    live(&store, 1, vec![assistant("chat-answer", "msg_1")]).await;
    let history = snapshot(
        &store,
        vec![user("other-user"), assistant("other-answer", "msg_7")],
    )
    .await;
    assert!(
        !store
            .continue_agent_history(&history)
            .await
            .unwrap()
            .timeline_changed
    );
    assert_eq!(item_ids(&tail(&store).await), ["chat-answer"]);

    // A window, after rows that hold no provider message to follow.
    let store = provision(&root.path().join("unplaced.sqlite")).await;
    live(&store, 1, vec![user("chat-user")]).await;
    let history = snapshot(
        &store,
        vec![
            boundary("provider_transcript_window", 9_000),
            assistant("window-answer", "msg_9"),
        ],
    )
    .await;
    assert!(
        !store
            .continue_agent_history(&history)
            .await
            .unwrap()
            .timeline_changed
    );
    assert_eq!(item_ids(&tail(&store).await), ["chat-user"]);

    // A turn in flight owns the tail of the timeline.
    let store = provision(&root.path().join("in-flight.sqlite")).await;
    live(&store, 1, vec![assistant("chat-answer", "msg_1")]).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    let history = snapshot(
        &store,
        vec![
            assistant("chat-answer", "msg_1"),
            assistant("terminal-answer", "msg_2"),
        ],
    )
    .await;
    assert!(
        !store
            .continue_agent_history(&history)
            .await
            .unwrap()
            .timeline_changed
    );
    assert!(
        !item_ids(&tail(&store).await).contains(&"terminal-answer".to_string()),
        "nothing is appended under a running turn"
    );
}

/// A snapshot read for another runtime than the timeline's current one is
/// refused before anything is appended.
#[tokio::test]
async fn continued_history_requires_the_current_history_authority() {
    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("domain.sqlite")).await;
    live(&store, 1, vec![assistant("chat-answer", "msg_1")]).await;
    let mut history = snapshot(
        &store,
        vec![
            assistant("chat-answer", "msg_1"),
            assistant("terminal-answer", "msg_2"),
        ],
    )
    .await;
    history.binding.runtime = runtime(2);
    assert!(matches!(
        store.continue_agent_history(&history).await.unwrap_err(),
        DomainStoreErrorV1::IdentityConflict { .. }
    ));
    assert_eq!(item_ids(&tail(&store).await), ["chat-answer"]);
}

/// The Agent moved back into Chat after `/clear` in its Terminal: the new
/// runtime resumes another conversation than the one the timeline holds. It
/// opens an empty timeline for that conversation, which its history seeds as
/// on a first move into Chat, and the cleared conversation's rows and queued
/// input stay behind in their own timeline.
#[tokio::test]
async fn a_replacement_onto_another_conversation_opens_an_empty_timeline_for_it() {
    use dure_app::{AgentInputReceiptV1, AgentQueuedTurnStateV1, AgentQueuedTurnStore};

    let root = TempDir::new().unwrap();
    let store = provision(&root.path().join("domain.sqlite")).await;
    live(
        &store,
        1,
        vec![user("cleared-user"), assistant("cleared-answer", "msg_1")],
    )
    .await;
    let queued = AgentStartTurnIntentV1 {
        turn_id: AgentTurnIdV1::new("queued-turn").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("queued-input").unwrap(),
        input: "written for the cleared conversation".into(),
        ..start_turn()
    };
    store.enqueue_agent_turn(&queued).await.unwrap();
    let cleared = tail(&store).await;
    assert_eq!(cleared.queued_inputs.inputs.len(), 1);

    let replacement = AgentRuntimeReplacementV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: interaction(),
        expected_binding_revision: 1,
        source: runtime(1),
        source_execution_profile: interaction_binding().execution_profile,
        target: runtime(2),
        target_execution_profile: interaction_binding().execution_profile,
        provider_conversation_ref: Some("conversation-after-clear".into()),
        replaced_at_ms: 150,
    };
    let replaced = store
        .replace_agent_interaction_runtime(&replacement)
        .await
        .unwrap();

    assert_eq!(
        replaced.provider_conversation_ref.as_deref(),
        Some("conversation-after-clear")
    );
    assert_eq!(
        replaced.timeline_epoch,
        cleared
            .binding
            .replacement_timeline_epoch(Some("conversation-after-clear"), &runtime(2))
            .unwrap(),
        "the store opens the epoch the binding's rule names",
    );
    assert_ne!(replaced.timeline_epoch, cleared.binding.timeline_epoch);
    assert!(!replaced.history_complete);
    assert_eq!(
        store
            .agent_history_hydration_authority(&interaction())
            .await
            .unwrap()
            .disposition,
        AgentHistoryHydrationDispositionV1::Seedable
    );
    let opened = tail(&store).await;
    assert!(opened.rows.is_empty(), "{:?}", item_ids(&opened));
    assert!(opened.queued_inputs.inputs.is_empty());
    let Some(AgentInputReceiptV1::Queued { receipt }) = store
        .inspect_agent_input(&interaction(), &queued.client_message_id)
        .await
        .unwrap()
    else {
        panic!("the queued input keeps its receipt");
    };
    assert_eq!(receipt.state, AgentQueuedTurnStateV1::Canceled);
    assert_eq!(
        receipt.timeline_cursor.epoch, cleared.binding.timeline_epoch,
        "the input is canceled where it was queued"
    );
    let mut retried = replacement.clone();
    retried.replaced_at_ms = 999;
    assert_eq!(
        store
            .replace_agent_interaction_runtime(&retried)
            .await
            .unwrap(),
        replaced,
        "a replayed replacement finds the timeline it opened"
    );

    let receipt = store
        .reconcile_agent_history(
            &snapshot(
                &store,
                vec![
                    user("after-clear-user"),
                    assistant("after-clear-answer", "msg_9"),
                ],
            )
            .await,
        )
        .await
        .unwrap();
    assert!(receipt.binding.history_complete);
    assert_eq!(
        item_ids(&tail(&store).await),
        ["after-clear-user", "after-clear-answer"]
    );
}
