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
                "history_page" => Ok(state.history.clone()),
                "ack_history" => {
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
        vec![
            "history_page",
            "ack_history",
            "ack_history",
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
    page
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
    assert_eq!(
        transport
            .calls()
            .into_iter()
            .filter(|(action, _)| action == "ack_history")
            .count(),
        2
    );
}
