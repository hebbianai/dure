use std::sync::Mutex as StdMutex;

use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

const SESSION: &str = "ses_history";

/// An OpenCode server that pages its session's messages newest first, at
/// most `page_size` messages per page, and records each request it answered.
struct FakeOpenCode {
    messages: Arc<StdMutex<Vec<Value>>>,
    requests: Arc<StdMutex<Vec<String>>>,
    port: u16,
    server: tokio::task::JoinHandle<()>,
}

impl FakeOpenCode {
    async fn start(messages: Vec<Value>, page_size: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let messages = Arc::new(StdMutex::new(messages));
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let server = tokio::spawn({
            let messages = Arc::clone(&messages);
            let requests = Arc::clone(&requests);
            async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut head = Vec::new();
                    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                        let mut buffer = [0; 1024];
                        let size = socket.read(&mut buffer).await.unwrap();
                        assert_ne!(size, 0);
                        head.extend_from_slice(&buffer[..size]);
                    }
                    let head = String::from_utf8(head).unwrap();
                    let target = head.split(' ').nth(1).unwrap().to_owned();
                    let (status, headers, body) =
                        answer(&target, &messages.lock().unwrap(), page_size);
                    requests.lock().unwrap().push(target);
                    let body = body.to_string();
                    // A client that stops reading an oversized answer closes
                    // the connection before the whole body is written.
                    let _ = socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len()).as_bytes()).await;
                }
            }
        });
        Self {
            messages,
            requests,
            port,
            server,
        }
    }

    fn push(&self, messages: Vec<Value>) {
        self.messages.lock().unwrap().extend(messages);
    }

    /// The message pages requested since the last call, as `limit` and
    /// `before` query strings.
    fn take_message_requests(&self) -> Vec<String> {
        std::mem::take(&mut *self.requests.lock().unwrap())
            .into_iter()
            .filter_map(|target| {
                target
                    .strip_prefix(&format!("/session/{SESSION}/message?"))
                    .map(str::to_owned)
            })
            .collect()
    }
}

impl Drop for FakeOpenCode {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn answer(target: &str, messages: &[Value], page_size: usize) -> (u16, String, Value) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/permission" | "/question" => (200, String::new(), json!([])),
        _ if path == format!("/session/{SESSION}/message") => {
            let mut limit = None;
            let mut end = messages.len();
            for pair in query.split('&') {
                match pair.split_once('=') {
                    Some(("limit", value)) => limit = Some(value.parse::<usize>().unwrap()),
                    Some(("before", value)) => {
                        end = value.strip_prefix("before-").unwrap().parse().unwrap();
                    }
                    _ => {}
                }
            }
            let start = end.saturating_sub(limit.unwrap().min(page_size));
            let headers = if start > 0 {
                format!("X-Next-Cursor: before-{start}\r\n")
            } else {
                String::new()
            };
            (200, headers, json!(messages[start..end]))
        }
        _ => match path
            .strip_prefix(&format!("/session/{SESSION}/message/"))
            .and_then(|id| messages.iter().find(|message| message["info"]["id"] == id))
        {
            Some(message) => (200, String::new(), message.clone()),
            None => (404, String::new(), Value::Null),
        },
    }
}

/// The user message and the assistant's answer of one imported turn. The
/// answer of an `oversized` turn alone is over the client's response bound.
fn turn(index: usize, oversized: bool) -> Vec<Value> {
    let text = if oversized {
        "A".repeat(9 * 1024 * 1024)
    } else {
        format!("Answer {index}")
    };
    turn_answered(index, text)
}

fn turn_answered(index: usize, text: String) -> Vec<Value> {
    let user = format!("msg_user{index:04}");
    let answer = format!("msg_answer{index:04}");
    let created = 1_000 + 10 * i64::try_from(index).unwrap();
    vec![
        json!({
            "info": {"id": user, "sessionID": SESSION, "role": "user", "time": {"created": created}},
            "parts": [{"id": format!("prt_user{index:04}"), "sessionID": SESSION, "messageID": user, "type": "text", "text": format!("Prompt {index}")}],
        }),
        json!({
            "info": {"id": answer, "sessionID": SESSION, "role": "assistant", "parentID": user, "finish": "stop", "time": {"created": created + 1, "completed": created + 2}},
            "parts": [{"id": format!("prt_answer{index:04}"), "sessionID": SESSION, "messageID": answer, "type": "text", "text": text}],
        }),
    ]
}

fn turns(range: std::ops::Range<usize>) -> Vec<Value> {
    range.flat_map(|index| turn(index, false)).collect()
}

async fn conversation_fixture() -> (
    TempDir,
    Arc<AgentConversationService<crate::SqliteDomainStore>>,
    AgentInteractionBindingV1,
) {
    let temporary = TempDir::new().unwrap();
    let store = Arc::new(
        crate::SqliteDomainStore::open(temporary.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-opencode-history").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-opencode-history").unwrap();
    let agent_id = AgentIdV1::new("agent-opencode-history").unwrap();
    let root = temporary.path().to_string_lossy().into_owned();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: root.clone(),
            display_name: "History".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: root,
            base_commit_sha: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id,
            provider_id: ProviderIdV1::new("opencode").unwrap(),
            display_name: "History".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    // A Terminal Agent's conversation that moved into Chat.
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-opencode-history")
            .unwrap(),
        agent_id,
        provider_id: ProviderIdV1::new("opencode").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some(SESSION.into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "opencode-runtime-history".into(),
            provider_epoch: "opencode-server-history".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("opencode-timeline-history").unwrap(),
        binding_revision: 1,
        history_complete: false,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    service.create(&binding).await.unwrap();
    (temporary, service, binding)
}

/// A bridge attached to the fake server, as `attach` builds one.
async fn bridge(
    server: &FakeOpenCode,
    binding: &AgentInteractionBindingV1,
    service: &Arc<AgentConversationService<crate::SqliteDomainStore>>,
) -> OpenCodeTimelineBridge<crate::SqliteDomainStore> {
    OpenCodeTimelineBridge {
        binding: binding.clone(),
        session: SessionId::parse(SESSION).unwrap(),
        client: OpenCodeSessionClient::new(
            server.port,
            "fixture-only".into(),
            Path::new("/fixture"),
        )
        .unwrap(),
        settings: ProviderTurnSettings::new(ProviderPermissionModeV1::Default, None, None),
        service: Arc::clone(service),
        journal: ProviderTimelineJournal::new(Arc::clone(service), binding)
            .await
            .unwrap(),
        projection: Mutex::new(Projection::default()),
        connected: AtomicBool::new(true),
        accepting: AtomicBool::new(true),
    }
}

/// The timeline's prompts, answers and history boundaries, in order.
async fn conversation(
    service: &Arc<AgentConversationService<crate::SqliteDomainStore>>,
    binding: &AgentInteractionBindingV1,
) -> Vec<String> {
    let journal = ProviderTimelineJournal::new(Arc::clone(service), binding)
        .await
        .unwrap();
    let mut rows = journal.existing_rows().await.unwrap().rows;
    rows.sort_by_key(|row| row.cursor.sequence);
    rows.iter()
        .filter_map(|row| match &row.item.body {
            AgentTimelineItemBodyV1::HistoryBoundary { reason, .. } => {
                Some(format!("boundary:{reason}"))
            }
            AgentTimelineItemBodyV1::Message { markdown, .. } if markdown.len() <= 64 => {
                Some(markdown.clone())
            }
            AgentTimelineItemBodyV1::Message { .. } => Some("clipped answer".into()),
            _ => None,
        })
        .collect()
}

async fn history_complete(
    service: &Arc<AgentConversationService<crate::SqliteDomainStore>>,
    binding: &AgentInteractionBindingV1,
) -> bool {
    service
        .binding(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap()
        .history_complete
}

fn prompts_and_answers(range: std::ops::Range<usize>) -> Vec<String> {
    range
        .flat_map(|index| [format!("Prompt {index}"), format!("Answer {index}")])
        .collect()
}

fn small_window(messages: usize) -> HistoryWindowBounds {
    HistoryWindowBounds {
        messages,
        bytes: HistoryWindowBounds::ATTACH.bytes,
    }
}

#[tokio::test]
async fn a_long_session_opens_with_its_newest_messages_behind_a_history_boundary() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let server = FakeOpenCode::start(turns(0..12), 4).await;
    let bridge = bridge(&server, &binding, &service).await;

    // The window's bound falls inside the second page, which it keeps whole.
    bridge.hydrate_within(small_window(6)).await.unwrap();

    let mut expected = vec!["boundary:provider_history_truncated".to_owned()];
    expected.extend(prompts_and_answers(8..12));
    assert_eq!(conversation(&service, &binding).await, expected);
    assert_eq!(
        server.take_message_requests(),
        ["limit=100", "limit=100&before=before-20"],
        "a window stops paging once it holds its bound"
    );
    assert!(!history_complete(&service, &binding).await);
}

#[tokio::test]
async fn a_session_read_to_its_start_opens_without_a_boundary() {
    for (count, page_size) in [(0, 100), (5, 100), (5, 4)] {
        let (_temporary, service, binding) = conversation_fixture().await;
        let server = FakeOpenCode::start(turns(0..count), page_size).await;
        let bridge = bridge(&server, &binding, &service).await;

        bridge.hydrate().await.unwrap();

        assert_eq!(
            conversation(&service, &binding).await,
            prompts_and_answers(0..count)
        );
        // The moved Terminal conversation is whole, so automatic turns and
        // recovery admit it.
        assert!(
            history_complete(&service, &binding).await,
            "{count} messages"
        );
    }
}

#[tokio::test]
async fn a_reattach_pages_back_only_to_the_messages_the_timeline_holds() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let server = FakeOpenCode::start(turns(0..3), 4).await;
    bridge(&server, &binding, &service)
        .await
        .hydrate()
        .await
        .unwrap();
    server.take_message_requests();
    // The Terminal continues the conversation while Chat is away.
    server.push(turns(3..5));

    bridge(&server, &binding, &service)
        .await
        .hydrate()
        .await
        .unwrap();

    assert_eq!(
        conversation(&service, &binding).await,
        prompts_and_answers(0..5),
        "each message once, in order, without a boundary"
    );
    assert_eq!(
        server.take_message_requests(),
        ["limit=100", "limit=100&before=before-6"],
        "the second page reaches held messages, so the oldest page is not read"
    );
}

#[tokio::test]
async fn a_reattach_marks_terminal_history_it_cannot_reach_back_to() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let server = FakeOpenCode::start(turns(0..2), 4).await;
    bridge(&server, &binding, &service)
        .await
        .hydrate()
        .await
        .unwrap();
    server.push(turns(2..12));

    bridge(&server, &binding, &service)
        .await
        .hydrate_within(small_window(6))
        .await
        .unwrap();

    let mut expected = prompts_and_answers(0..2);
    expected.push("boundary:provider_history_truncated".into());
    expected.extend(prompts_and_answers(8..12));
    assert_eq!(conversation(&service, &binding).await, expected);
}

#[tokio::test]
async fn a_message_too_large_to_read_is_left_out_behind_a_boundary() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let mut messages = turns(0..1);
    messages.extend(turn(1, true));
    messages.extend(turns(2..5));
    let server = FakeOpenCode::start(messages, 100).await;
    let bridge = bridge(&server, &binding, &service).await;

    // Before, the whole history's newest page was over the response bound,
    // so the attach failed and Chat could not open.
    bridge.hydrate().await.unwrap();

    let mut expected = prompts_and_answers(0..1);
    expected.push("Prompt 1".into());
    expected.push("boundary:provider_history_truncated".into());
    expected.extend(prompts_and_answers(2..5));
    assert_eq!(conversation(&service, &binding).await, expected);
    let requests = server.take_message_requests();
    assert_eq!(
        requests[..4],
        [
            "limit=100",
            "limit=10",
            "limit=1",
            "limit=100&before=before-9"
        ],
        "a page over the response bound is read again in smaller pages"
    );
    assert_eq!(
        requests[requests.len() - 3..],
        [
            "limit=1&before=before-4",
            "limit=1&before=before-3",
            "limit=100&before=before-2"
        ],
        "the oversized answer alone is skipped, and the history before it read"
    );
}

#[tokio::test]
async fn a_newest_message_too_large_to_read_still_fails_the_attach() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let mut messages = turns(0..2);
    messages.extend(turn(2, true));
    let server = FakeOpenCode::start(messages, 100).await;
    let bridge = bridge(&server, &binding, &service).await;

    // The live path and an active turn's completion depend on that message.
    let error = bridge.hydrate().await.unwrap_err();

    assert_eq!(
        (error.code.as_str(), error.detail.as_str()),
        ("opencode_session_unavailable", "Limit")
    );
    assert!(conversation(&service, &binding).await.is_empty());
}

#[tokio::test]
async fn each_page_is_asked_for_at_the_size_its_messages_fit() {
    let (_temporary, service, binding) = conversation_fixture().await;
    // Small older turns, then ten turns whose answers are 1 MiB each.
    let mut messages = turns(0..30);
    messages.extend((30..40).flat_map(|index| turn_answered(index, "A".repeat(1024 * 1024))));
    let server = FakeOpenCode::start(messages, 100).await;
    let bridge = bridge(&server, &binding, &service).await;

    bridge.hydrate().await.unwrap();

    let mut expected = prompts_and_answers(0..30);
    expected
        .extend((30..40).flat_map(|index| [format!("Prompt {index}"), "clipped answer".into()]));
    assert_eq!(conversation(&service, &binding).await, expected);
    assert_eq!(
        server.take_message_requests(),
        [
            "limit=100",
            "limit=10",
            "limit=10&before=before-70",
            "limit=10&before=before-60",
            "limit=100&before=before-50",
        ],
        "large messages are not first asked for at a size they cannot be read at, \
         and small ones are read in full pages again"
    );
}

#[tokio::test]
async fn live_changes_to_messages_behind_the_boundary_are_left_out() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let server = FakeOpenCode::start(turns(0..12), 4).await;
    let bridge = bridge(&server, &binding, &service).await;
    bridge.hydrate_within(small_window(6)).await.unwrap();
    let changed = |id: &str| json!({"type": "message.updated", "properties": {"info": {"id": id, "sessionID": SESSION}}});

    // OpenCode changes an old message, for example when it prunes old tool
    // output, and the conversation continues.
    bridge
        .handle_event(&changed("msg_answer0002"))
        .await
        .unwrap();
    server.push(turns(12..13));
    bridge.handle_event(&changed("msg_user0012")).await.unwrap();
    bridge
        .handle_event(&changed("msg_answer0012"))
        .await
        .unwrap();

    let mut expected = vec!["boundary:provider_history_truncated".to_owned()];
    expected.extend(prompts_and_answers(8..13));
    assert_eq!(conversation(&service, &binding).await, expected);
}
