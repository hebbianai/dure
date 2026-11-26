//! The app's chat runtime tier (#732): one subscription reports what each
//! chat Agent on the backend is doing, from its committed conversation and
//! its runtime projection, without a pane open.
use super::child_result_delivery_tests::ChatConversation;
use super::*;
use crate::agent_conversation_activity::{
    ActivityEvent, ActivityFeed, ActivityLifecycle, AgentActivityV1,
};
use dure_app::{
    AgentPendingRequestKindV1, AgentTimelineItemBodyV1, AgentTimelineLifecycleStateV1,
    AgentTimelineMessageRoleV1,
};
use tokio::sync::broadcast;
use tokio::time::Duration;

struct ChatAgent {
    _root: TempDir,
    state: ServiceState,
    binding: AgentInteractionBindingV1,
    stops: Arc<AtomicUsize>,
}

async fn chat_agent() -> ChatAgent {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let agent = AgentIdV1::new("tier-chat-agent").unwrap();
    let provider = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent.clone(),
            provider_id: provider.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            display_name: "Tier chat".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let (source, binding) = initialize_structured_source_with_conversation(
        &state,
        agent,
        provider,
        Some("conversation-retained"),
    )
    .await;
    let stops = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            source.provider_id,
            Arc::new(BusyStructuredRuntime {
                stop_count: Arc::clone(&stops),
                attach_count: Arc::new(AtomicUsize::new(0)),
                stop_error: None,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    make_fixture_mutation_authority(&mut state);
    ChatAgent {
        _root: root,
        state,
        binding,
        stops,
    }
}

fn reading(
    binding: &AgentInteractionBindingV1,
    lifecycle: ActivityLifecycle,
    activity: &'static str,
    attention: &'static str,
    attention_id: Option<&str>,
    turn_completed_sequence: &str,
) -> AgentActivityV1 {
    AgentActivityV1 {
        agent_id: binding.agent_id.clone(),
        interaction_session_id: binding.interaction_session_id.clone(),
        lifecycle,
        activity,
        attention,
        attention_id: attention_id.map(str::to_owned),
        timeline_epoch: binding.timeline_epoch.clone(),
        turn_completed_sequence: turn_completed_sequence.into(),
    }
}

async fn next_change(feed: &mut ActivityFeed, state: &ServiceState) -> AgentActivityV1 {
    match tokio::time::timeout(Duration::from_secs(5), feed.next(state))
        .await
        .expect("a change is reported")
        .unwrap()
    {
        ActivityEvent::Changes {
            mut changes,
            removed,
        } => {
            assert!(removed.is_empty());
            assert_eq!(changes.len(), 1);
            changes.remove(0)
        }
        other => panic!("expected one change, got {other:?}"),
    }
}

async fn assert_quiet(feed: &mut ActivityFeed, state: &ServiceState) {
    assert!(
        tokio::time::timeout(Duration::from_millis(200), feed.next(state))
            .await
            .is_err(),
        "nothing a subscriber shows changed"
    );
}

#[tokio::test]
async fn a_chat_agent_reports_each_state_once_without_a_pane_and_exits_only_when_stopped() {
    let chat = chat_agent().await;
    let state = &chat.state;
    let binding = &chat.binding;
    let (mut feed, snapshot) = ActivityFeed::open_with(
        state,
        state.agent_conversations.notifications(),
        Duration::ZERO,
    )
    .await
    .unwrap();
    assert_eq!(
        snapshot,
        vec![reading(
            binding,
            ActivityLifecycle::Running,
            "waiting",
            "none",
            None,
            "0"
        )]
    );

    let mut conversation = ChatConversation {
        binding: binding.clone(),
        sequence: 0,
    };
    conversation
        .commit(
            state,
            vec![
                conversation.message("user-1", AgentTimelineMessageRoleV1::User, "Fix #12"),
                conversation.lifecycle("started-1", AgentTimelineLifecycleStateV1::TurnStarted),
            ],
        )
        .await;
    assert_eq!(
        next_change(&mut feed, state).await,
        reading(
            binding,
            ActivityLifecycle::Running,
            "working",
            "none",
            None,
            "0"
        )
    );

    // A turn that waits on a person is waiting, as a Host reports it, and
    // each request is named by its own id.
    conversation
        .commit(
            state,
            vec![conversation.ask("permission-1", AgentPendingRequestKindV1::Permission)],
        )
        .await;
    assert_eq!(
        next_change(&mut feed, state).await,
        reading(
            binding,
            ActivityLifecycle::Running,
            "waiting",
            "approval_required",
            Some("permission-1"),
            "0"
        )
    );
    conversation
        .commit(
            state,
            vec![
                conversation.answer("permission-1"),
                conversation.ask("question-2", AgentPendingRequestKindV1::Question),
            ],
        )
        .await;
    assert_eq!(
        next_change(&mut feed, state).await,
        reading(
            binding,
            ActivityLifecycle::Running,
            "waiting",
            "input_required",
            Some("question-2"),
            "0"
        )
    );

    // A finished turn moves the sequence to its TurnCompleted row.
    conversation
        .commit(
            state,
            vec![
                conversation.answer("question-2"),
                conversation.message("answer-1", AgentTimelineMessageRoleV1::Assistant, "Fixed"),
                conversation.lifecycle("completed-1", AgentTimelineLifecycleStateV1::TurnCompleted),
            ],
        )
        .await;
    let finished = next_change(&mut feed, state).await;
    let completed = state
        .store
        .latest_agent_turn_completed(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap()
        .sequence;
    assert!(completed > 0);
    assert_eq!(
        finished,
        reading(
            binding,
            ActivityLifecycle::Running,
            "waiting",
            "none",
            None,
            &completed.to_string()
        )
    );

    // A committed row that changes nothing a subscriber shows sends nothing.
    conversation
        .commit(
            state,
            vec![conversation.row(
                "evidence-1",
                AgentTimelineItemBodyV1::ProviderEvidence {
                    namespace: "fixture".into(),
                    kind: "usage".into(),
                    value: json!({}),
                },
            )],
        )
        .await;
    assert_quiet(&mut feed, state).await;

    // A failed turn is an error named by its failure; the sequence stays at
    // the last finished turn.
    conversation
        .commit(
            state,
            vec![
                conversation.message("user-2", AgentTimelineMessageRoleV1::User, "And #13"),
                conversation.lifecycle("started-2", AgentTimelineLifecycleStateV1::TurnStarted),
                conversation.lifecycle("failed-2", AgentTimelineLifecycleStateV1::TurnFailed),
            ],
        )
        .await;
    assert_eq!(
        next_change(&mut feed, state).await,
        reading(
            binding,
            ActivityLifecycle::Running,
            "waiting",
            "error",
            Some("failed-2"),
            &completed.to_string()
        )
    );

    // Stopping the runtime announces itself: the Agent exits once stopped.
    agent_runtime_close_apply::apply(
        state,
        "tier-stop",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: binding.agent_id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(chat.stops.load(Ordering::SeqCst), 1);
    assert_eq!(
        next_change(&mut feed, state).await,
        reading(
            binding,
            ActivityLifecycle::Exited,
            "waiting",
            "none",
            None,
            &completed.to_string()
        )
    );

    // A new subscriber reads the same state in its snapshot.
    let (_, snapshot) = ActivityFeed::open(state).await.unwrap();
    assert_eq!(snapshot[0].lifecycle, ActivityLifecycle::Exited);
}

#[tokio::test]
async fn dropped_announcements_are_answered_with_a_fresh_snapshot() {
    let chat = chat_agent().await;
    let state = &chat.state;
    let (sender, receiver) = broadcast::channel(1);
    let (mut feed, _) = ActivityFeed::open_with(state, receiver, Duration::ZERO)
        .await
        .unwrap();
    let mut conversation = ChatConversation {
        binding: chat.binding.clone(),
        sequence: 0,
    };
    // The change is committed, but its announcement is among those dropped.
    conversation
        .write_unannounced(
            state,
            vec![conversation.ask("permission-1", AgentPendingRequestKindV1::Permission)],
        )
        .await;
    for sequence in 1..=3 {
        sender
            .send(crate::agent_conversation::AgentConversationNotificationV1 {
                interaction_session_id: chat.binding.interaction_session_id.clone(),
                timeline_cursor: dure_app::AgentTimelineCursorV1 {
                    epoch: chat.binding.timeline_epoch.clone(),
                    sequence,
                },
                kinds: vec![
                    crate::agent_conversation::AgentConversationNotificationKindV1::Timeline,
                ],
            })
            .unwrap();
    }
    assert_eq!(
        feed.next(state).await.unwrap(),
        ActivityEvent::Snapshot(vec![reading(
            &chat.binding,
            ActivityLifecycle::Running,
            "waiting",
            "approval_required",
            Some("permission-1"),
            "0"
        )])
    );
}

#[tokio::test]
async fn a_chat_agent_whose_runtime_is_changing_is_starting() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    let (agent_id, _) = admit_structured_to_native_transition(&state).await;
    let (_, snapshot) = ActivityFeed::open(&state).await.unwrap();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].agent_id, agent_id);
    assert_eq!(snapshot[0].lifecycle, ActivityLifecycle::Starting);
}
