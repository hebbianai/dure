use std::sync::Mutex as StdMutex;

use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

const SESSION: &str = "ses_history";

/// An OpenCode server that pages its session's messages newest first, at
/// most `page_size` messages per page, and records each request it answered.
struct FakeOpenCode {
    messages: Arc<StdMutex<Vec<SerializedMessage>>>,
    requests: Arc<StdMutex<Vec<String>>>,
    port: u16,
    server: tokio::task::JoinHandle<()>,
}

impl FakeOpenCode {
    async fn start(messages: Vec<Value>, page_size: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let messages = Arc::new(StdMutex::new(serialized(messages)));
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
        self.messages.lock().unwrap().extend(serialized(messages));
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

/// A message's id and its JSON, serialized once, since some are larger than
/// the client reads of one record.
struct SerializedMessage {
    id: String,
    json: String,
}

fn serialized(messages: Vec<Value>) -> Vec<SerializedMessage> {
    messages
        .into_iter()
        .map(|message| SerializedMessage {
            id: message["info"]["id"].as_str().unwrap().to_owned(),
            json: message.to_string(),
        })
        .collect()
}

fn answer(target: &str, messages: &[SerializedMessage], page_size: usize) -> (u16, String, String) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/permission" | "/question" => (200, String::new(), "[]".into()),
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
            let page = messages[start..end]
                .iter()
                .map(|message| message.json.as_str())
                .collect::<Vec<_>>();
            (200, headers, format!("[{}]", page.join(",")))
        }
        _ => match path
            .strip_prefix(&format!("/session/{SESSION}/message/"))
            .and_then(|id| messages.iter().find(|message| message.id == id))
        {
            Some(message) => (200, String::new(), message.json.clone()),
            None => (404, String::new(), "null".into()),
        },
    }
}

/// The user message and the assistant's answer of one imported turn. The
/// answer of an `oversized` turn is over the bound of one record, which the
/// client reads of one message.
fn turn(index: usize, oversized: bool) -> Vec<Value> {
    let text = if oversized {
        "A".repeat(64 * 1024 * 1024)
    } else {
        format!("Answer {index}")
    };
    turn_answered(index, text)
}

/// When the user message of turn `index` was created; its answer follows a
/// millisecond later.
fn created_at(index: usize) -> i64 {
    1_000 + 10 * i64::try_from(index).unwrap()
}

fn turn_answered(index: usize, text: String) -> Vec<Value> {
    let user = format!("msg_user{index:04}");
    let answer = format!("msg_answer{index:04}");
    let created = created_at(index);
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
        places: std::sync::Mutex::default(),
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

    // The window's bound falls inside the second page, which it keeps whole
    // but for its oldest message: a message created at the same time may sit
    // on the next page, so the history before the window holds it.
    bridge.hydrate_within(small_window(6)).await.unwrap();

    let mut expected = vec![
        "boundary:provider_transcript_window".to_owned(),
        "Answer 8".to_owned(),
    ];
    expected.extend(prompts_and_answers(9..12));
    assert_eq!(conversation(&service, &binding).await, expected);
    assert_eq!(
        window_place(&service, &binding).await,
        Some(created_at(8) + 1),
        "placed where the window's oldest message was created"
    );
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

/// An answer larger than an answer of several messages, as OpenCode keeps a
/// message whose `read` tool attached a large image or PDF.
fn large_answer() -> String {
    "A".repeat(9 * 1024 * 1024)
}

#[tokio::test]
async fn a_message_larger_than_a_page_opens_in_chat_as_one_record() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let mut messages = turns(0..1);
    messages.extend(turn_answered(1, large_answer()));
    messages.extend(turns(2..4));
    let server = FakeOpenCode::start(messages, 100).await;
    let bridge = bridge(&server, &binding, &service).await;

    // Before, that message was over the client's bound even alone, so a
    // boundary row stood in its place.
    bridge.hydrate().await.unwrap();

    let mut expected = prompts_and_answers(0..1);
    expected.extend(["Prompt 1".into(), "clipped answer".into()]);
    expected.extend(prompts_and_answers(2..4));
    assert_eq!(conversation(&service, &binding).await, expected);
    assert!(history_complete(&service, &binding).await);
}

#[tokio::test]
async fn a_live_message_larger_than_a_page_keeps_chat_connected() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let server = FakeOpenCode::start(turns(0..2), 100).await;
    let bridge = bridge(&server, &binding, &service).await;
    bridge.hydrate().await.unwrap();
    let changed = |id: &str| json!({"type": "message.updated", "properties": {"info": {"id": id, "sessionID": SESSION}}});

    // Before, reading the changed message failed, which ended the live
    // event loop, so Chat disconnected in the middle of the turn.
    server.push(turn_answered(2, large_answer()));
    bridge.handle_event(&changed("msg_user0002")).await.unwrap();
    bridge
        .handle_event(&changed("msg_answer0002"))
        .await
        .unwrap();

    let mut expected = prompts_and_answers(0..2);
    expected.extend(["Prompt 2".into(), "clipped answer".into()]);
    assert_eq!(conversation(&service, &binding).await, expected);
    // A reattach while that message is the newest reads it again.
    bridge.hydrate().await.unwrap();
    assert_eq!(conversation(&service, &binding).await, expected);
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

    let mut expected = vec![
        "boundary:provider_transcript_window".to_owned(),
        "Answer 8".to_owned(),
    ];
    expected.extend(prompts_and_answers(9..13));
    assert_eq!(conversation(&service, &binding).await, expected);
}

/// Where the boundary that opens the timeline's history is placed: the
/// cursor "Show earlier history" reads before.
async fn window_place(
    service: &Arc<AgentConversationService<crate::SqliteDomainStore>>,
    binding: &AgentInteractionBindingV1,
) -> Option<i64> {
    let journal = ProviderTimelineJournal::new(Arc::clone(service), binding)
        .await
        .unwrap();
    let rows = journal.existing_rows().await.unwrap().rows;
    rows.iter()
        .find_map(|row| row.item.body.transcript_history_start())
}

/// A message's text as far as its index: "Prompt 3", "Answer 3".
fn label(text: &str) -> String {
    text.split(' ').take(2).collect::<Vec<_>>().join(" ")
}

/// The history before `place`, read through the bridge page by page as the
/// backend reads it for "Show earlier history", until the session's start:
/// each page's labels, oldest page first.
async fn earlier_history(
    bridge: &OpenCodeTimelineBridge<crate::SqliteDomainStore>,
    binding: &AgentInteractionBindingV1,
    place: i64,
) -> Vec<Vec<String>> {
    let mut pages = Vec::new();
    let mut before = Some(u64::try_from(place).unwrap());
    while let Some(cursor) = before {
        let page = bridge.read_history(binding, cursor, 0).await.unwrap();
        assert_eq!(page["provider"], "opencode");
        assert_eq!(page["conversationId"], SESSION);
        before = page.get("olderCursor").and_then(Value::as_u64);
        assert!(before.is_none_or(|older| older < cursor), "pages move back");
        assert_eq!(
            page["historyComplete"],
            before.is_none(),
            "only the oldest page reaches the start"
        );
        pages.insert(
            0,
            page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| label(entry["text"].as_str().unwrap()))
                .collect(),
        );
    }
    pages
}

fn labels(range: std::ops::Range<usize>) -> Vec<String> {
    range
        .flat_map(|index| [format!("Prompt {index}"), format!("Answer {index}")])
        .collect()
}

/// Before, a long OpenCode session opened behind "Part of the provider
/// history is unavailable." and nothing older could be read. Now its older
/// history pages back from the window's boundary: each message once, in
/// order, joining the window exactly, with the calls between its messages.
#[tokio::test]
async fn show_earlier_history_pages_back_from_the_window_to_the_sessions_start() {
    let (_temporary, service, binding) = conversation_fixture().await;
    // Answers long enough to be clipped, so that a backend page holds four.
    let mut messages = (0..12)
        .flat_map(|index| turn_answered(index, format!("Answer {index} {}", "a".repeat(150_000))))
        .collect::<Vec<_>>();
    messages[5]["parts"].as_array_mut().unwrap().push(json!({
        "id": "prt_tool0002", "sessionID": SESSION, "messageID": "msg_answer0002",
        "type": "tool", "callID": "call-2", "tool": "bash",
        "state": {"status": "completed", "input": {"command": "ls"}, "output": "files"},
    }));
    let server = FakeOpenCode::start(messages, 4).await;
    let bridge = bridge(&server, &binding, &service).await;
    bridge.hydrate_within(small_window(6)).await.unwrap();
    let place = window_place(&service, &binding).await.unwrap();
    server.take_message_requests();

    let pages = earlier_history(&bridge, &binding, place).await;

    let mut newest = labels(4..8);
    newest.push("Prompt 8".into());
    assert_eq!(pages, [labels(0..4), newest]);
    // The window goes on from there: Answer 8, then turns 9 to 11.
    let mut window = vec!["boundary:provider_transcript_window".to_owned()];
    for index in 8..12 {
        if index > 8 {
            window.push(format!("Prompt {index}"));
        }
        window.push("clipped answer".into());
    }
    assert_eq!(conversation(&service, &binding).await, window);
    assert_eq!(
        server.take_message_requests()[0],
        "limit=100&before=before-20",
        "the first page starts at the window's last page, not at the newest"
    );
    let page = bridge
        .read_history(&binding, u64::try_from(created_at(3)).unwrap(), 0)
        .await
        .unwrap();
    assert_eq!(
        page["tools"],
        json!([{"afterEntries": 6, "callId": "call-2", "name": "bash", "state": "completed", "input": {"command": "ls"}}]),
        "a call sits after the message it was made in"
    );
}

/// A message created in the millisecond of the message before it never ends
/// the window without it: the window opens at the oldest time it holds every
/// message of, and the history before it holds the rest.
#[tokio::test]
async fn a_window_never_ends_between_messages_created_at_once() {
    let mut messages = turns(0..5);
    // Turns 3 and 4 answer in the millisecond they were asked.
    for index in [3, 4] {
        messages[2 * index + 1]["info"]["time"]["created"] = json!(created_at(index));
    }
    // One message a page, so the window's pages split turn 3.
    let server = FakeOpenCode::start(messages, 1).await;

    let (_temporary, service, binding) = conversation_fixture().await;
    let seeded = bridge(&server, &binding, &service).await;
    seeded.hydrate_within(small_window(3)).await.unwrap();

    let mut expected = vec!["boundary:provider_transcript_window".to_owned()];
    expected.extend(prompts_and_answers(4..5));
    assert_eq!(conversation(&service, &binding).await, expected);
    let place = window_place(&service, &binding).await.unwrap();
    assert_eq!(place, created_at(4));
    assert_eq!(
        earlier_history(&seeded, &binding, place).await.concat(),
        labels(0..4)
    );

    // A window whose messages were all created at once has no such time:
    // it opens behind the boundary at no place, as before.
    let (_temporary, service, binding) = conversation_fixture().await;
    bridge(&server, &binding, &service)
        .await
        .hydrate_within(small_window(1))
        .await
        .unwrap();
    assert_eq!(
        conversation(&service, &binding).await,
        ["boundary:provider_history_truncated", "Answer 4"]
    );
}

/// A page of earlier history ends before the messages of a time it cannot
/// hold whole, so the next page shows them together.
#[tokio::test]
async fn a_page_never_ends_between_messages_created_at_once() {
    let (_temporary, service, binding) = conversation_fixture().await;
    // Long enough to be clipped: a backend page holds four of them.
    let long = |text: String| format!("{text} {}", "b".repeat(200_000));
    let mut messages = turns(0..1);
    for index in 1..4 {
        messages.extend(turn_answered(index, long(format!("Answer {index}"))));
    }
    messages.extend(turns(4..5));
    // Turn 1's long prompt and long answer were created at once, and turn
    // 2's prompt is long too: the newest page holds turn 1's answer beside
    // turns 2 and 3 only without its prompt.
    for index in [1, 2] {
        messages[2 * index]["parts"][0]["text"] = json!(long(format!("Prompt {index}")));
    }
    messages[3]["info"]["time"]["created"] = json!(created_at(1));
    let server = FakeOpenCode::start(messages, 100).await;
    let bridge = bridge(&server, &binding, &service).await;

    let pages = earlier_history(&bridge, &binding, created_at(4)).await;

    assert_eq!(pages, [labels(0..2), labels(2..4)]);
}

/// A bridge that has not read past a place, as after the control plane
/// restarted and Chat reattached, reads the same pages from the newest.
#[tokio::test]
async fn a_bridge_reads_a_place_it_has_not_read_past_from_the_newest() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let server = FakeOpenCode::start(turns(0..12), 4).await;
    let seeded = bridge(&server, &binding, &service).await;
    seeded.hydrate_within(small_window(6)).await.unwrap();
    let place = window_place(&service, &binding).await.unwrap();
    let expected = earlier_history(&seeded, &binding, place).await;
    server.take_message_requests();

    let reattached = bridge(&server, &binding, &service).await;
    let pages = earlier_history(&reattached, &binding, place).await;

    assert_eq!(pages, expected);
    let mut whole = labels(0..8);
    whole.push("Prompt 8".into());
    assert_eq!(pages.concat(), whole);
    assert_eq!(
        server.take_message_requests()[0],
        "limit=100",
        "it starts at the newest message"
    );
}

/// A window that reaches the messages the timeline holds keeps none of the
/// older messages its last page also holds: they come before the boundary
/// the timeline opened with, so appending them would show them after it.
/// Before, they were appended at the end whenever a reattach read a page
/// larger than the window's, as after its messages got smaller.
#[tokio::test]
async fn a_reattach_never_appends_messages_from_behind_the_boundary() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let seeding = FakeOpenCode::start(turns(0..12), 4).await;
    bridge(&seeding, &binding, &service)
        .await
        .hydrate_within(small_window(6))
        .await
        .unwrap();
    let before = conversation(&service, &binding).await;

    // The Terminal continues the conversation, and the reattach reads the
    // whole session in one page.
    let reattach = FakeOpenCode::start(turns(0..14), 100).await;
    bridge(&reattach, &binding, &service)
        .await
        .hydrate()
        .await
        .unwrap();

    let mut expected = before;
    expected.extend(prompts_and_answers(12..14));
    assert_eq!(conversation(&service, &binding).await, expected);
}

/// A read of a session whose messages are not in creation order is refused
/// rather than joined by a place that means nothing there.
#[tokio::test]
async fn history_out_of_creation_order_is_refused() {
    let (_temporary, service, binding) = conversation_fixture().await;
    let mut messages = turns(0..4);
    messages[1]["info"]["time"]["created"] = json!(5_000);
    let server = FakeOpenCode::start(messages, 100).await;
    let bridge = bridge(&server, &binding, &service).await;

    let error = bridge
        .read_history(&binding, u64::try_from(created_at(3)).unwrap(), 0)
        .await
        .unwrap_err();

    assert_eq!(error.code, "opencode_protocol_invalid");
}
