//! A schedule-started agent on the chat runtime sleeps after confirmed idle
//! and reports its conversation state, like a terminal one (#566).
use super::*;
use crate::agent_conversation_outcome::{ConversationActivity, ConversationAttention};
use dure_app::{
    AgentClientMessageIdV1, AgentInteractionRequestIdV1, AgentPendingRequestDraftV1,
    AgentPendingRequestKindV1, AgentPendingRequestV1, AgentTimelineActiveTurnV1,
    AgentTimelineFailureV1, AgentTimelineItemIdV1, AgentTurnFailureReasonV1, AgentTurnIdV1,
};
use schedule_runtime::conversation;
use schedule_runtime::observation;

const IDLE_AFTER: Duration = Duration::from_secs(30 * 60);

struct ChatAgent {
    _root: TempDir,
    state: ServiceState,
    agent: AgentIdV1,
    binding: AgentInteractionBindingV1,
    stops: Arc<AtomicUsize>,
}

async fn chat_agent() -> ChatAgent {
    chat_agent_with(Some("conversation-retained")).await
}

async fn chat_agent_with(conversation: Option<&str>) -> ChatAgent {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let agent = AgentIdV1::new("scheduled-chat-agent").unwrap();
    let provider = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent.clone(),
            provider_id: provider.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            display_name: "Scheduled chat".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let (source, binding) = initialize_structured_source_with_conversation(
        &state,
        agent.clone(),
        provider,
        conversation,
    )
    .await;
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let stops = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            source.provider_id.clone(),
            Arc::new(RepairableReplacementRuntime {
                store: Arc::clone(&state.store),
                stop_count: Arc::clone(&stops),
                open_count: Arc::new(AtomicUsize::new(0)),
                first_failure_kind:
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                second_failure_kind: None,
                succeed_on_retry: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    make_fixture_mutation_authority(&mut state);
    ChatAgent {
        _root: root,
        state,
        agent,
        binding,
        stops,
    }
}

fn pending(
    kind: AgentPendingRequestKindV1,
    binding: &AgentInteractionBindingV1,
) -> AgentPendingRequestV1 {
    AgentPendingRequestV1 {
        interaction_session_id: binding.interaction_session_id.clone(),
        runtime: binding.runtime.clone(),
        request: AgentPendingRequestDraftV1 {
            request_id: AgentInteractionRequestIdV1::new("request-1").unwrap(),
            kind,
            turn_id: None,
            client_message_id: AgentClientMessageIdV1::new("message-1").unwrap(),
            payload: json!({}),
            created_at_ms: 40,
        },
    }
}

#[tokio::test]
async fn conversation_state_names_work_questions_failures_and_idle() {
    let chat = chat_agent().await;
    let idle = conversation::read(&chat.state, &chat.binding)
        .await
        .unwrap();
    assert_eq!(
        ConversationActivity::from_page(&idle),
        ConversationActivity {
            working: false,
            attention: ConversationAttention::None,
            quiescent: true,
            last_activity_ms: chat.binding.updated_at_ms,
        }
    );

    let mut running = idle.clone();
    running.active_turn = Some(AgentTimelineActiveTurnV1 {
        turn_id: AgentTurnIdV1::new("turn-1").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("message-1").unwrap(),
    });
    let activity = ConversationActivity::from_page(&running);
    assert!(activity.working && !activity.quiescent);
    assert_eq!(
        activity.observation(),
        json!({"activity": "working", "attention": "none"})
    );

    let mut asking = idle.clone();
    asking.pending_requests = vec![pending(AgentPendingRequestKindV1::Question, &chat.binding)];
    let activity = ConversationActivity::from_page(&asking);
    assert_eq!(
        (activity.attention, activity.quiescent),
        (ConversationAttention::InputRequired, false)
    );
    asking.pending_requests = vec![pending(
        AgentPendingRequestKindV1::Permission,
        &chat.binding,
    )];
    assert_eq!(
        ConversationActivity::from_page(&asking).attention,
        ConversationAttention::ApprovalRequired
    );

    let mut failed = idle;
    failed.latest_failure = Some(AgentTimelineFailureV1 {
        item_id: AgentTimelineItemIdV1::new("failure-1").unwrap(),
        created_at_ms: 50,
        reason: AgentTurnFailureReasonV1::ProviderError,
        user_input: None,
    });
    let activity = ConversationActivity::from_page(&failed);
    assert_eq!(
        (
            activity.attention,
            activity.quiescent,
            activity.last_activity_ms
        ),
        (ConversationAttention::Error, true, 50),
        "a failed turn is idle and still counts as the newest activity"
    );
}

#[tokio::test]
async fn an_idle_chat_agent_sleeps_once_and_reports_it() {
    let chat = chat_agent().await;
    assert_eq!(
        observation::agent_runtime(&chat.state, &chat.agent)
            .await
            .unwrap(),
        json!({
            "state": "unavailable",
            "errorCode": "schedule_runtime_not_native",
            "conversation": {"activity": "waiting", "attention": "none"},
        })
    );

    // Not idle for long enough yet: nothing is stopped.
    let since = Duration::from_millis(u64::try_from(now_ms().unwrap()).unwrap() * 2);
    conversation::hibernate_if_idle(&chat.state, &chat.agent, since)
        .await
        .unwrap();
    assert_eq!(chat.stops.load(Ordering::SeqCst), 0);

    conversation::hibernate_if_idle(&chat.state, &chat.agent, IDLE_AFTER)
        .await
        .unwrap();
    assert_eq!(chat.stops.load(Ordering::SeqCst), 1);
    assert_eq!(
        observation::agent_runtime(&chat.state, &chat.agent).await,
        Err("schedule_runtime_sleeping")
    );

    // A sleeping agent is not stopped again.
    assert_eq!(
        conversation::hibernate_if_idle(&chat.state, &chat.agent, IDLE_AFTER).await,
        Err("runtime_idle_source_not_stable".to_owned())
    );
    assert_eq!(chat.stops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_chat_agent_without_a_conversation_is_not_stopped() {
    let chat = chat_agent_with(None).await;
    assert_eq!(
        conversation::hibernate_if_idle(&chat.state, &chat.agent, IDLE_AFTER).await,
        Err("agent_runtime_provider_conversation_unavailable".to_owned())
    );
    assert_eq!(chat.stops.load(Ordering::SeqCst), 0);
}
