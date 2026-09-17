use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentClientMessageIdV1, AgentCompletePendingAnswerV1,
    AgentExecutionProfileV1, AgentHistoryHydrationDispositionV1, AgentHistorySnapshotV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionRequestIdV1, AgentInteractionSessionIdV1,
    AgentPendingAnswerIntentV1, AgentPendingAnswerStateV1, AgentPendingRequestDraftV1,
    AgentPendingRequestKindV1, AgentPendingSnapshotV1, AgentProviderEventCommitV1,
    AgentProviderEventIdentityV1, AgentProviderGapV1, AgentProviderMessageIdV1,
    AgentProviderRuntimeFenceV1, AgentRecordV1, AgentRuntimeReplacementV1, AgentStartTurnIntentV1,
    AgentTimelineCursorV1, AgentTimelineEpochV1, AgentTimelineItemBodyV1, AgentTimelineItemDraftV1,
    AgentTimelineItemIdV1, AgentTimelineLifecycleStateV1, AgentTimelineMutationV1,
    AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1, AgentTimelineReadV1,
    AgentTimelineStore, AgentTimelineStreamIdV1, AgentTimelineTextFragmentV1,
    AgentTimelineTextKindV1, AgentTurnEffectStateV1, AgentTurnIdV1, DomainStore,
    DomainStoreErrorV1, MAX_AGENT_PENDING_REQUESTS_V1, MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1,
    ProjectIdV1, ProjectRecordV1, ProviderIdV1, RuntimeKindIdV1, SessionBindingRecordV1,
    WorkspaceIdV1, WorkspaceRecordV1,
};
use serde_json::json;
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;

use super::SqliteDomainStore;
use super::schema::{downgrade_workflow_launch_fixture_to_v31, writable_connect_options};

#[path = "agent_goal_tests.rs"]
mod goals;

#[tokio::test]
async fn canceled_effect_completion_rolls_back_before_reusing_its_connection() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("cancel-completion.sqlite");
    let mut store = provision(&path).await;
    let intent = start_turn();
    store.record_agent_turn_intent(&intent).await.unwrap();
    store.pool.close().await;
    store.pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(writable_connect_options(&path))
        .await
        .unwrap();

    // Pause SQLite at the actual receipt update, before its transaction commits.
    let (observed, observation) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let mut observed = Some(observed);
    let mut connection = store.pool.acquire().await.unwrap();
    connection
        .lock_handle()
        .await
        .unwrap()
        .set_update_hook(move |update| {
            if update.table == "agent_turn_effects" {
                if let Some(observed) = observed.take() {
                    let _ = observed.send(());
                    let _ = released.recv();
                }
            }
        });
    drop(connection);
    let worker = store.clone();
    let completion = dure_app::AgentCompleteTurnEffectV1 {
        schema_version: 1,
        interaction_session_id: intent.interaction_session_id.clone(),
        runtime: intent.runtime.clone(),
        client_message_id: intent.client_message_id.clone(),
        state: AgentTurnEffectStateV1::Accepted,
        provider_receipt: Some(json!({"accepted": true})),
        updated_at_ms: 200,
    };
    let task = tokio::spawn(async move { worker.complete_agent_turn_effect(&completion).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), observation)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    let mut connection = store.pool.acquire().await.unwrap();
    connection.lock_handle().await.unwrap().remove_update_hook();
    drop(connection);

    // A canceled acknowledgment remains uncertain and cannot poison the next write.
    let replay = store.record_agent_turn_intent(&intent).await.unwrap();
    assert_eq!(replay.state, AgentTurnEffectStateV1::Uncertain);
    assert!(!replay.newly_prepared);
}

fn runtime(generation: u32) -> AgentProviderRuntimeFenceV1 {
    AgentProviderRuntimeFenceV1 {
        runtime_generation: format!("runtime-{generation}"),
        provider_epoch: format!("query-{generation}"),
    }
}

fn interaction_binding() -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        provider_id: ProviderIdV1::new("provider.fake").unwrap(),
        execution_profile: AgentExecutionProfileV1::CredentialReference {
            reference_id: "credential.account-a".into(),
            credential_generation: Some("credential-generation-7".into()),
        },
        provider_conversation_ref: Some("conversation-1".into()),
        runtime: runtime(1),
        timeline_epoch: AgentTimelineEpochV1::new("timeline-epoch-1").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 100,
        updated_at_ms: 100,
    }
}

async fn provision(path: &std::path::Path) -> SqliteDomainStore {
    provision_with_binding(path, interaction_binding()).await
}

async fn provision_with_binding(
    path: &std::path::Path,
    binding: AgentInteractionBindingV1,
) -> SqliteDomainStore {
    let store = SqliteDomainStore::open(path).await.unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_path: "/workspace/project".into(),
            display_name: "Project".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_path: "/workspace/project/.worktrees/agent-1".into(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("provider.fake").unwrap(),
            display_name: "Fake".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    store
        .upsert_session_binding(&SessionBindingRecordV1 {
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "hmux-session-1".into(),
            provider_conversation_id: Some("conversation-1".into()),
            credential_reference_id: Some("credential.account-a".into()),
            binding_generation: 1,
            bound_at_ms: 4,
        })
        .await
        .unwrap();
    store.create_agent_interaction(&binding).await.unwrap();
    store
}

fn start_turn() -> AgentStartTurnIntentV1 {
    AgentStartTurnIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        runtime: runtime(1),
        turn_id: AgentTurnIdV1::new("turn-1").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("client-message-1").unwrap(),
        input: "Hello durable world".into(),
        requested_at_ms: 110,
    }
}

fn provider_event(
    sequence: i64,
    mutations: Vec<AgentTimelineMutationV1>,
) -> AgentProviderEventCommitV1 {
    AgentProviderEventCommitV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        event: AgentProviderEventIdentityV1 {
            runtime: runtime(1),
            sequence,
        },
        source_fingerprint: format!("fake-source-{sequence}"),
        mutations,
        recorded_at_ms: 120 + sequence,
    }
}

fn session_lifecycle(
    item_id: &str,
    state: AgentTimelineLifecycleStateV1,
    created_at_ms: i64,
) -> AgentTimelineMutationV1 {
    AgentTimelineMutationV1::Append {
        item: AgentTimelineItemDraftV1 {
            item_id: AgentTimelineItemIdV1::new(item_id).unwrap(),
            turn_id: None,
            client_message_id: None,
            provider_message_id: None,
            body: AgentTimelineItemBodyV1::Lifecycle {
                state,
                detail: None,
            },
            created_at_ms,
        },
    }
}

fn pending_request() -> AgentPendingRequestDraftV1 {
    pending_request_with_id("permission-1")
}

fn pending_request_with_id(request_id: &str) -> AgentPendingRequestDraftV1 {
    AgentPendingRequestDraftV1 {
        request_id: AgentInteractionRequestIdV1::new(request_id).unwrap(),
        kind: AgentPendingRequestKindV1::Permission,
        turn_id: Some(AgentTurnIdV1::new("turn-1").unwrap()),
        client_message_id: AgentClientMessageIdV1::new("client-message-1").unwrap(),
        payload: json!({ "toolName": "Read", "path": "/workspace/file.txt" }),
        created_at_ms: 125,
    }
}

fn pending_answer_intent(
    request_id: &str,
    idempotency_key: &str,
    requested_at_ms: i64,
) -> AgentPendingAnswerIntentV1 {
    AgentPendingAnswerIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        runtime: runtime(1),
        request_id: AgentInteractionRequestIdV1::new(request_id).unwrap(),
        client_message_id: AgentClientMessageIdV1::new("client-message-1").unwrap(),
        idempotency_key: idempotency_key.into(),
        answer: json!({ "decision": "allow" }),
        requested_at_ms,
    }
}

async fn tail(store: &SqliteDomainStore) -> dure_app::AgentTimelinePageV1 {
    match store
        .read_agent_timeline(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 128,
        })
        .await
        .unwrap()
    {
        AgentTimelineReadV1::Page { page } => page,
        AgentTimelineReadV1::Reset { .. } => panic!("tail read unexpectedly reset"),
    }
}

async fn read_page(
    store: &SqliteDomainStore,
    direction: AgentTimelineReadDirectionV1,
    cursor: Option<AgentTimelineCursorV1>,
    limit: usize,
) -> dure_app::AgentTimelinePageV1 {
    match store
        .read_agent_timeline(&AgentTimelineReadRequestV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            direction,
            cursor,
            limit,
        })
        .await
        .unwrap()
    {
        AgentTimelineReadV1::Page { page } => page,
        AgentTimelineReadV1::Reset { .. } => panic!("timeline read unexpectedly reset"),
    }
}

#[tokio::test]
async fn opening_store_installs_agent_timeline_authority() {
    let temp_dir = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp_dir.path().join("domain.sqlite"))
        .await
        .unwrap();

    let tables = sqlx::query_scalar::<_, String>(
        r#"
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
              'agent_interaction_sessions',
              'agent_timeline_rows',
              'agent_timeline_source_receipts',
              'agent_pending_requests'
          )
        ORDER BY name
        "#,
    )
    .fetch_all(&store.pool)
    .await
    .unwrap();

    assert_eq!(
        tables,
        vec![
            "agent_interaction_sessions",
            "agent_pending_requests",
            "agent_timeline_rows",
            "agent_timeline_source_receipts",
        ]
    );
}

#[tokio::test]
async fn durable_replay_survives_reopen_and_exact_provider_duplicates_do_not_resequence() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = provision(&path).await;
    let mut retried_binding = interaction_binding();
    retried_binding.created_at_ms = 900;
    retried_binding.updated_at_ms = 900;
    assert_eq!(
        store
            .create_agent_interaction(&retried_binding)
            .await
            .unwrap()
            .created_at_ms,
        100
    );
    let first = store.record_agent_turn_intent(&start_turn()).await.unwrap();
    assert!(first.newly_prepared);
    assert_eq!(first.state, AgentTurnEffectStateV1::Prepared);
    let mut retried_intent = start_turn();
    retried_intent.requested_at_ms = 999;
    let retry = store
        .record_agent_turn_intent(&retried_intent)
        .await
        .unwrap();
    assert!(!retry.newly_prepared);
    assert_eq!(retry.state, AgentTurnEffectStateV1::Uncertain);
    assert_eq!(retry.intent.requested_at_ms, 110);

    let delta = provider_event(
        1,
        vec![AgentTimelineMutationV1::AppendText {
            fragment: AgentTimelineTextFragmentV1 {
                stream_id: AgentTimelineStreamIdV1::new("assistant-message-1-block-0").unwrap(),
                item_id: AgentTimelineItemIdV1::new("assistant-item-1-block-0").unwrap(),
                kind: AgentTimelineTextKindV1::Assistant,
                fragment: "Hello from the provider".into(),
                turn_id: Some(AgentTurnIdV1::new("turn-1").unwrap()),
                client_message_id: Some(AgentClientMessageIdV1::new("client-message-1").unwrap()),
                provider_message_id: AgentProviderMessageIdV1::new("provider-message-1").unwrap(),
                observed_at_ms: 121,
            },
        }],
    );
    store.apply_agent_provider_event(&delta).await.unwrap();
    let before_reopen = tail(&store).await;
    assert_eq!(before_reopen.rows.len(), 2);
    assert_eq!(before_reopen.live_text.len(), 1);
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let duplicate = reopened.apply_agent_provider_event(&delta).await.unwrap();
    assert!(duplicate.duplicate);
    assert!(!duplicate.timeline_changed);
    assert!(!duplicate.pending_changed);
    assert!(!duplicate.live_text_changed);
    assert_eq!(duplicate.provider_cursor.committed_through_sequence, 1);
    reopened
        .apply_agent_provider_event(&provider_event(
            2,
            vec![AgentTimelineMutationV1::FinishTextForProviderMessage {
                provider_message_id: AgentProviderMessageIdV1::new("provider-message-1").unwrap(),
                finished_at_ms: 130,
            }],
        ))
        .await
        .unwrap();
    let after_reopen = tail(&reopened).await;
    assert_eq!(after_reopen.rows.len(), 3);
    assert!(after_reopen.live_text.is_empty());
    assert_eq!(
        after_reopen.binding.execution_profile,
        interaction_binding().execution_profile
    );
    assert_eq!(after_reopen.final_cursor.sequence, 3);
}

#[tokio::test]
async fn bounded_tail_reports_the_active_turn_after_its_start_row_is_trimmed() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();

    for sequence in 1..=128 {
        store
            .apply_agent_provider_event(&provider_event(
                sequence,
                vec![AgentTimelineMutationV1::Append {
                    item: AgentTimelineItemDraftV1 {
                        item_id: AgentTimelineItemIdV1::new(format!("reasoning-{sequence}"))
                            .unwrap(),
                        turn_id: Some(AgentTurnIdV1::new("turn-1").unwrap()),
                        client_message_id: Some(
                            AgentClientMessageIdV1::new("client-message-1").unwrap(),
                        ),
                        provider_message_id: Some(
                            AgentProviderMessageIdV1::new(format!("provider-message-{sequence}"))
                                .unwrap(),
                        ),
                        body: AgentTimelineItemBodyV1::Reasoning {
                            text: format!("step {sequence}"),
                        },
                        created_at_ms: 200 + sequence,
                    },
                }],
            ))
            .await
            .unwrap();
    }

    let active = tail(&store).await;
    assert_eq!(active.rows.len(), 128);
    assert!(active.rows.iter().all(|row| {
        !matches!(
            row.item.body,
            AgentTimelineItemBodyV1::Lifecycle {
                state: dure_app::AgentTimelineLifecycleStateV1::TurnStarted,
                ..
            }
        )
    }));
    assert_eq!(
        active.active_turn,
        Some(dure_app::AgentTimelineActiveTurnV1 {
            turn_id: AgentTurnIdV1::new("turn-1").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("client-message-1").unwrap(),
        })
    );

    store
        .apply_agent_provider_event(&provider_event(
            129,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("other-turn-terminal").unwrap(),
                    turn_id: Some(AgentTurnIdV1::new("other-turn").unwrap()),
                    client_message_id: Some(
                        AgentClientMessageIdV1::new("other-client-message").unwrap(),
                    ),
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: dure_app::AgentTimelineLifecycleStateV1::TurnCompleted,
                        detail: None,
                    },
                    created_at_ms: 400,
                },
            }],
        ))
        .await
        .unwrap();
    assert_eq!(tail(&store).await.active_turn, active.active_turn);

    store
        .apply_agent_provider_event(&provider_event(
            130,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("turn-terminal").unwrap(),
                    turn_id: Some(AgentTurnIdV1::new("turn-1").unwrap()),
                    client_message_id: Some(
                        AgentClientMessageIdV1::new("client-message-1").unwrap(),
                    ),
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: dure_app::AgentTimelineLifecycleStateV1::TurnCompleted,
                        detail: None,
                    },
                    created_at_ms: 401,
                },
            }],
        ))
        .await
        .unwrap();
    assert_eq!(tail(&store).await.active_turn, None);
}

#[tokio::test]
async fn active_turn_ends_at_the_runtime_session_boundary() {
    let temp_dir = TempDir::new().unwrap();
    let spawned = provision(&temp_dir.path().join("spawned.sqlite")).await;
    spawned
        .apply_agent_provider_event(&provider_event(
            1,
            vec![session_lifecycle(
                "session-down",
                AgentTimelineLifecycleStateV1::SessionExited,
                100,
            )],
        ))
        .await
        .unwrap();
    spawned
        .record_agent_turn_intent(&start_turn())
        .await
        .unwrap();
    spawned
        .apply_agent_provider_event(&provider_event(
            2,
            vec![session_lifecycle(
                "session-spawned",
                AgentTimelineLifecycleStateV1::SessionReady,
                120,
            )],
        ))
        .await
        .unwrap();
    assert!(tail(&spawned).await.active_turn.is_some());
    spawned
        .apply_agent_provider_event(&provider_event(
            3,
            vec![session_lifecycle(
                "session-ended",
                AgentTimelineLifecycleStateV1::SessionExited,
                130,
            )],
        ))
        .await
        .unwrap();
    assert_eq!(tail(&spawned).await.active_turn, None);

    let warm = provision(&temp_dir.path().join("warm.sqlite")).await;
    warm.apply_agent_provider_event(&provider_event(
        1,
        vec![session_lifecycle(
            "session-ready",
            AgentTimelineLifecycleStateV1::SessionReady,
            100,
        )],
    ))
    .await
    .unwrap();
    warm.record_agent_turn_intent(&start_turn()).await.unwrap();
    warm.apply_agent_provider_event(&provider_event(
        2,
        vec![session_lifecycle(
            "session-replaced",
            AgentTimelineLifecycleStateV1::SessionReady,
            120,
        )],
    ))
    .await
    .unwrap();
    assert_eq!(tail(&warm).await.active_turn, None);
}

#[tokio::test]
async fn history_reconciliation_atomically_extends_and_finishes_live_assistant_text() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    let fragment = |text: &str, observed_at_ms| AgentTimelineTextFragmentV1 {
        stream_id: AgentTimelineStreamIdV1::new("assistant-message-1-block-0").unwrap(),
        item_id: AgentTimelineItemIdV1::new("assistant-item-1-block-0").unwrap(),
        kind: AgentTimelineTextKindV1::Assistant,
        fragment: text.into(),
        turn_id: Some(AgentTurnIdV1::new("turn-1").unwrap()),
        client_message_id: Some(AgentClientMessageIdV1::new("client-message-1").unwrap()),
        provider_message_id: AgentProviderMessageIdV1::new("provider-message-1").unwrap(),
        observed_at_ms,
    };
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::AppendText {
                fragment: fragment("hel", 121),
            }],
        ))
        .await
        .unwrap();

    store
        .apply_agent_provider_event(&provider_event(
            2,
            vec![
                AgentTimelineMutationV1::AppendText {
                    fragment: fragment("lo", 122),
                },
                AgentTimelineMutationV1::FinishTextForProviderMessage {
                    provider_message_id: AgentProviderMessageIdV1::new("provider-message-1")
                        .unwrap(),
                    finished_at_ms: 122,
                },
            ],
        ))
        .await
        .unwrap();

    let page = tail(&store).await;
    assert!(page.live_text.is_empty());
    assert!(page.rows.iter().any(|row| {
        matches!(
            &row.item.body,
            AgentTimelineItemBodyV1::Message {
                role: dure_app::AgentTimelineMessageRoleV1::Assistant,
                markdown,
            } if markdown == "hello"
        )
    }));
}

#[tokio::test]
async fn pending_snapshots_converge_and_runtime_replacement_fences_stale_answers_and_events() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::PutPending {
                request: pending_request(),
            }],
        ))
        .await
        .unwrap();
    store
        .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            runtime: runtime(1),
            observed_through_sequence: 1,
            requests: vec![pending_request()],
            observed_at_ms: 130,
        })
        .await
        .unwrap();
    assert_eq!(tail(&store).await.pending_requests.len(), 1);
    store
        .apply_agent_provider_event(&provider_event(2, vec![]))
        .await
        .unwrap();
    store
        .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            runtime: runtime(1),
            observed_through_sequence: 2,
            requests: vec![],
            observed_at_ms: 135,
        })
        .await
        .unwrap();
    assert!(tail(&store).await.pending_requests.is_empty());

    let replacement_request = AgentRuntimeReplacementV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        expected_binding_revision: 1,
        source: runtime(1),
        source_execution_profile: interaction_binding().execution_profile,
        target: runtime(2),
        target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-1".into()),
        replaced_at_ms: 140,
    };
    let replacement = store
        .replace_agent_interaction_runtime(&replacement_request)
        .await
        .unwrap();
    assert_eq!(replacement.runtime, runtime(2));
    assert_eq!(
        replacement.execution_profile,
        AgentExecutionProfileV1::ProviderDefault
    );
    let mut retried_replacement = replacement_request;
    retried_replacement.replaced_at_ms = 999;
    assert_eq!(
        store
            .replace_agent_interaction_runtime(&retried_replacement)
            .await
            .unwrap(),
        replacement
    );
    assert_eq!(
        store
            .record_agent_turn_intent(&start_turn())
            .await
            .unwrap()
            .state,
        AgentTurnEffectStateV1::Uncertain
    );
    assert!(tail(&store).await.pending_requests.is_empty());

    let stale_answer = store
        .prepare_agent_pending_answer(&AgentPendingAnswerIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            runtime: runtime(1),
            request_id: AgentInteractionRequestIdV1::new("permission-1").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("client-message-1").unwrap(),
            idempotency_key: "answer-1".into(),
            answer: json!({ "decision": "allow" }),
            requested_at_ms: 141,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        stale_answer,
        DomainStoreErrorV1::IdentityConflict { .. }
    ));
    let stale_event = store
        .apply_agent_provider_event(&provider_event(3, vec![]))
        .await
        .unwrap_err();
    assert!(matches!(
        stale_event,
        DomainStoreErrorV1::IdentityConflict { .. }
    ));

    let new_runtime_event = AgentProviderEventCommitV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        event: AgentProviderEventIdentityV1 {
            runtime: runtime(2),
            sequence: 1,
        },
        source_fingerprint: "fake-source-runtime-2-1".into(),
        mutations: vec![],
        recorded_at_ms: 142,
    };
    assert_eq!(
        store
            .apply_agent_provider_event(&new_runtime_event)
            .await
            .unwrap()
            .provider_cursor
            .committed_through_sequence,
        1
    );
}

#[tokio::test]
async fn host_gap_is_durable_visible_and_advances_the_exact_source_cursor() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store
        .apply_agent_provider_event(&provider_event(1, vec![]))
        .await
        .unwrap();
    let gap = AgentProviderGapV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        runtime: runtime(1),
        requested_after_sequence: 1,
        dropped_through_sequence: 3,
        observed_at_ms: 130,
    };
    let receipt = store.record_agent_provider_gap(&gap).await.unwrap();
    assert_eq!(receipt.provider_cursor.committed_through_sequence, 3);
    assert!(
        store
            .record_agent_provider_gap(&gap)
            .await
            .unwrap()
            .duplicate
    );
    store
        .apply_agent_provider_event(&provider_event(4, vec![]))
        .await
        .unwrap();
    let page = tail(&store).await;
    assert!(!page.binding.history_complete);
    assert_eq!(page.rows.len(), 1);
    assert!(matches!(
        page.rows[0].item.body,
        dure_app::AgentTimelineItemBodyV1::HistoryBoundary { .. }
    ));
}

fn history_item(id: &str, role: dure_app::AgentTimelineMessageRoleV1) -> AgentTimelineItemDraftV1 {
    AgentTimelineItemDraftV1 {
        item_id: AgentTimelineItemIdV1::new(id).unwrap(),
        turn_id: None,
        client_message_id: None,
        provider_message_id: None,
        body: AgentTimelineItemBodyV1::Message {
            role,
            markdown: format!("history {id}"),
        },
        created_at_ms: 0,
    }
}

#[tokio::test]
async fn complete_history_seeds_after_hidden_rows_without_advancing_the_live_cursor() {
    let temp_dir = TempDir::new().unwrap();
    let mut binding = interaction_binding();
    binding.history_complete = false;
    let store = provision_with_binding(&temp_dir.path().join("domain.sqlite"), binding).await;
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![
                AgentTimelineMutationV1::Append {
                    item: AgentTimelineItemDraftV1 {
                        item_id: AgentTimelineItemIdV1::new("hidden-lifecycle").unwrap(),
                        turn_id: None,
                        client_message_id: None,
                        provider_message_id: None,
                        body: AgentTimelineItemBodyV1::Lifecycle {
                            state: dure_app::AgentTimelineLifecycleStateV1::SessionExited,
                            detail: Some(json!({ "code": 0, "signal": null }).to_string()),
                        },
                        created_at_ms: 110,
                    },
                },
                AgentTimelineMutationV1::Append {
                    item: AgentTimelineItemDraftV1 {
                        item_id: AgentTimelineItemIdV1::new("hidden-evidence").unwrap(),
                        turn_id: None,
                        client_message_id: None,
                        provider_message_id: None,
                        body: AgentTimelineItemBodyV1::ProviderEvidence {
                            namespace: "provider.fake".into(),
                            kind: "hook".into(),
                            value: json!({}),
                        },
                        created_at_ms: 111,
                    },
                },
            ],
        ))
        .await
        .unwrap();
    let incomplete = store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    let snapshot = AgentHistorySnapshotV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        binding: incomplete,
        items: vec![
            history_item("history-user", dure_app::AgentTimelineMessageRoleV1::User),
            history_item(
                "history-assistant",
                dure_app::AgentTimelineMessageRoleV1::Assistant,
            ),
        ],
        observed_at_ms: 120,
    };
    let receipt = store.reconcile_agent_history(&snapshot).await.unwrap();
    assert!(receipt.binding.history_complete);
    assert!(receipt.newly_completed);
    assert_eq!(
        store
            .agent_provider_cursor(
                &AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
                &runtime(1),
            )
            .await
            .unwrap()
            .committed_through_sequence,
        1
    );
    let replay = store.reconcile_agent_history(&snapshot).await.unwrap();
    assert!(!replay.newly_completed);
    assert!(!replay.timeline_changed);
    let page = tail(&store).await;
    assert_eq!(page.rows.len(), 4);
    assert!(matches!(
        page.rows[2].item.body,
        AgentTimelineItemBodyV1::Message { .. }
    ));
    assert!(matches!(
        page.rows[3].item.body,
        AgentTimelineItemBodyV1::Message { .. }
    ));
}

#[tokio::test]
async fn empty_exact_history_completes_without_rows_or_live_cursor_movement() {
    let temp_dir = TempDir::new().unwrap();
    let mut binding = interaction_binding();
    binding.history_complete = false;
    let store = provision_with_binding(&temp_dir.path().join("domain.sqlite"), binding).await;
    let current = store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    let receipt = store
        .reconcile_agent_history(&AgentHistorySnapshotV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            binding: current,
            items: Vec::new(),
            observed_at_ms: 120,
        })
        .await
        .unwrap();
    assert!(receipt.binding.history_complete);
    assert!(receipt.newly_completed);
    assert!(!receipt.timeline_changed);
    let page = tail(&store).await;
    assert!(page.rows.is_empty());
    assert_eq!(
        store
            .agent_provider_cursor(
                &AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
                &runtime(1),
            )
            .await
            .unwrap()
            .committed_through_sequence,
        0
    );
}

#[tokio::test]
async fn history_hydration_authority_never_mixes_pre_and_post_commit_rows() {
    let temp_dir = TempDir::new().unwrap();
    let mut binding = interaction_binding();
    binding.history_complete = false;
    let store = provision_with_binding(&temp_dir.path().join("domain.sqlite"), binding).await;
    let interaction_session_id = AgentInteractionSessionIdV1::new("interaction-1").unwrap();
    let stale = store
        .agent_interaction(&interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    let snapshot = AgentHistorySnapshotV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        binding: stale,
        items: vec![history_item(
            "history-atomic-snapshot",
            dure_app::AgentTimelineMessageRoleV1::Assistant,
        )],
        observed_at_ms: 120,
    };

    let mut reader = store.pool.acquire().await.unwrap();
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *reader)
        .await
        .unwrap();
    assert!(!sqlx::query_scalar::<_, bool>(
        "SELECT history_complete FROM agent_interaction_sessions WHERE interaction_session_id = ?1",
    )
    .bind(interaction_session_id.as_str())
    .fetch_one(&mut *reader)
    .await
    .unwrap());

    let committed = store.reconcile_agent_history(&snapshot).await.unwrap();
    assert!(committed.binding.history_complete);
    let pre_commit =
        super::agent_timeline::history_hydration_authority_on(&mut reader, &interaction_session_id)
            .await
            .unwrap();
    assert!(!pre_commit.binding.history_complete);
    assert_eq!(
        pre_commit.disposition,
        AgentHistoryHydrationDispositionV1::Seedable
    );
    sqlx::query("COMMIT").execute(&mut *reader).await.unwrap();

    let post_commit = store
        .agent_history_hydration_authority(&interaction_session_id)
        .await
        .unwrap();
    assert!(post_commit.binding.history_complete);
    assert_eq!(
        post_commit.disposition,
        AgentHistoryHydrationDispositionV1::Complete
    );
    assert!(
        !store
            .reconcile_agent_history(&snapshot)
            .await
            .unwrap()
            .newly_completed
    );
}

#[tokio::test]
async fn incomplete_history_without_a_provider_conversation_fails_closed() {
    let temp_dir = TempDir::new().unwrap();
    let mut binding = interaction_binding();
    binding.provider_conversation_ref = None;
    binding.history_complete = false;
    let store = provision_with_binding(&temp_dir.path().join("domain.sqlite"), binding).await;
    assert!(matches!(
        store
            .agent_history_hydration_authority(
                &AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            )
            .await
            .unwrap_err(),
        DomainStoreErrorV1::IdentityConflict { .. }
    ));
}

#[tokio::test]
async fn incomplete_history_with_live_content_converges_as_a_known_gap() {
    let temp_dir = TempDir::new().unwrap();
    let mut binding = interaction_binding();
    binding.history_complete = false;
    let store = provision_with_binding(&temp_dir.path().join("domain.sqlite"), binding).await;
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("live-message").unwrap(),
                    turn_id: None,
                    client_message_id: None,
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Message {
                        role: dure_app::AgentTimelineMessageRoleV1::Assistant,
                        markdown: "live content after unavailable history".into(),
                    },
                    created_at_ms: 110,
                },
            }],
        ))
        .await
        .unwrap();

    let authority = store
        .agent_history_hydration_authority(
            &AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        authority.disposition,
        AgentHistoryHydrationDispositionV1::KnownGap
    );
    assert!(!authority.binding.history_complete);
}

#[tokio::test]
async fn history_reconciliation_rejects_failure_lifecycle_and_pending_authority() {
    let temp_dir = TempDir::new().unwrap();
    let mut binding = interaction_binding();
    binding.history_complete = false;
    let failure_store =
        provision_with_binding(&temp_dir.path().join("failure.sqlite"), binding).await;
    failure_store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("visible-failure").unwrap(),
                    turn_id: None,
                    client_message_id: None,
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: dure_app::AgentTimelineLifecycleStateV1::TurnFailed,
                        detail: None,
                    },
                    created_at_ms: 110,
                },
            }],
        ))
        .await
        .unwrap();
    let current = failure_store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        failure_store
            .reconcile_agent_history(&AgentHistorySnapshotV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                binding: current,
                items: vec![history_item(
                    "history-after-failure",
                    dure_app::AgentTimelineMessageRoleV1::Assistant,
                )],
                observed_at_ms: 120,
            })
            .await
            .unwrap_err(),
        DomainStoreErrorV1::IdentityConflict { .. }
    ));

    let mut binding = interaction_binding();
    binding.history_complete = false;
    let abnormal_store =
        provision_with_binding(&temp_dir.path().join("abnormal.sqlite"), binding).await;
    abnormal_store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("abnormal-exit").unwrap(),
                    turn_id: None,
                    client_message_id: None,
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: dure_app::AgentTimelineLifecycleStateV1::SessionExited,
                        detail: Some("provider exited unexpectedly".into()),
                    },
                    created_at_ms: 110,
                },
            }],
        ))
        .await
        .unwrap();
    let current = abnormal_store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        abnormal_store
            .reconcile_agent_history(&AgentHistorySnapshotV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                binding: current,
                items: vec![history_item(
                    "history-after-abnormal-exit",
                    dure_app::AgentTimelineMessageRoleV1::Assistant,
                )],
                observed_at_ms: 120,
            })
            .await
            .unwrap_err(),
        DomainStoreErrorV1::IdentityConflict { .. }
    ));

    let mut binding = interaction_binding();
    binding.history_complete = false;
    let pending_store =
        provision_with_binding(&temp_dir.path().join("pending.sqlite"), binding).await;
    pending_store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::PutPending {
                request: pending_request(),
            }],
        ))
        .await
        .unwrap();
    let current = pending_store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        pending_store
            .reconcile_agent_history(&AgentHistorySnapshotV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                binding: current,
                items: vec![history_item(
                    "history-during-pending",
                    dure_app::AgentTimelineMessageRoleV1::Assistant,
                )],
                observed_at_ms: 120,
            })
            .await
            .unwrap_err(),
        DomainStoreErrorV1::IdentityConflict { .. }
    ));
}

#[tokio::test]
async fn history_reconciliation_rejects_visible_content_and_rolls_back_item_conflicts() {
    let temp_dir = TempDir::new().unwrap();
    let mut binding = interaction_binding();
    binding.history_complete = false;
    let store = provision_with_binding(&temp_dir.path().join("domain.sqlite"), binding).await;
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("existing-message").unwrap(),
                    turn_id: None,
                    client_message_id: None,
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Message {
                        role: dure_app::AgentTimelineMessageRoleV1::Assistant,
                        markdown: "live content".into(),
                    },
                    created_at_ms: 110,
                },
            }],
        ))
        .await
        .unwrap();
    let current = store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    let error = store
        .reconcile_agent_history(&AgentHistorySnapshotV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            binding: current,
            items: vec![history_item(
                "history-user",
                dure_app::AgentTimelineMessageRoleV1::User,
            )],
            observed_at_ms: 120,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, DomainStoreErrorV1::IdentityConflict { .. }));
    let page = tail(&store).await;
    assert!(!page.binding.history_complete);
    assert_eq!(page.rows.len(), 1);

    let mut binding = interaction_binding();
    binding.history_complete = false;
    let conflict_store =
        provision_with_binding(&temp_dir.path().join("conflict.sqlite"), binding).await;
    conflict_store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("history-collision").unwrap(),
                    turn_id: None,
                    client_message_id: None,
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::ProviderEvidence {
                        namespace: "provider.fake".into(),
                        kind: "hidden".into(),
                        value: json!({}),
                    },
                    created_at_ms: 110,
                },
            }],
        ))
        .await
        .unwrap();
    let current = conflict_store
        .agent_interaction(&AgentInteractionSessionIdV1::new("interaction-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    let conflict = AgentHistorySnapshotV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        binding: current,
        items: vec![
            history_item(
                "history-would-be-partial",
                dure_app::AgentTimelineMessageRoleV1::User,
            ),
            history_item(
                "history-collision",
                dure_app::AgentTimelineMessageRoleV1::Assistant,
            ),
        ],
        observed_at_ms: 120,
    };
    assert!(matches!(
        conflict_store
            .reconcile_agent_history(&conflict)
            .await
            .unwrap_err(),
        DomainStoreErrorV1::IdentityConflict { .. }
    ));
    let page = tail(&conflict_store).await;
    assert!(!page.binding.history_complete);
    assert_eq!(page.rows.len(), 1);
}

#[tokio::test]
async fn before_pages_advance_from_the_oldest_returned_row_without_overlap() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    for sequence in 1..=4 {
        store
            .apply_agent_provider_event(&provider_event(
                sequence,
                vec![AgentTimelineMutationV1::Append {
                    item: AgentTimelineItemDraftV1 {
                        item_id: AgentTimelineItemIdV1::new(format!("provider-item-{sequence}"))
                            .unwrap(),
                        turn_id: None,
                        client_message_id: None,
                        provider_message_id: None,
                        body: AgentTimelineItemBodyV1::ProviderEvidence {
                            namespace: "provider.fake".into(),
                            kind: "page_item".into(),
                            value: json!({ "sequence": sequence }),
                        },
                        created_at_ms: 200 + sequence,
                    },
                }],
            ))
            .await
            .unwrap();
    }

    let tail = read_page(&store, AgentTimelineReadDirectionV1::Tail, None, 2).await;
    assert_eq!(
        tail.rows
            .iter()
            .map(|row| row.cursor.sequence)
            .collect::<Vec<_>>(),
        vec![5, 6]
    );
    let older = read_page(
        &store,
        AgentTimelineReadDirectionV1::Before,
        Some(tail.rows[0].cursor.clone()),
        2,
    )
    .await;
    assert_eq!(
        older
            .rows
            .iter()
            .map(|row| row.cursor.sequence)
            .collect::<Vec<_>>(),
        vec![3, 4]
    );
    assert_eq!(older.final_cursor.sequence, 3);
    let oldest = read_page(
        &store,
        AgentTimelineReadDirectionV1::Before,
        Some(older.final_cursor),
        2,
    )
    .await;
    assert_eq!(
        oldest
            .rows
            .iter()
            .map(|row| row.cursor.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[tokio::test]
async fn timeline_reads_bound_live_heads_and_pending_requests_outside_the_row_page() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    let pending = (0..MAX_AGENT_PENDING_REQUESTS_V1)
        .map(|index| AgentTimelineMutationV1::PutPending {
            request: AgentPendingRequestDraftV1 {
                request_id: AgentInteractionRequestIdV1::new(format!("permission-{index}"))
                    .unwrap(),
                kind: AgentPendingRequestKindV1::Permission,
                turn_id: None,
                client_message_id: AgentClientMessageIdV1::new(format!("client-{index}")).unwrap(),
                payload: json!({ "index": index }),
                created_at_ms: 300 + i64::try_from(index).unwrap(),
            },
        })
        .collect();
    store
        .apply_agent_provider_event(&provider_event(1, pending))
        .await
        .unwrap();
    let live_heads = (0..MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1)
        .map(|index| AgentTimelineMutationV1::AppendText {
            fragment: AgentTimelineTextFragmentV1 {
                stream_id: AgentTimelineStreamIdV1::new(format!("stream-{index}")).unwrap(),
                item_id: AgentTimelineItemIdV1::new(format!("live-item-{index}")).unwrap(),
                kind: AgentTimelineTextKindV1::Assistant,
                fragment: "x".into(),
                turn_id: None,
                client_message_id: None,
                provider_message_id: AgentProviderMessageIdV1::new(format!("message-{index}"))
                    .unwrap(),
                observed_at_ms: 400 + i64::try_from(index).unwrap(),
            },
        })
        .collect();
    store
        .apply_agent_provider_event(&provider_event(2, live_heads))
        .await
        .unwrap();
    let page = tail(&store).await;
    assert_eq!(page.pending_requests.len(), MAX_AGENT_PENDING_REQUESTS_V1);
    assert_eq!(page.live_text.len(), MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1);

    let extra_pending = provider_event(
        3,
        vec![AgentTimelineMutationV1::PutPending {
            request: AgentPendingRequestDraftV1 {
                request_id: AgentInteractionRequestIdV1::new("permission-overflow").unwrap(),
                kind: AgentPendingRequestKindV1::Permission,
                turn_id: None,
                client_message_id: AgentClientMessageIdV1::new("client-overflow").unwrap(),
                payload: json!({}),
                created_at_ms: 500,
            },
        }],
    );
    assert!(matches!(
        store
            .apply_agent_provider_event(&extra_pending)
            .await
            .unwrap_err(),
        DomainStoreErrorV1::InvalidRecord { .. }
    ));
    let extra_live = provider_event(
        3,
        vec![AgentTimelineMutationV1::AppendText {
            fragment: AgentTimelineTextFragmentV1 {
                stream_id: AgentTimelineStreamIdV1::new("stream-overflow").unwrap(),
                item_id: AgentTimelineItemIdV1::new("live-item-overflow").unwrap(),
                kind: AgentTimelineTextKindV1::Assistant,
                fragment: "x".into(),
                turn_id: None,
                client_message_id: None,
                provider_message_id: AgentProviderMessageIdV1::new("message-overflow").unwrap(),
                observed_at_ms: 501,
            },
        }],
    );
    assert!(matches!(
        store
            .apply_agent_provider_event(&extra_live)
            .await
            .unwrap_err(),
        DomainStoreErrorV1::InvalidRecord { .. }
    ));
}

#[tokio::test]
async fn answer_completion_and_the_matching_provider_resolution_converge_once() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::PutPending {
                request: pending_request(),
            }],
        ))
        .await
        .unwrap();
    let intent = AgentPendingAnswerIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        runtime: runtime(1),
        request_id: AgentInteractionRequestIdV1::new("permission-1").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("client-message-1").unwrap(),
        idempotency_key: "answer-success-1".into(),
        answer: json!({ "decision": "allow" }),
        requested_at_ms: 130,
    };
    assert!(
        store
            .prepare_agent_pending_answer(&intent)
            .await
            .unwrap()
            .newly_prepared
    );
    let mut retried_intent = intent.clone();
    retried_intent.requested_at_ms = 999;
    let retry = store
        .prepare_agent_pending_answer(&retried_intent)
        .await
        .unwrap();
    assert!(!retry.newly_prepared);
    assert_eq!(retry.intent.requested_at_ms, 130);
    let provider_receipt = json!({
        "clientMessageId": "client-message-1",
        "kind": "permission",
        "outcome": "allow",
        "requestId": "permission-1"
    });
    let completion = AgentCompletePendingAnswerV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        idempotency_key: intent.idempotency_key.clone(),
        state: AgentPendingAnswerStateV1::Succeeded,
        provider_receipt: Some(provider_receipt.clone()),
        updated_at_ms: 131,
    };
    assert_eq!(
        store
            .complete_agent_pending_answer(&completion)
            .await
            .unwrap()
            .state,
        AgentPendingAnswerStateV1::Succeeded
    );
    assert!(tail(&store).await.pending_requests.is_empty());
    let resolution = store
        .apply_agent_provider_event(&provider_event(
            2,
            vec![AgentTimelineMutationV1::ResolvePending {
                request_id: AgentInteractionRequestIdV1::new("permission-1").unwrap(),
                outcome: provider_receipt,
                resolved_at_ms: 132,
            }],
        ))
        .await
        .unwrap();
    assert!(!resolution.pending_changed);
    assert_eq!(
        store
            .complete_agent_pending_answer(&completion)
            .await
            .unwrap()
            .state,
        AgentPendingAnswerStateV1::Succeeded
    );
    let page = tail(&store).await;
    let answers: Vec<_> = page
        .rows
        .iter()
        .map(|row| serde_json::to_value(&row.item.body).unwrap())
        .filter(|body| body["type"] == "pending_answer")
        .collect();
    assert_eq!(
        answers.len(),
        1,
        "a confirmed answer must remain in the shared timeline exactly once"
    );
    assert_eq!(answers[0]["answer"], intent.answer);
    assert_eq!(
        answers[0]["request"]["request"]["requestId"],
        "permission-1"
    );
}

#[tokio::test]
async fn confirmed_answer_history_preserves_payload_bounds_across_reopen() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = provision(&path).await;
    let mut request = pending_request();
    request.payload = json!({ "context": "x".repeat(80_000) });
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::PutPending {
                request: request.clone(),
            }],
        ))
        .await
        .unwrap();
    let mut intent = pending_answer_intent("permission-1", "large-answer", 130);
    intent.answer = json!({ "response": "y".repeat(80_000) });
    store.prepare_agent_pending_answer(&intent).await.unwrap();
    store
        .complete_agent_pending_answer(&AgentCompletePendingAnswerV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            idempotency_key: intent.idempotency_key.clone(),
            state: AgentPendingAnswerStateV1::Succeeded,
            provider_receipt: Some(json!({ "delivered": true })),
            updated_at_ms: 131,
        })
        .await
        .unwrap();
    drop(store);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let page = tail(&store).await;
    let AgentTimelineItemBodyV1::PendingAnswer {
        request: retained,
        answer,
        ..
    } = &page.rows.last().unwrap().item.body
    else {
        panic!("confirmed answer missing");
    };
    assert_eq!(retained.request, request);
    assert_eq!(*answer, intent.answer);
    assert!(page.pending_requests.is_empty());
}

#[tokio::test]
async fn authoritative_snapshot_marks_a_prepared_pending_answer_uncertain() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![
                AgentTimelineMutationV1::PutPending {
                    request: pending_request(),
                },
                AgentTimelineMutationV1::PutPending {
                    request: pending_request_with_id("permission-retained"),
                },
            ],
        ))
        .await
        .unwrap();
    let intent = pending_answer_intent("permission-1", "answer-uncertain-1", 130);
    let retained = pending_answer_intent("permission-retained", "answer-retained-1", 131);
    store.prepare_agent_pending_answer(&intent).await.unwrap();
    store.prepare_agent_pending_answer(&retained).await.unwrap();

    store
        .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            runtime: runtime(1),
            observed_through_sequence: 1,
            requests: vec![pending_request_with_id("permission-retained")],
            observed_at_ms: 140,
        })
        .await
        .unwrap();

    let page = tail(&store).await;
    assert_eq!(page.pending_requests.len(), 1);
    assert_eq!(
        page.pending_requests[0].request.request_id.as_str(),
        "permission-retained"
    );
    let receipt = store.prepare_agent_pending_answer(&intent).await.unwrap();
    assert!(!receipt.newly_prepared);
    assert_eq!(receipt.state, AgentPendingAnswerStateV1::Uncertain);
    assert_eq!(receipt.provider_receipt, None);
    assert_eq!(receipt.updated_at_ms, 140);
    assert_eq!(
        store
            .prepare_agent_pending_answer(&retained)
            .await
            .unwrap()
            .state,
        AgentPendingAnswerStateV1::Prepared
    );
    assert!(matches!(
        store
            .complete_agent_pending_answer(&AgentCompletePendingAnswerV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                idempotency_key: intent.idempotency_key,
                state: AgentPendingAnswerStateV1::Uncertain,
                provider_receipt: None,
                updated_at_ms: 141,
            })
            .await
            .unwrap_err(),
        DomainStoreErrorV1::InvalidRecord { .. }
    ));
}

#[tokio::test]
async fn runtime_replacement_marks_only_prepared_pending_answers_uncertain() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![
                AgentTimelineMutationV1::PutPending {
                    request: pending_request_with_id("permission-prepared"),
                },
                AgentTimelineMutationV1::PutPending {
                    request: pending_request_with_id("permission-succeeded"),
                },
                AgentTimelineMutationV1::PutPending {
                    request: pending_request_with_id("permission-failed"),
                },
            ],
        ))
        .await
        .unwrap();
    let prepared = pending_answer_intent("permission-prepared", "answer-runtime-prepared", 130);
    let succeeded = pending_answer_intent("permission-succeeded", "answer-runtime-succeeded", 131);
    let failed = pending_answer_intent("permission-failed", "answer-runtime-failed", 132);
    for intent in [&prepared, &succeeded, &failed] {
        store.prepare_agent_pending_answer(intent).await.unwrap();
    }
    store
        .complete_agent_pending_answer(&AgentCompletePendingAnswerV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            idempotency_key: succeeded.idempotency_key.clone(),
            state: AgentPendingAnswerStateV1::Succeeded,
            provider_receipt: Some(json!({ "delivered": true })),
            updated_at_ms: 133,
        })
        .await
        .unwrap();
    store
        .complete_agent_pending_answer(&AgentCompletePendingAnswerV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            idempotency_key: failed.idempotency_key.clone(),
            state: AgentPendingAnswerStateV1::Failed,
            provider_receipt: Some(json!({ "errorCode": "provider_failed" })),
            updated_at_ms: 134,
        })
        .await
        .unwrap();

    store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            expected_binding_revision: 1,
            source: runtime(1),
            source_execution_profile: interaction_binding().execution_profile,
            target: runtime(2),
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("conversation-1".into()),
            replaced_at_ms: 140,
        })
        .await
        .unwrap();

    assert!(tail(&store).await.pending_requests.is_empty());
    for (intent, expected) in [
        (&prepared, AgentPendingAnswerStateV1::Uncertain),
        (&succeeded, AgentPendingAnswerStateV1::Succeeded),
        (&failed, AgentPendingAnswerStateV1::Failed),
    ] {
        let receipt = store.prepare_agent_pending_answer(intent).await.unwrap();
        assert!(!receipt.newly_prepared);
        assert_eq!(receipt.state, expected);
    }
    let confirmed: Vec<_> = tail(&store)
        .await
        .rows
        .into_iter()
        .filter_map(|row| match row.item.body {
            AgentTimelineItemBodyV1::PendingAnswer { request, .. } => Some(request),
            _ => None,
        })
        .collect();
    assert_eq!(
        confirmed.len(),
        1,
        "failed and uncertain answers do not become successful history"
    );
    assert_eq!(
        confirmed[0].request.request_id.as_str(),
        "permission-succeeded"
    );
    assert_eq!(confirmed[0].runtime, runtime(1));
    assert_eq!(
        store
            .complete_agent_pending_answer(&AgentCompletePendingAnswerV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                idempotency_key: succeeded.idempotency_key,
                state: AgentPendingAnswerStateV1::Succeeded,
                provider_receipt: Some(json!({ "delivered": true })),
                updated_at_ms: 141,
            })
            .await
            .unwrap()
            .state,
        AgentPendingAnswerStateV1::Succeeded
    );
}

#[tokio::test]
async fn schema_27_migrates_pending_answer_effects_without_losing_prepared_rows() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = provision(&path).await;
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::PutPending {
                request: pending_request(),
            }],
        ))
        .await
        .unwrap();
    let intent = pending_answer_intent("permission-1", "answer-migrated-1", 130);
    store.prepare_agent_pending_answer(&intent).await.unwrap();
    store.close().await;

    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&mut connection)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&mut connection).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 27, min_reader_version = 27, min_writer_version = 27 WHERE singleton = 1",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        dure_app::CURRENT_STORE_SCHEMA_VERSION
    );
    migrated
        .reconcile_agent_pending_snapshot(&AgentPendingSnapshotV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            runtime: runtime(1),
            observed_through_sequence: 1,
            requests: vec![],
            observed_at_ms: 140,
        })
        .await
        .unwrap();
    assert_eq!(
        migrated
            .prepare_agent_pending_answer(&intent)
            .await
            .unwrap()
            .state,
        AgentPendingAnswerStateV1::Uncertain
    );
}

#[tokio::test]
async fn schema_22_migrates_additively_to_the_timeline_authority() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    store.close().await;
    let mut connection = SqliteConnection::connect_with(&writable_connect_options(&path))
        .await
        .unwrap();
    for table in [
        "agent_pending_answer_effects",
        "agent_turn_effects",
        "agent_pending_requests",
        "agent_provider_gaps",
        "agent_timeline_source_receipts",
        "agent_timeline_live_text",
        "agent_timeline_rows",
        "agent_provider_streams",
        "agent_interaction_sessions",
    ] {
        sqlx::query(&format!("DROP TABLE {table}"))
            .execute(&mut connection)
            .await
            .unwrap();
    }
    downgrade_workflow_launch_fixture_to_v31(&mut connection)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&mut connection).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 22, min_reader_version = 1, min_writer_version = 1 WHERE singleton = 1",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        dure_app::CURRENT_STORE_SCHEMA_VERSION
    );
    let tables = sqlx::query_scalar::<_, String>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_timeline_rows'",
    )
    .fetch_all(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(tables, vec!["agent_timeline_rows"]);
}

#[tokio::test]
async fn concurrent_clients_cannot_replace_the_active_turn() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let first_client = provision(&path).await;
    let second_client = SqliteDomainStore::open(&path).await.unwrap();
    let first = start_turn();
    let mut second = first.clone();
    second.turn_id = AgentTurnIdV1::new("turn-2").unwrap();
    second.client_message_id = AgentClientMessageIdV1::new("client-message-2").unwrap();
    second.input = "Another teammate's request".into();
    let (left, right) = tokio::join!(
        first_client.record_agent_turn_intent(&first),
        second_client.record_agent_turn_intent(&second),
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    let (winner, loser, failure) = if left.is_ok() {
        (&first, &second, right.unwrap_err())
    } else {
        (&second, &first, left.unwrap_err())
    };
    assert!(matches!(
        failure,
        DomainStoreErrorV1::IdentityConflict { .. }
    ));
    let page = tail(&first_client).await;
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.active_turn.as_ref().unwrap().turn_id, winner.turn_id);
    assert_eq!(
        first_client
            .record_agent_turn_intent(winner)
            .await
            .unwrap()
            .state,
        AgentTurnEffectStateV1::Uncertain,
    );
    first_client
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("winner-completed").unwrap(),
                    turn_id: Some(winner.turn_id.clone()),
                    client_message_id: Some(winner.client_message_id.clone()),
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: AgentTimelineLifecycleStateV1::TurnCompleted,
                        detail: None,
                    },
                    created_at_ms: 120,
                },
            }],
        ))
        .await
        .unwrap();
    assert!(
        second_client
            .record_agent_turn_intent(loser)
            .await
            .unwrap()
            .newly_prepared
    );
    assert_eq!(
        tail(&first_client).await.active_turn.unwrap().turn_id,
        loser.turn_id
    );
}

#[tokio::test]
async fn idle_conversation_cannot_record_a_steer() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    assert!(matches!(
        store.record_agent_steer_intent(&start_turn()).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. }),
    ));
    assert!(tail(&store).await.rows.is_empty());
}

#[tokio::test]
async fn steer_cannot_record_input_for_another_active_turn() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    let mut stale = start_turn();
    stale.turn_id = AgentTurnIdV1::new("stale-turn").unwrap();
    stale.client_message_id = AgentClientMessageIdV1::new("stale-steer").unwrap();
    assert!(matches!(
        store.record_agent_steer_intent(&stale).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. }),
    ));
    let page = tail(&store).await;
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.active_turn.unwrap().turn_id, start_turn().turn_id);
}

#[tokio::test]
async fn steer_intent_appends_one_user_row_under_the_running_turn() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    let baseline = tail(&store).await;
    let lifecycle_rows = |page: &dure_app::AgentTimelinePageV1| {
        page.rows
            .iter()
            .filter(|row| matches!(row.item.body, AgentTimelineItemBodyV1::Lifecycle { .. }))
            .count()
    };

    let mut steer = start_turn();
    steer.client_message_id = AgentClientMessageIdV1::new("client-steer-1").unwrap();
    steer.input = "also cover the tests".into();
    steer.requested_at_ms = 150;
    let receipt = store.record_agent_steer_intent(&steer).await.unwrap();
    assert!(receipt.newly_prepared);
    assert_eq!(receipt.state, AgentTurnEffectStateV1::Prepared);

    let after = tail(&store).await;
    assert_eq!(after.rows.len(), baseline.rows.len() + 1);
    assert_eq!(lifecycle_rows(&after), lifecycle_rows(&baseline));
    let row = after.rows.last().unwrap();
    assert_eq!(
        row.item.turn_id,
        Some(AgentTurnIdV1::new("turn-1").unwrap())
    );
    assert_eq!(
        row.item.client_message_id,
        Some(AgentClientMessageIdV1::new("client-steer-1").unwrap())
    );
    assert_eq!(
        row.item.body,
        AgentTimelineItemBodyV1::Message {
            role: dure_app::AgentTimelineMessageRoleV1::User,
            markdown: "also cover the tests".into(),
        }
    );

    let mut replay = steer.clone();
    replay.requested_at_ms = 999;
    let retry = store.record_agent_steer_intent(&replay).await.unwrap();
    assert!(!retry.newly_prepared);
    assert_eq!(retry.state, AgentTurnEffectStateV1::Uncertain);
    assert_eq!(retry.intent.requested_at_ms, 150);
    assert_eq!(tail(&store).await.rows.len(), baseline.rows.len() + 1);

    let mut conflicting = steer.clone();
    conflicting.input = "a different steer body".into();
    assert!(matches!(
        store.record_agent_steer_intent(&conflicting).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));

    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![session_lifecycle(
                "provider-exited",
                AgentTimelineLifecycleStateV1::SessionExited,
                200,
            )],
        ))
        .await
        .unwrap();
    let settled = tail(&store).await;
    assert!(settled.active_turn.is_none());
    let receipt = store.record_agent_steer_intent(&replay).await.unwrap();
    assert!(!receipt.newly_prepared);
    assert_eq!(receipt.intent, steer);
    let mut late = steer.clone();
    late.client_message_id = AgentClientMessageIdV1::new("late-steer").unwrap();
    assert!(matches!(
        store.record_agent_steer_intent(&late).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. }),
    ));
    assert_eq!(tail(&store).await.rows, settled.rows);
}

#[tokio::test]
async fn runtime_replacement_converges_open_turns_with_a_terminal_row() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    let before = tail(&store).await;

    let replacement_request = AgentRuntimeReplacementV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        expected_binding_revision: 1,
        source: runtime(1),
        source_execution_profile: interaction_binding().execution_profile,
        target: runtime(2),
        target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-1".into()),
        replaced_at_ms: 140,
    };
    store
        .replace_agent_interaction_runtime(&replacement_request)
        .await
        .unwrap();

    // The replacement is the durable proof the open turn can never finish:
    // it must append that turn's terminal row itself.
    let after = tail(&store).await;
    assert_eq!(after.rows.len(), before.rows.len() + 1);
    let row = after.rows.last().unwrap();
    assert_eq!(
        row.item.client_message_id,
        Some(AgentClientMessageIdV1::new("client-message-1").unwrap())
    );
    assert_eq!(
        row.item.turn_id,
        Some(AgentTurnIdV1::new("turn-1").unwrap())
    );
    assert_eq!(row.item.created_at_ms, 140);
    assert_eq!(
        row.item.body,
        AgentTimelineItemBodyV1::Lifecycle {
            state: dure_app::AgentTimelineLifecycleStateV1::TurnFailed,
            detail: Some("runtime_replaced".into()),
        }
    );

    let mut retried = replacement_request;
    retried.replaced_at_ms = 999;
    store
        .replace_agent_interaction_runtime(&retried)
        .await
        .unwrap();
    assert_eq!(tail(&store).await.rows.len(), before.rows.len() + 1);
}

#[tokio::test]
async fn runtime_replacement_leaves_finished_turns_alone() {
    let temp_dir = TempDir::new().unwrap();
    let store = provision(&temp_dir.path().join("domain.sqlite")).await;
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![AgentTimelineMutationV1::Append {
                item: AgentTimelineItemDraftV1 {
                    item_id: AgentTimelineItemIdV1::new("terminal-1").unwrap(),
                    turn_id: None,
                    client_message_id: Some(
                        AgentClientMessageIdV1::new("client-message-1").unwrap(),
                    ),
                    provider_message_id: None,
                    body: AgentTimelineItemBodyV1::Lifecycle {
                        state: dure_app::AgentTimelineLifecycleStateV1::TurnCompleted,
                        detail: None,
                    },
                    created_at_ms: 130,
                },
            }],
        ))
        .await
        .unwrap();
    let before = tail(&store).await;

    store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            expected_binding_revision: 1,
            source: runtime(1),
            source_execution_profile: interaction_binding().execution_profile,
            target: runtime(2),
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("conversation-1".into()),
            replaced_at_ms: 140,
        })
        .await
        .unwrap();
    assert_eq!(tail(&store).await.rows.len(), before.rows.len());
}
