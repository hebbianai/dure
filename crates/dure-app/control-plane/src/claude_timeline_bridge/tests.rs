use std::collections::VecDeque;
use std::sync::Mutex;

use dure_app::{
    AgentExecutionProfileV1, AgentIdV1, AgentInteractionBindingV1, AgentInteractionSessionIdV1,
    AgentProviderRuntimeFenceV1, AgentRecordV1, AgentTimelineEpochV1, AgentTimelineItemBodyV1,
    AgentTimelineMessageRoleV1, AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTimelineStore, AgentTimelineToolStateV1, DomainStore, ProjectIdV1,
    ProjectRecordV1, ProviderIdV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use tempfile::TempDir;

use super::*;

#[derive(Clone)]
struct FakeTransport {
    state: Arc<Mutex<FakeTransportState>>,
    store: Arc<SqliteDomainStore>,
}

struct FakeTransportState {
    history_ack_failures: usize,
    history: Value,
    /// The host lets a Query's history go once it is acknowledged.
    history_released: bool,
    calls: Vec<(String, Value)>,
    pending: VecDeque<Value>,
    replay: VecDeque<Value>,
}

impl FakeTransport {
    fn new(
        store: Arc<SqliteDomainStore>,
        replay: impl IntoIterator<Item = Value>,
        pending: impl IntoIterator<Item = Value>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeTransportState {
                history_ack_failures: 0,
                history_released: false,
                history: json!({
                    "status": "complete",
                    "offset": 0,
                    "nextOffset": 2,
                    "hasMore": false,
                    "items": [
                        {
                            "sourceId": "history-user-1:message:0",
                            "createdAtMs": 10,
                            "providerMessageId": null,
                            "body": {
                                "type": "message",
                                "role": "user",
                                "markdown": "prior question"
                            }
                        },
                        {
                            "sourceId": "history-assistant-1:text:0",
                            "createdAtMs": 11,
                            "providerMessageId": "history-assistant-message-1",
                            "body": {
                                "type": "message",
                                "role": "assistant",
                                "markdown": "prior answer"
                            }
                        }
                    ]
                }),
                calls: Vec::new(),
                pending: pending.into_iter().collect(),
                replay: replay.into_iter().collect(),
            })),
            store,
        }
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.state.lock().unwrap().calls.clone()
    }

    fn fail_history_acks(self, count: usize) -> Self {
        self.state.lock().unwrap().history_ack_failures = count;
        self
    }

    fn with_history(self, history: Value) -> Self {
        self.state.lock().unwrap().history = history;
        self
    }
}

impl ClaudeDch1Transport for FakeTransport {
    fn call<'a>(&'a self, action: &'a str, payload: Value) -> ClaudeDch1TransportFuture<'a> {
        let response = {
            let mut state = self.state.lock().unwrap();
            state.calls.push((action.into(), payload.clone()));
            match action {
                "replay" => state
                    .replay
                    .pop_front()
                    .ok_or_else(|| ClaudeTimelineBridgeError::new("fixture_replay_exhausted")),
                "pending_snapshot" => state
                    .pending
                    .pop_front()
                    .ok_or_else(|| ClaudeTimelineBridgeError::new("fixture_pending_exhausted")),
                "history_page" if state.history_released => {
                    Err(ClaudeTimelineBridgeError::new(HISTORY_RELEASED))
                }
                "history_page" => Ok(state.history.clone()),
                "ack_history" => {
                    // A lost response still released the history.
                    state.history_released = true;
                    if state.history_ack_failures > 0 {
                        state.history_ack_failures -= 1;
                        Err(ClaudeTimelineBridgeError::new(
                            "fixture_history_ack_response_lost",
                        ))
                    } else {
                        Ok(Value::Null)
                    }
                }
                "ack" => Ok(Value::Null),
                "start_turn" => Ok(json!({
                    "acceptedEventSequence": 4,
                    "clientMessageId": "client-claude-1"
                })),
                "answer_interaction" => Ok(json!({
                    "outcome": "allow",
                    "requestId": "request-claude-1"
                })),
                "interrupt_turn" => Ok(json!({ "receiptAvailable": true })),
                _ => Err(ClaudeTimelineBridgeError::new("fixture_action_unknown")),
            }
        };
        Box::pin(async move {
            if action == "ack" {
                let sequence = payload
                    .get("sequence")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| ClaudeTimelineBridgeError::new("fixture_ack_invalid"))?;
                let cursor = self
                    .store
                    .agent_provider_cursor(
                        &AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
                        &runtime(),
                    )
                    .await
                    .map_err(|error| ClaudeTimelineBridgeError::new(error.to_string()))?;
                if cursor.committed_through_sequence < sequence {
                    return Err(ClaudeTimelineBridgeError::new("ack_before_commit"));
                }
            }
            response
        })
    }
}

#[tokio::test]
async fn incomplete_history_releases_the_snapshot_and_continues_live_replay() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [json!({
            "events": [],
            "gap": null,
            "hasMore": false,
            "latestSequence": 0,
            "nextAfterSequence": 0
        })],
        [json!({
            "observedThroughSequence": 0,
            "requests": []
        })],
    )
    .with_history(json!({
        "status": "incomplete",
        "offset": 0,
        "nextOffset": 0,
        "hasMore": false,
        "items": [],
        "reason": "history_unavailable"
    }));
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    let page = tail(&store).await;
    assert!(!page.binding.history_complete);
    assert!(page.rows.is_empty());
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .map(|(action, _)| action)
            .collect::<Vec<_>>(),
        vec!["history_page", "ack_history", "replay", "pending_snapshot"]
    );
}

/// A conversation longer than one snapshot arrives as its newest window behind
/// a history boundary. Chat shows that window instead of an empty timeline,
/// keeps the history incomplete, and never asks for it again.
#[tokio::test]
async fn windowed_history_commits_behind_its_boundary_and_is_never_reseeded() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let replay = || {
        json!({
            "events": [],
            "gap": null,
            "hasMore": false,
            "latestSequence": 0,
            "nextAfterSequence": 0
        })
    };
    let pending = || json!({ "observedThroughSequence": 0, "requests": [] });
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [replay(), replay()],
        [pending(), pending()],
    )
    .with_history(json!({
        "status": "complete",
        "offset": 0,
        "nextOffset": 2,
        "hasMore": false,
        "items": [
            {
                "sourceId": "history-boundary",
                "createdAtMs": 10,
                "providerMessageId": null,
                "body": {
                    "type": "history_boundary",
                    "reason": "provider_history_truncated",
                    "requested_after_provider_sequence": 0,
                    "dropped_through_provider_sequence": 900
                }
            },
            {
                "sourceId": "history-assistant-901:message:0",
                "createdAtMs": 10,
                "providerMessageId": "msg_901",
                "body": {
                    "type": "message",
                    "role": "assistant",
                    "markdown": "the newest answer"
                }
            }
        ]
    }));
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let mut notifications = service.subscribe();
    let bridge = ClaudeTimelineBridge::new(
        Arc::clone(&service),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    // An open Chat pane learns about the seeded rows without a new turn.
    let notification = notifications.try_recv().unwrap();
    assert_eq!(
        notification.interaction_session_id.as_str(),
        "interaction-claude"
    );
    assert_eq!(
        notification.kinds,
        vec![crate::agent_conversation::AgentConversationNotificationKindV1::Timeline]
    );
    let page = tail(&store).await;
    assert!(!page.binding.history_complete);
    assert_eq!(page.rows.len(), 2);
    assert!(matches!(
        page.rows[0].item.body,
        AgentTimelineItemBodyV1::HistoryBoundary { .. }
    ));
    assert!(matches!(
        &page.rows[1].item.body,
        AgentTimelineItemBodyV1::Message { markdown, .. } if markdown == "the newest answer"
    ));

    // A later attachment of the same Query finds its history released and
    // never seeds the window again.
    let reattached = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();
    reattached.reconcile().await.unwrap();
    assert_eq!(tail(&store).await.rows.len(), 2);
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .map(|(action, _)| action)
            .collect::<Vec<_>>(),
        vec![
            "history_page",
            "ack_history",
            "replay",
            "pending_snapshot",
            "history_page",
            "replay",
            "pending_snapshot",
        ]
    );
}

/// A conversation the provider compacted arrives from its summary behind the
/// compaction boundary. The provider resumes from exactly these rows, so the
/// history commits complete, with the boundary placing the transcript records
/// before it for Chat to page in.
#[tokio::test]
async fn compacted_history_commits_complete_behind_its_compaction_boundary() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [json!({
            "events": [],
            "gap": null,
            "hasMore": false,
            "latestSequence": 0,
            "nextAfterSequence": 0
        })],
        [json!({ "observedThroughSequence": 0, "requests": [] })],
    )
    .with_history(json!({
        "status": "complete",
        "offset": 0,
        "nextOffset": 2,
        "hasMore": false,
        "items": [
            {
                "sourceId": "history-boundary",
                "createdAtMs": 10,
                "providerMessageId": null,
                "body": {
                    "type": "history_boundary",
                    "reason": "provider_conversation_compacted",
                    "requested_after_provider_sequence": 0,
                    "dropped_through_provider_sequence": 4096
                }
            },
            {
                "sourceId": "history-summary:message:0",
                "createdAtMs": 10,
                "providerMessageId": null,
                "body": {
                    "type": "message",
                    "role": "user",
                    "markdown": "This session is being continued from a previous conversation."
                }
            }
        ]
    }));
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    let page = tail(&store).await;
    assert!(page.binding.history_complete);
    assert_eq!(page.rows.len(), 2);
    assert!(matches!(
        &page.rows[0].item.body,
        AgentTimelineItemBodyV1::HistoryBoundary {
            reason,
            dropped_through_provider_sequence: 4096,
            ..
        } if reason == dure_app::PROVIDER_COMPACTION_HISTORY_BOUNDARY_V1
    ));
}

/// The host packs a window up to the snapshot byte bound as it encodes it. A
/// started tool call arrives without an output field, so a re-encoding that
/// writes `"output":null` would grow past the bound the host kept.
#[tokio::test]
async fn a_window_packed_to_the_byte_bound_is_measured_as_received() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let tool = |index: usize, padding: &str| {
        json!({
            "sourceId": format!("history-{index:04}:tool-start:0"),
            "createdAtMs": 10,
            "providerMessageId": format!("msg_{index:04}"),
            "body": {
                "type": "tool",
                "tool_call_id": format!("toolu_{index:04}"),
                "name": "Read",
                "state": "running",
                "input": { "path": padding }
            }
        })
    };
    let count = MAX_AGENT_HISTORY_ITEMS_V1;
    let base = serde_json::to_vec(&tool(0, "")).unwrap().len();
    // Leave less room than the omitted `"output":null` fields would take.
    let target = (MAX_HISTORY_BYTES - count * 8) / count;
    let padding = "p".repeat(target - base);
    let items = (0..count)
        .map(|index| tool(index, &padding))
        .collect::<Vec<_>>();
    let received = items
        .iter()
        .map(|item| serde_json::to_vec(item).unwrap().len())
        .sum::<usize>();
    assert!(received <= MAX_HISTORY_BYTES);
    assert!(received + count * ",\"output\":null".len() > MAX_HISTORY_BYTES);
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [json!({
            "events": [],
            "gap": null,
            "hasMore": false,
            "latestSequence": 0,
            "nextAfterSequence": 0
        })],
        [json!({ "observedThroughSequence": 0, "requests": [] })],
    )
    .with_history(json!({
        "status": "complete",
        "offset": 0,
        "nextOffset": count,
        "hasMore": false,
        "items": items
    }));
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport,
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    let page = tail(&store).await;
    assert!(page.binding.history_complete);
    assert!(matches!(
        &page.rows.last().unwrap().item.body,
        AgentTimelineItemBodyV1::Tool { tool_call_id, output: None, .. }
            if tool_call_id == &format!("toolu_{:04}", count - 1)
    ));
}

fn identity() -> ClaudeDch1QueryIdentity {
    ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-claude-1".into(),
        query_epoch: "query-claude-1".into(),
        relay_id: "relay-claude-1".into(),
    }
}

fn runtime() -> AgentProviderRuntimeFenceV1 {
    AgentProviderRuntimeFenceV1 {
        runtime_generation: identity().runtime_generation,
        provider_epoch: identity().query_epoch,
    }
}

async fn fixture(path: &std::path::Path) -> Arc<SqliteDomainStore> {
    fixture_with_provider_ref(path, Some("session-claude-1")).await
}

async fn fixture_with_provider_ref(
    path: &std::path::Path,
    provider_conversation_ref: Option<&str>,
) -> Arc<SqliteDomainStore> {
    fixture_with_history_state(path, provider_conversation_ref, true).await
}

async fn fixture_with_history_state(
    path: &std::path::Path,
    provider_conversation_ref: Option<&str>,
    history_complete: bool,
) -> Arc<SqliteDomainStore> {
    let store = Arc::new(SqliteDomainStore::open(path).await.unwrap());
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-claude").unwrap(),
            root_path: "/workspace/claude".into(),
            display_name: "Claude".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-claude").unwrap(),
            project_id: ProjectIdV1::new("project-claude").unwrap(),
            root_path: "/workspace/claude/.worktrees/agent".into(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: AgentIdV1::new("agent-claude").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-claude").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            display_name: "Claude".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    store
        .create_agent_interaction(&AgentInteractionBindingV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
            agent_id: AgentIdV1::new("agent-claude").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "credential.claude-a".into(),
                credential_generation: Some("credential-generation-1".into()),
            },
            provider_conversation_ref: provider_conversation_ref.map(str::to_owned),
            runtime: runtime(),
            timeline_epoch: AgentTimelineEpochV1::new("timeline-claude-1").unwrap(),
            binding_revision: 1,
            history_complete,
            created_at_ms: 4,
            updated_at_ms: 4,
        })
        .await
        .unwrap();
    store
}

#[tokio::test]
async fn exact_resume_history_is_committed_before_live_evidence_and_only_once() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [
            json!({
                "events": [{
                    "sequence": 1,
                    "kind": "provider_event",
                    "payload": { "type": "system", "subtype": "hook_started" }
                }],
                "gap": null,
                "hasMore": false,
                "latestSequence": 1,
                "nextAfterSequence": 1
            }),
            json!({
                "events": [],
                "gap": null,
                "hasMore": false,
                "latestSequence": 1,
                "nextAfterSequence": 1
            }),
        ],
        [
            json!({ "observedThroughSequence": 1, "requests": [] }),
            json!({ "observedThroughSequence": 1, "requests": [] }),
        ],
    );
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    bridge.reconcile().await.unwrap();

    let page = tail(&store).await;
    assert!(page.binding.history_complete);
    assert_eq!(page.rows.len(), 3);
    assert!(matches!(
        &page.rows[0].item.body,
        AgentTimelineItemBodyV1::Message { role, markdown }
            if *role == AgentTimelineMessageRoleV1::User && markdown == "prior question"
    ));
    assert_eq!(
        page.rows[0].item.item_id.as_str(),
        format!(
            "claude-history-{}",
            digest(&("session-claude-1", "history-user-1:message:0")).unwrap()
        )
    );
    assert!(matches!(
        &page.rows[1].item.body,
        AgentTimelineItemBodyV1::Message { role, markdown }
            if *role == AgentTimelineMessageRoleV1::Assistant && markdown == "prior answer"
    ));
    assert!(matches!(
        &page.rows[2].item.body,
        AgentTimelineItemBodyV1::ProviderEvidence { .. }
    ));
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .map(|(action, _)| action)
            .collect::<Vec<_>>(),
        vec![
            "history_page",
            "ack_history",
            "replay",
            "ack",
            "pending_snapshot",
            "replay",
            "pending_snapshot",
            "ack",
        ]
    );
}

#[tokio::test]
async fn committed_history_retries_an_exact_lost_ack_without_reseeding() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [json!({
            "events": [],
            "gap": null,
            "hasMore": false,
            "latestSequence": 0,
            "nextAfterSequence": 0
        })],
        [json!({ "observedThroughSequence": 0, "requests": [] })],
    )
    .fail_history_acks(1);
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    assert_eq!(
        bridge.reconcile().await.unwrap_err().reason(),
        "fixture_history_ack_response_lost"
    );
    let committed = tail(&store).await;
    assert!(committed.binding.history_complete);
    assert_eq!(committed.rows.len(), 2);

    bridge.reconcile().await.unwrap();
    let converged = tail(&store).await;
    assert!(converged.binding.history_complete);
    assert_eq!(converged.rows.len(), 2);
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .map(|(action, _)| action)
            .collect::<Vec<_>>(),
        // The lost acknowledgement still released the history: the retry
        // finds nothing left to read and seeds nothing again.
        vec![
            "history_page",
            "ack_history",
            "history_page",
            "replay",
            "pending_snapshot",
        ]
    );
}

#[tokio::test]
async fn provider_session_initialization_establishes_the_durable_resume_reference() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_provider_ref(&temp_dir.path().join("domain.sqlite"), None).await;
    let transport = FakeTransport::new(Arc::clone(&store), [], []);
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport,
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge
        .ingest_pushed(&ClaudeDch1EventFrame {
            identity: identity(),
            event: ClaudeDch1ProviderEvent {
                sequence: 1,
                kind: "provider_session_initialized".into(),
                payload: json!({
                    "apiKeySource": "none",
                    "claudeCodeVersion": "2.1.234",
                    "cwd": "/workspace/claude/.worktrees/agent",
                    "model": "claude-sonnet-4-6",
                    "permissionMode": "default",
                    "providerSessionId": "session-claude-1"
                }),
            },
        })
        .await
        .unwrap();

    let binding = store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-claude").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        binding.provider_conversation_ref.as_deref(),
        Some("session-claude-1")
    );
    assert_eq!(binding.binding_revision, 2);
}

fn permission() -> Value {
    json!({
        "clientMessageId": "client-claude-1",
        "input": { "path": "/workspace/claude/file.txt" },
        "kind": "permission",
        "requestId": "request-claude-1",
        "toolName": "Read",
        "toolUseId": "tool-use-claude-1"
    })
}

async fn tail(store: &SqliteDomainStore) -> dure_app::AgentTimelinePageV1 {
    let AgentTimelineReadV1::Page { page } = store
        .read_agent_timeline(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 128,
        })
        .await
        .unwrap()
    else {
        panic!("tail unexpectedly reset");
    };
    *page
}

#[tokio::test]
async fn dch1_replay_commits_before_ack_and_reconciles_the_pending_snapshot() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [
            json!({
                "events": [
                    {
                        "sequence": 1,
                        "kind": "assistant_delta",
                        "payload": {
                            "blockIndex": 0,
                            "finalFragment": true,
                            "parentToolUseId": null,
                            "providerMessageId": "message-claude-1",
                            "text": "hello from Claude"
                        }
                    },
                    {
                        "sequence": 2,
                        "kind": "assistant_message_completed",
                        "payload": {
                            "blockCount": 1,
                            "error": null,
                            "parentToolUseId": null,
                            "providerMessageId": "message-claude-1",
                            "providerSessionId": "session-claude-1"
                        }
                    },
                    {
                        "sequence": 3,
                        "kind": "interaction_requested",
                        "payload": permission()
                    }
                ],
                "gap": null,
                "hasMore": false,
                "latestSequence": 3,
                "nextAfterSequence": 3
            }),
            json!({
                "events": [],
                "gap": null,
                "hasMore": false,
                "latestSequence": 3,
                "nextAfterSequence": 3
            }),
        ],
        [
            json!({
                "observedThroughSequence": 3,
                "requests": [permission()]
            }),
            json!({
                "observedThroughSequence": 3,
                "requests": [permission()]
            }),
        ],
    );
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let bridge = ClaudeTimelineBridge::new(
        service,
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    let page = tail(&store).await;
    assert_eq!(page.rows.len(), 1);
    assert!(matches!(
        page.rows[0].item.body,
        AgentTimelineItemBodyV1::Message { .. }
    ));
    assert_eq!(page.pending_requests.len(), 1);
    assert!(page.live_text.is_empty());
    let acknowledgements = transport
        .calls()
        .into_iter()
        .filter(|(action, _)| action == "ack")
        .map(|(_, payload)| payload["sequence"].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(acknowledgements, vec![3]);

    bridge.reconcile().await.unwrap();
    assert_eq!(tail(&store).await.rows.len(), 1);
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter(|(action, _)| action == "ack")
            .map(|(_, payload)| payload["sequence"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![3, 3]
    );
}

#[tokio::test]
async fn tool_lifecycle_replay_appends_canonical_snapshots_once() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let events = vec![
        json!({
            "sequence": 1,
            "kind": "tool_started",
            "payload": {
                "toolCallId": "tool-use-1",
                "name": "Read",
                "input": { "file_path": "README.md" },
                "providerMessageId": "message-tool-1",
                "parentToolUseId": null
            }
        }),
        json!({
            "sequence": 2,
            "kind": "tool_result",
            "payload": {
                "toolCallId": "tool-use-1",
                "name": "Read",
                "input": null,
                "output": "contents",
                "isError": false,
                "providerMessageId": "message-tool-1",
                "parentToolUseId": null
            }
        }),
        json!({
            "sequence": 3,
            "kind": "tool_started",
            "payload": {
                "toolCallId": "tool-use-2",
                "name": "Bash",
                "input": { "command": "false" },
                "providerMessageId": "message-tool-2",
                "parentToolUseId": null
            }
        }),
        json!({
            "sequence": 4,
            "kind": "tool_result",
            "payload": {
                "toolCallId": "tool-use-2",
                "name": "Bash",
                "input": { "command": "false" },
                "output": { "exitCode": 1 },
                "isError": true,
                "providerMessageId": "message-tool-2",
                "parentToolUseId": null
            }
        }),
    ];
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [
            json!({
                "events": events,
                "gap": null,
                "hasMore": false,
                "latestSequence": 4,
                "nextAfterSequence": 4
            }),
            json!({
                "events": [],
                "gap": null,
                "hasMore": false,
                "latestSequence": 4,
                "nextAfterSequence": 4
            }),
        ],
        [
            json!({ "observedThroughSequence": 4, "requests": [] }),
            json!({ "observedThroughSequence": 4, "requests": [] }),
        ],
    );
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    bridge.reconcile().await.unwrap();

    let page = tail(&store).await;
    assert_eq!(page.rows.len(), 4);
    let states = page
        .rows
        .iter()
        .map(|row| match &row.item.body {
            AgentTimelineItemBodyV1::Tool { state, .. } => state.clone(),
            body => panic!("expected canonical tool snapshot, got {body:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        states,
        vec![
            AgentTimelineToolStateV1::Running,
            AgentTimelineToolStateV1::Completed,
            AgentTimelineToolStateV1::Running,
            AgentTimelineToolStateV1::Failed,
        ]
    );
    assert!(matches!(
        &page.rows[1].item.body,
        AgentTimelineItemBodyV1::Tool {
            tool_call_id,
            name,
            input: None,
            output: Some(output),
            ..
        } if tool_call_id == "tool-use-1"
            && name == "Read"
            && output == "contents"
    ));
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter(|(action, _)| action == "ack")
            .map(|(_, payload)| payload["sequence"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![4, 4]
    );
}

#[tokio::test]
async fn pending_snapshot_cursor_catches_up_before_replacing_the_durable_projection() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [
            json!({
                "events": [{
                    "sequence": 1,
                    "kind": "interaction_requested",
                    "payload": permission()
                }],
                "gap": null,
                "hasMore": false,
                "latestSequence": 1,
                "nextAfterSequence": 1
            }),
            json!({
                "events": [{
                    "sequence": 2,
                    "kind": "interaction_resolved",
                    "payload": {
                        "clientMessageId": "client-claude-1",
                        "kind": "permission",
                        "outcome": "allow",
                        "requestId": "request-claude-1"
                    }
                }],
                "gap": null,
                "hasMore": false,
                "latestSequence": 2,
                "nextAfterSequence": 2
            }),
        ],
        [
            json!({
                "observedThroughSequence": 2,
                "requests": []
            }),
            json!({
                "observedThroughSequence": 2,
                "requests": []
            }),
        ],
    );
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();

    bridge.reconcile().await.unwrap();
    assert!(tail(&store).await.pending_requests.is_empty());
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter(|(action, _)| action == "ack")
            .map(|(_, payload)| payload["sequence"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[tokio::test]
async fn pushed_terminal_event_converges_pending_before_releasing_the_query_record() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [],
        [json!({
            "observedThroughSequence": 1,
            "requests": []
        })],
    );
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();
    let consumed = bridge
        .ingest_pushed(&ClaudeDch1EventFrame {
            identity: identity(),
            event: ClaudeDch1ProviderEvent {
                sequence: 1,
                kind: "query_exited".into(),
                payload: json!({ "reason": "relay_transport_error" }),
            },
        })
        .await
        .unwrap();

    assert!(consumed);
    assert!(matches!(
        tail(&store).await.rows[0].item.body,
        AgentTimelineItemBodyV1::Lifecycle {
            state: AgentTimelineLifecycleStateV1::SessionExited,
            ..
        }
    ));
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter_map(|(action, _)| {
                matches!(action.as_str(), "pending_snapshot" | "ack").then_some(action)
            })
            .collect::<Vec<_>>(),
        vec!["pending_snapshot", "ack"]
    );
}

#[tokio::test]
async fn dch1_gap_is_explicit_and_the_first_retained_event_follows_it() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let transport = FakeTransport::new(
        Arc::clone(&store),
        [
            json!({
                "events": [{
                    "sequence": 3,
                    "kind": "query_exited",
                    "payload": { "reason": "relay_transport_error" }
                }],
                "gap": {
                    "requestedAfter": 0,
                    "droppedThrough": 2
                },
                "hasMore": false,
                "latestSequence": 3,
                "nextAfterSequence": 3
            }),
            json!({
                "events": [],
                "gap": null,
                "hasMore": false,
                "latestSequence": 3,
                "nextAfterSequence": 3
            }),
        ],
        [
            json!({
                "observedThroughSequence": 3,
                "requests": []
            }),
            json!({
                "observedThroughSequence": 3,
                "requests": []
            }),
        ],
    );
    let bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();
    bridge.reconcile().await.unwrap();
    let page = tail(&store).await;
    assert!(!page.binding.history_complete);
    assert_eq!(page.rows.len(), 2);
    assert!(matches!(
        page.rows[0].item.body,
        AgentTimelineItemBodyV1::HistoryBoundary { .. }
    ));
    assert!(matches!(
        page.rows[1].item.body,
        AgentTimelineItemBodyV1::Lifecycle {
            state: AgentTimelineLifecycleStateV1::SessionExited,
            ..
        }
    ));
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter(|(action, _)| action == "ack")
            .map(|(_, payload)| payload["sequence"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![3]
    );
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter_map(|(action, _)| {
                matches!(action.as_str(), "pending_snapshot" | "ack").then_some(action)
            })
            .collect::<Vec<_>>(),
        vec!["pending_snapshot", "ack"]
    );

    let fresh_bridge = ClaudeTimelineBridge::new(
        Arc::new(AgentConversationService::new(Arc::clone(&store))),
        transport.clone(),
        AgentInteractionSessionIdV1::new("interaction-claude").unwrap(),
        identity(),
    )
    .unwrap();
    fresh_bridge.reconcile().await.unwrap();
    let reopened = tail(&store).await;
    assert!(!reopened.binding.history_complete);
    assert_eq!(reopened.rows, page.rows);
    // The fresh attachment finds the Query's history already released.
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter(|(action, _)| action == "ack_history")
            .count(),
        1
    );
}

fn history_message(source_id: &str, provider_message_id: Option<&str>, role: &str) -> Value {
    json!({
        "sourceId": source_id,
        "createdAtMs": 10,
        "providerMessageId": provider_message_id,
        "body": { "type": "message", "role": role, "markdown": format!("{role} {source_id}") }
    })
}

fn history_snapshot(items: Vec<Value>) -> Value {
    json!({
        "status": "complete",
        "offset": 0,
        "nextOffset": items.len(),
        "hasMore": false,
        "items": items,
    })
}

fn empty_replay() -> Value {
    json!({
        "events": [],
        "gap": null,
        "hasMore": false,
        "latestSequence": 0,
        "nextAfterSequence": 0
    })
}

fn no_pending() -> Value {
    json!({ "observedThroughSequence": 0, "requests": [] })
}

fn markdown(page: &dure_app::AgentTimelinePageV1) -> Vec<String> {
    page.rows
        .iter()
        .filter_map(|row| match &row.item.body {
            AgentTimelineItemBodyV1::Message { markdown, .. } => Some(markdown.clone()),
            _ => None,
        })
        .collect()
}

/// An Agent moved into Chat, back to its Terminal, and into Chat again. The
/// second Chat session shows the turns made in the Terminal between the two,
/// after the first session's own turn and before anything it sends, each once.
#[tokio::test]
async fn a_second_chat_session_continues_with_the_terminal_turns_between() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let interaction = AgentInteractionSessionIdV1::new("interaction-claude").unwrap();
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));

    // The first Chat session seeds the history from before it.
    let first = FakeTransport::new(Arc::clone(&store), [empty_replay()], [no_pending()])
        .with_history(history_snapshot(vec![
            history_message("terminal-1", None, "user"),
            history_message("terminal-2", Some("msg_terminal_2"), "assistant"),
        ]));
    ClaudeTimelineBridge::new(Arc::clone(&service), first, interaction.clone(), identity())
        .unwrap()
        .reconcile()
        .await
        .unwrap();
    // ...and records its own turn live.
    let live =
        |id: &str, role, provider_message_id: Option<&str>| AgentTimelineMutationV1::Append {
            item: AgentTimelineItemDraftV1 {
                item_id: AgentTimelineItemIdV1::new(id).unwrap(),
                turn_id: None,
                client_message_id: None,
                provider_message_id: provider_message_id
                    .map(|id| AgentProviderMessageIdV1::new(id).unwrap()),
                body: AgentTimelineItemBodyV1::Message {
                    role,
                    markdown: format!("live {id}"),
                },
                created_at_ms: 20,
            },
        };
    store
        .apply_agent_provider_event(&AgentProviderEventCommitV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: interaction.clone(),
            event: AgentProviderEventIdentityV1 {
                runtime: runtime(),
                sequence: 1,
            },
            source_fingerprint: "chat-turn".into(),
            mutations: vec![
                live("chat-user", AgentTimelineMessageRoleV1::User, None),
                live(
                    "chat-answer",
                    AgentTimelineMessageRoleV1::Assistant,
                    Some("msg_chat"),
                ),
            ],
            recorded_at_ms: 20,
        })
        .await
        .unwrap();

    // The Terminal runs, then a new Chat runtime replaces the stopped one.
    let second_identity = replace_with_second_chat_runtime(&store, &interaction).await;

    // The provider's history now holds all of it, the Terminal turn last.
    let second = FakeTransport::new(Arc::clone(&store), [empty_replay()], [no_pending()])
        .with_history(history_snapshot(vec![
            history_message("terminal-1", None, "user"),
            history_message("terminal-2", Some("msg_terminal_2"), "assistant"),
            history_message("chat-1", None, "user"),
            history_message("chat-2", Some("msg_chat"), "assistant"),
            history_message("terminal-3", None, "user"),
            history_message("terminal-4", Some("msg_terminal_4"), "assistant"),
        ]));
    let expected = [
        "user terminal-1",
        "assistant terminal-2",
        "live chat-user",
        "live chat-answer",
        "user terminal-3",
        "assistant terminal-4",
    ];
    ClaudeTimelineBridge::new(
        Arc::clone(&service),
        second.clone(),
        interaction.clone(),
        second_identity.clone(),
    )
    .unwrap()
    .reconcile()
    .await
    .unwrap();
    let page = tail(&store).await;
    assert_eq!(markdown(&page), expected);
    assert!(page.binding.history_complete);

    // A later attachment of the same Query finds its history released and
    // changes nothing.
    second
        .state
        .lock()
        .unwrap()
        .replay
        .push_back(empty_replay());
    second.state.lock().unwrap().pending.push_back(no_pending());
    ClaudeTimelineBridge::new(
        Arc::clone(&service),
        second.clone(),
        interaction,
        second_identity,
    )
    .unwrap()
    .reconcile()
    .await
    .unwrap();
    assert_eq!(markdown(&tail(&store).await), expected);
    assert_eq!(
        second
            .calls()
            .into_iter()
            .map(|(action, _)| action)
            .collect::<Vec<_>>(),
        vec![
            "history_page",
            "ack_history",
            "replay",
            "pending_snapshot",
            "history_page",
            "replay",
            "pending_snapshot",
        ]
    );
}

/// A new Chat runtime replaces the stopped first one, as a second move into
/// Chat does after the Agent ran in its Terminal. It keeps the interaction
/// binding and its timeline.
async fn replace_with_second_chat_runtime(
    store: &SqliteDomainStore,
    interaction: &AgentInteractionSessionIdV1,
) -> ClaudeDch1QueryIdentity {
    let current = store.agent_interaction(interaction).await.unwrap().unwrap();
    let second_identity = ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-claude-2".into(),
        query_epoch: "query-claude-2".into(),
        relay_id: "relay-claude-2".into(),
    };
    store
        .replace_agent_interaction_runtime(&dure_app::AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: interaction.clone(),
            expected_binding_revision: current.binding_revision,
            source: runtime(),
            source_execution_profile: current.execution_profile.clone(),
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: second_identity.runtime_generation.clone(),
                provider_epoch: second_identity.query_epoch.clone(),
            },
            target_execution_profile: current.execution_profile.clone(),
            provider_conversation_ref: current.provider_conversation_ref.clone(),
            replaced_at_ms: 30,
        })
        .await
        .unwrap();
    second_identity
}

/// A Chat prompt that got no reply before the Agent moved back to its
/// Terminal, for example one interrupted before any output, shows once after
/// the next move into Chat. The provider recorded it under the id the driver
/// sent it with, and the timeline holds that id from the driver's report, so
/// the history after the prompt is all that is appended.
#[tokio::test]
async fn an_unanswered_chat_prompt_shows_once_after_a_terminal_round_trip() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture_with_history_state(
        &temp_dir.path().join("domain.sqlite"),
        Some("session-claude-1"),
        false,
    )
    .await;
    let interaction = AgentInteractionSessionIdV1::new("interaction-claude").unwrap();
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));

    // The first Chat session seeds the history from before it...
    let first = FakeTransport::new(
        Arc::clone(&store),
        [
            empty_replay(),
            json!({
                "events": [
                    {
                        "sequence": 1,
                        "kind": "user_message_accepted",
                        "payload": { "clientMessageId": "client-claude-1" }
                    },
                    {
                        "sequence": 2,
                        "kind": "provider_user_message",
                        "payload": {
                            "clientMessageId": "client-claude-1",
                            "providerMessageId": "prompt-chat-1"
                        }
                    },
                    {
                        "sequence": 3,
                        "kind": "turn_failed",
                        "payload": { "clientMessageId": "client-claude-1" }
                    }
                ],
                "gap": null,
                "hasMore": false,
                "latestSequence": 3,
                "nextAfterSequence": 3
            }),
        ],
        [
            no_pending(),
            json!({ "observedThroughSequence": 3, "requests": [] }),
        ],
    )
    .with_history(history_snapshot(vec![
        history_message("terminal-1", Some("prompt-terminal-1"), "user"),
        history_message("terminal-2", Some("msg_terminal_2"), "assistant"),
    ]));
    let first_bridge = ClaudeTimelineBridge::new(
        Arc::clone(&service),
        first.clone(),
        interaction.clone(),
        identity(),
    )
    .unwrap();
    first_bridge.reconcile().await.unwrap();
    // ...and sends a prompt that ends before any reply.
    service
        .start_turn(
            &first_bridge,
            &AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: interaction.clone(),
                runtime: runtime(),
                turn_id: dure_app::AgentTurnIdV1::new("turn-chat-1").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("client-claude-1").unwrap(),
                input: "chat question".into(),
                requested_at_ms: 20,
            },
        )
        .await
        .unwrap();
    first_bridge.reconcile().await.unwrap();
    let prompt_record = tail(&store)
        .await
        .rows
        .into_iter()
        .find(|row| {
            matches!(
                &row.item.body,
                AgentTimelineItemBodyV1::ProviderEvidence { kind, .. }
                    if kind == "provider_user_message"
            )
        })
        .expect("the driver's report of the prompt is kept");
    assert_eq!(
        prompt_record
            .item
            .provider_message_id
            .as_ref()
            .map(AgentProviderMessageIdV1::as_str),
        Some("prompt-chat-1")
    );
    assert_eq!(
        prompt_record
            .item
            .client_message_id
            .as_ref()
            .map(AgentClientMessageIdV1::as_str),
        Some("client-claude-1")
    );

    // The Terminal continues the conversation, then the Agent moves into
    // Chat again. The provider's history holds the unanswered prompt before
    // the Terminal's turn.
    let second_identity = replace_with_second_chat_runtime(&store, &interaction).await;
    let second = FakeTransport::new(Arc::clone(&store), [empty_replay()], [no_pending()])
        .with_history(history_snapshot(vec![
            history_message("terminal-1", Some("prompt-terminal-1"), "user"),
            history_message("terminal-2", Some("msg_terminal_2"), "assistant"),
            history_message("chat-1", Some("prompt-chat-1"), "user"),
            history_message("terminal-3", Some("prompt-terminal-3"), "user"),
            history_message("terminal-4", Some("msg_terminal_4"), "assistant"),
        ]));
    ClaudeTimelineBridge::new(Arc::clone(&service), second, interaction, second_identity)
        .unwrap()
        .reconcile()
        .await
        .unwrap();

    let page = tail(&store).await;
    assert_eq!(
        markdown(&page),
        [
            "user terminal-1",
            "assistant terminal-2",
            "chat question",
            "user terminal-3",
            "assistant terminal-4",
        ]
    );
    assert!(page.binding.history_complete);
}
