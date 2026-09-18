use std::sync::atomic::{AtomicUsize, Ordering};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionSessionIdV1, AgentProviderEventCommitV1,
    AgentProviderEventIdentityV1, AgentProviderRuntimeFenceV1, AgentRecordV1,
    AgentStartTurnIntentV1, AgentTimelineEpochV1, AgentTimelineItemBodyV1,
    AgentTimelineLifecycleStateV1, AgentTimelinePageV1, AgentTimelineReadDirectionV1,
    AgentTimelineReadRequestV1, AgentTimelineReadV1, AgentTimelineStore, AgentTurnEffectStateV1,
    AgentTurnFailureReasonV1, AgentTurnIdV1, DomainStore, ProjectIdV1, ProjectRecordV1,
    ProviderIdV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::*;

struct FakeProvider {
    calls: AtomicUsize,
    store: Arc<SqliteDomainStore>,
    start_error: Option<&'static str>,
}

#[test]
fn oversized_provider_diagnostic_still_fits_the_durable_failure_receipt() {
    let error = AgentProviderCommandErrorV1::new("x".repeat(1000), "\0💥".repeat(100_000));
    assert_eq!(error.code, format!("{}…", "x".repeat(256)));
    assert_eq!(error.detail, format!("{}…", "\0💥".repeat(4096)));
    let completion = AgentCompleteTurnEffectV1 {
        schema_version: 1,
        interaction_session_id: intent().interaction_session_id,
        runtime: runtime(),
        client_message_id: intent().client_message_id,
        state: AgentTurnEffectStateV1::Failed,
        provider_receipt: Some(error.receipt()),
        updated_at_ms: 11,
    };
    completion.validate().unwrap();
    assert!(
        serde_json::to_vec(completion.provider_receipt.as_ref().unwrap())
            .unwrap()
            .len()
            < dure_app::MAX_AGENT_TIMELINE_JSON_BYTES_V1
    );
}

impl AgentProviderCommands for FakeProvider {
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        _intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let page = self
                .store
                .read_agent_timeline(&AgentTimelineReadRequestV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: binding.interaction_session_id.clone(),
                    direction: AgentTimelineReadDirectionV1::Tail,
                    cursor: None,
                    limit: 8,
                })
                .await
                .map_err(|error| AgentProviderCommandErrorV1::new("store", error.to_string()))?;
            let AgentTimelineReadV1::Page { page } = page else {
                return Err(AgentProviderCommandErrorV1::new(
                    "reset",
                    "unexpected reset",
                ));
            };
            if page.rows.len() != 2 {
                return Err(AgentProviderCommandErrorV1::new(
                    "commit_order",
                    "prompt was not durable before the provider effect",
                ));
            }
            if let Some(code) = self.start_error {
                return Err(AgentProviderCommandErrorV1::new(
                    code,
                    "provider rejected the turn",
                ));
            }
            Ok(json!({ "acceptedEventSequence": 1 }))
        })
    }

    fn answer_pending<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
        _intent: &'a AgentPendingAnswerIntentV1,
        _request: &'a AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async { Ok(Value::Null) })
    }

    fn interrupt_turn<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
        _request: &'a AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async { Ok(Value::Null) })
    }
}

fn runtime() -> AgentProviderRuntimeFenceV1 {
    AgentProviderRuntimeFenceV1 {
        runtime_generation: "runtime-fake-1".into(),
        provider_epoch: "epoch-fake-1".into(),
    }
}

async fn fixture(path: &std::path::Path) -> Arc<SqliteDomainStore> {
    let store = Arc::new(SqliteDomainStore::open(path).await.unwrap());
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-fake").unwrap(),
            root_path: "/workspace/fake".into(),
            display_name: "Fake".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-fake").unwrap(),
            project_id: ProjectIdV1::new("project-fake").unwrap(),
            root_path: "/workspace/fake/.worktrees/agent".into(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: AgentIdV1::new("agent-fake").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-fake").unwrap(),
            provider_id: ProviderIdV1::new("provider.fake").unwrap(),
            display_name: "Fake".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    store
        .create_agent_interaction(&AgentInteractionBindingV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-fake").unwrap(),
            agent_id: AgentIdV1::new("agent-fake").unwrap(),
            provider_id: ProviderIdV1::new("provider.fake").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            runtime: runtime(),
            timeline_epoch: AgentTimelineEpochV1::new("timeline-fake").unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 4,
            updated_at_ms: 4,
        })
        .await
        .unwrap();
    store
}

fn intent() -> AgentStartTurnIntentV1 {
    AgentStartTurnIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-fake").unwrap(),
        runtime: runtime(),
        turn_id: AgentTurnIdV1::new("turn-fake-1").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("message-fake-1").unwrap(),
        input: "Persist me first".into(),
        requested_at_ms: 10,
    }
}

async fn timeline(service: &AgentConversationService<SqliteDomainStore>) -> AgentTimelinePageV1 {
    let AgentTimelineReadV1::Page { page } = service
        .read(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-fake").unwrap(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 8,
        })
        .await
        .unwrap()
    else {
        panic!("timeline unexpectedly reset");
    };
    page
}

#[tokio::test]
async fn fake_provider_conformance_commits_before_effect_and_never_replays_a_prompt() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let provider = FakeProvider {
        calls: AtomicUsize::new(0),
        store: Arc::clone(&store),
        start_error: None,
    };
    let service = AgentConversationService::new(Arc::clone(&store));
    let mut subscription = service.subscribe();
    let receipt = service.start_turn(&provider, &intent()).await.unwrap();
    assert_eq!(receipt.state, AgentTurnEffectStateV1::Accepted);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let notification = subscription.recv().await.unwrap();
    assert_eq!(notification.timeline_cursor.sequence, 2);

    let mut retried_intent = intent();
    retried_intent.requested_at_ms = 999;
    let retry = service
        .start_turn(&provider, &retried_intent)
        .await
        .unwrap();
    assert_eq!(retry.state, AgentTurnEffectStateV1::Accepted);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn competing_start_never_reaches_provider_or_changes_the_running_turn() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let provider = FakeProvider {
        calls: AtomicUsize::new(0),
        store: Arc::clone(&store),
        start_error: None,
    };
    let service = AgentConversationService::new(Arc::clone(&store));
    service.start_turn(&provider, &intent()).await.unwrap();
    let mut competing = intent();
    competing.turn_id = AgentTurnIdV1::new("turn-teammate").unwrap();
    competing.client_message_id = AgentClientMessageIdV1::new("message-teammate").unwrap();
    let failure = service.start_turn(&provider, &competing).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(matches!(
        failure,
        Err(AgentConversationErrorV1::Store(
            DomainStoreErrorV1::IdentityConflict { .. }
        ))
    ));
    let page = timeline(&service).await;
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.active_turn.unwrap().turn_id, intent().turn_id);
}

#[tokio::test]
async fn confirmed_answer_notifies_the_committed_timeline_and_pending_snapshot() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let turn = intent();
    let request = dure_app::AgentPendingRequestDraftV1 {
        request_id: dure_app::AgentInteractionRequestIdV1::new("question-1").unwrap(),
        kind: dure_app::AgentPendingRequestKindV1::Question,
        turn_id: Some(turn.turn_id.clone()),
        client_message_id: turn.client_message_id.clone(),
        payload: json!({ "input": { "questions": [] } }),
        created_at_ms: 10,
    };
    store
        .apply_agent_provider_event(&AgentProviderEventCommitV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: turn.interaction_session_id.clone(),
            event: AgentProviderEventIdentityV1 {
                runtime: runtime(),
                sequence: 1,
            },
            source_fingerprint: "pending-question".into(),
            mutations: vec![dure_app::AgentTimelineMutationV1::PutPending {
                request: request.clone(),
            }],
            recorded_at_ms: 10,
        })
        .await
        .unwrap();
    let service = AgentConversationService::new(Arc::clone(&store));
    let provider = FakeProvider {
        calls: AtomicUsize::new(0),
        store,
        start_error: None,
    };
    let mut subscription = service.subscribe();
    let answer = json!({ "answers": { "database": "SQLite" } });
    service
        .answer_pending(
            &provider,
            &AgentPendingAnswerIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: turn.interaction_session_id,
                runtime: runtime(),
                request_id: request.request_id,
                client_message_id: turn.client_message_id,
                idempotency_key: "answer-1".into(),
                answer: answer.clone(),
                requested_at_ms: 11,
            },
        )
        .await
        .unwrap();
    let notification = subscription.try_recv().unwrap();
    assert_eq!(
        notification.kinds,
        vec![
            AgentConversationNotificationKindV1::Timeline,
            AgentConversationNotificationKindV1::PendingRequests
        ]
    );
    let page = timeline(&service).await;
    assert!(page.pending_requests.is_empty());
    assert_eq!(page.final_cursor, notification.timeline_cursor);
    assert!(
        matches!(&page.rows.last().unwrap().item.body, AgentTimelineItemBodyV1::PendingAnswer { answer: recorded, .. } if recorded == &answer)
    );
}

#[tokio::test]
async fn rejected_start_turn_closes_its_durable_timeline_turn() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let provider = FakeProvider {
        calls: AtomicUsize::new(0),
        store: Arc::clone(&store),
        start_error: Some("provider_unavailable"),
    };
    let service = AgentConversationService::new(Arc::clone(&store));
    let mut subscription = service.subscribe();

    let error = service.start_turn(&provider, &intent()).await.unwrap_err();
    assert!(matches!(error, AgentConversationErrorV1::Provider(_)));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);

    let page = timeline(&service).await;
    assert_eq!(page.active_turn, None);
    assert_eq!(page.rows.len(), 3);
    assert_eq!(
        page.rows.last().unwrap().item.body,
        AgentTimelineItemBodyV1::Lifecycle {
            state: AgentTimelineLifecycleStateV1::TurnFailed,
            detail: Some(AgentTurnFailureReasonV1::ProviderError.as_token().into()),
        }
    );

    assert_eq!(
        subscription.recv().await.unwrap().timeline_cursor.sequence,
        2
    );
    assert_eq!(
        subscription.recv().await.unwrap().timeline_cursor.sequence,
        3
    );

    let response = crate::backend_error_body(crate::agent_conversation_api_error(error.into()));
    let replay = service.start_turn(&provider, &intent()).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(replay.state, AgentTurnEffectStateV1::Failed);
    assert!(!replay.newly_prepared);
    assert_eq!(
        json!({
            "message": response["message"],
            "details": response["details"],
            "receipt": replay.provider_receipt,
        }),
        json!({
            "message": "provider command provider_unavailable: provider rejected the turn",
            "details": { "disposition": "terminal", "providerCode": "provider_unavailable" },
            "receipt": { "errorCode": "provider_unavailable", "errorDetail": "provider rejected the turn" },
        }),
        "The original failure explanation must survive the response and an idempotent replay",
    );
}

#[tokio::test]
async fn rejected_steer_keeps_the_running_turn_open() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let provider = FakeProvider {
        calls: AtomicUsize::new(0),
        store: Arc::clone(&store),
        start_error: None,
    };
    let service = AgentConversationService::new(Arc::clone(&store));
    service.start_turn(&provider, &intent()).await.unwrap();

    let mut steer = intent();
    steer.client_message_id = AgentClientMessageIdV1::new("message-steer-1").unwrap();
    steer.input = "also cover the rejected path".into();
    steer.requested_at_ms = 20;
    let error = service.steer_turn(&provider, &steer).await.unwrap_err();
    assert!(matches!(error, AgentConversationErrorV1::Provider(_)));

    let page = timeline(&service).await;
    assert_eq!(
        page.active_turn,
        Some(dure_app::AgentTimelineActiveTurnV1 {
            turn_id: AgentTurnIdV1::new("turn-fake-1").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("message-fake-1").unwrap(),
        })
    );
    assert_eq!(page.rows.len(), 3);
    assert!(page.rows.iter().all(|row| !matches!(
        row.item.body,
        AgentTimelineItemBodyV1::Lifecycle {
            state: AgentTimelineLifecycleStateV1::TurnFailed,
            ..
        }
    )));
}

#[tokio::test]
async fn client_detach_does_not_stop_commits_and_a_new_service_replays_durable_state() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = fixture(&path).await;
    let service = AgentConversationService::new(Arc::clone(&store));
    let detached = service.subscribe();
    drop(detached);
    service
        .commit_provider_event(&AgentProviderEventCommitV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-fake").unwrap(),
            event: AgentProviderEventIdentityV1 {
                runtime: runtime(),
                sequence: 1,
            },
            source_fingerprint: "fake-source-1".into(),
            mutations: vec![],
            recorded_at_ms: 20,
        })
        .await
        .unwrap();
    drop(service);
    store.close().await;
    drop(store);

    let reopened = Arc::new(SqliteDomainStore::open(&path).await.unwrap());
    let service = AgentConversationService::new(reopened);
    let AgentTimelineReadV1::Page { page } = service
        .read(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-fake").unwrap(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 8,
        })
        .await
        .unwrap()
    else {
        panic!("reopened timeline unexpectedly reset");
    };
    assert_eq!(page.final_cursor.sequence, 0);
}

#[tokio::test]
async fn current_runtime_exit_publishes_a_reconnect_invalidation() {
    let temp_dir = TempDir::new().unwrap();
    let store = fixture(&temp_dir.path().join("domain.sqlite")).await;
    let service = AgentConversationService::new(store);
    let binding = service
        .binding(&AgentInteractionSessionIdV1::new("interaction-fake").unwrap())
        .await
        .unwrap()
        .unwrap();
    let mut subscription = service.subscribe();

    service.invalidate_runtime(&binding).await.unwrap();

    let notification = subscription.recv().await.unwrap();
    assert_eq!(
        notification.interaction_session_id,
        binding.interaction_session_id
    );
    assert_eq!(notification.timeline_cursor.sequence, 0);
    assert_eq!(
        notification.kinds,
        vec![AgentConversationNotificationKindV1::Runtime]
    );
}

#[tokio::test]
async fn conditional_continuation_executes_once_and_rejects_an_obsolete_observation() {
    let root = TempDir::new().unwrap();
    let store = fixture(&root.path().join("continuation.sqlite")).await;
    let provider = FakeProvider {
        calls: AtomicUsize::new(0),
        store: Arc::clone(&store),
        start_error: None,
    };
    let service = AgentConversationService::new(Arc::clone(&store));
    let mut request = dure_app::AgentContinueTurnRequestV1 {
        intent: intent(),
        expected_cursor: timeline(&service).await.final_cursor,
    };
    let accepted = service
        .continue_turn(&provider, &request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(accepted.state, AgentTurnEffectStateV1::Accepted);
    let replay = service
        .continue_turn(&provider, &request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.state, AgentTurnEffectStateV1::Accepted);
    assert!(!replay.newly_prepared);
    store
        .apply_agent_provider_event(&AgentProviderEventCommitV1 {
            schema_version: 1,
            interaction_session_id: request.intent.interaction_session_id.clone(),
            event: AgentProviderEventIdentityV1 {
                runtime: runtime(),
                sequence: 1,
            },
            source_fingerprint: "completed-fixture".into(),
            mutations: vec![dure_app::AgentTimelineMutationV1::Append {
                item: dure_app::AgentTimelineItemDraftV1 {
                    item_id: dure_app::AgentTimelineItemIdV1::new("completed-fixture").unwrap(),
                    turn_id: Some(request.intent.turn_id.clone()),
                    client_message_id: Some(request.intent.client_message_id.clone()),
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: AgentTimelineLifecycleStateV1::TurnCompleted,
                        detail: None,
                    },
                    created_at_ms: 12,
                },
            }],
            recorded_at_ms: 12,
        })
        .await
        .unwrap();
    let before = timeline(&service).await;
    assert!(before.active_turn.is_none());
    request.intent.turn_id = AgentTurnIdV1::new("retained-turn").unwrap();
    request.intent.client_message_id = AgentClientMessageIdV1::new("retained-input").unwrap();
    assert!(
        service
            .continue_turn(&provider, &request)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(timeline(&service).await, before);
}

#[tokio::test]
async fn conditional_continuation_preserves_pending_receipts_without_provider_replay() {
    let root = TempDir::new().unwrap();
    let store = fixture(&root.path().join("continuation.sqlite")).await;
    let provider = FakeProvider {
        calls: AtomicUsize::new(0),
        store: Arc::clone(&store),
        start_error: None,
    };
    let service = AgentConversationService::new(Arc::clone(&store));
    let request = dure_app::AgentContinueTurnRequestV1 {
        intent: intent(),
        expected_cursor: timeline(&service).await.final_cursor,
    };
    store
        .prepare_agent_continuation_turn(&request)
        .await
        .unwrap()
        .unwrap();
    let replay = service
        .continue_turn(&provider, &request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.state, AgentTurnEffectStateV1::Uncertain);
    assert!(!replay.newly_prepared);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
}
