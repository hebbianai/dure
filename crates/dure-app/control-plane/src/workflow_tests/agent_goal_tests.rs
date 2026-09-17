use super::*;
use crate::agent_conversation::{
    AgentConversationService, AgentProviderCommandFuture, AgentProviderCommands,
};
use crate::agent_conversation_api::{AgentConversationApi, AgentConversationRuntimeRegistry};
use dure_app::{
    AgentGoalPutRequestV1, AgentGoalStatusV1, AgentGoalStore, AgentProviderEventCommitV1,
    AgentProviderEventIdentityV1, AgentStartTurnIntentV1, AgentTimelineItemBodyV1,
    AgentTimelineItemDraftV1, AgentTimelineItemIdV1, AgentTimelineLifecycleStateV1,
    AgentTimelineMutationV1, AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTimelineStore,
};

struct GoalCommands {
    service: Arc<AgentConversationService<SqliteDomainStore>>,
    store: Arc<SqliteDomainStore>,
    calls: StdMutex<BTreeMap<String, Vec<String>>>,
    observed: Notify,
    hold: Notify,
    held_agent: Option<String>,
    fail: bool,
}

impl AgentProviderCommands for GoalCommands {
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            let count = {
                let mut calls = self.calls.lock().unwrap();
                let agent = calls.entry(binding.agent_id.to_string()).or_default();
                agent.push(intent.input.clone());
                agent.len()
            };
            self.observed.notify_one();
            if self.fail {
                return Err(crate::agent_conversation::AgentProviderCommandErrorV1::new(
                    "fixture_start_failed",
                    "fixture failure",
                ));
            }
            if self.held_agent.as_deref() == Some(binding.agent_id.as_str()) {
                self.hold.notified().await;
            }
            if count >= 2 {
                let goal = self
                    .store
                    .agent_goal(&binding.agent_id)
                    .await
                    .unwrap()
                    .unwrap();
                self.store
                    .put_agent_goal(
                        &AgentGoalPutRequestV1 {
                            schema_version: 1,
                            agent_id: binding.agent_id.clone(),
                            expected_revision: goal.revision,
                            idempotency_key: format!("provider-complete-goal-{count}"),
                            objective: goal.objective,
                            status: AgentGoalStatusV1::Complete,
                            detail: Some("Both segments are complete".into()),
                        },
                        now_ms().unwrap(),
                    )
                    .await
                    .unwrap();
            }
            self.service
                .commit_provider_event(&AgentProviderEventCommitV1 {
                    schema_version: 1,
                    interaction_session_id: binding.interaction_session_id.clone(),
                    event: AgentProviderEventIdentityV1 {
                        runtime: binding.runtime.clone(),
                        sequence: count as i64,
                    },
                    source_fingerprint: format!("goal-event-{count}"),
                    recorded_at_ms: now_ms().unwrap(),
                    mutations: vec![AgentTimelineMutationV1::Append {
                        item: AgentTimelineItemDraftV1 {
                            item_id: AgentTimelineItemIdV1::new(format!("goal-segment-{count}"))
                                .unwrap(),
                            turn_id: Some(intent.turn_id.clone()),
                            client_message_id: Some(intent.client_message_id.clone()),
                            provider_message_id: None,
                            created_at_ms: now_ms().unwrap(),
                            body: AgentTimelineItemBodyV1::Lifecycle {
                                state: AgentTimelineLifecycleStateV1::TurnCompleted,
                                detail: None,
                            },
                        },
                    }],
                })
                .await
                .unwrap();
            Ok(json!({ "accepted": true }))
        })
    }

    fn answer_pending<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentPendingAnswerIntentV1,
        _: &'a dure_app::AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async { unreachable!("this fixture does not answer questions") })
    }
    fn interrupt_turn<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async { unreachable!("this fixture does not interrupt") })
    }
}

async fn goal_fixture(
    held_agent: Option<&str>,
    fail: bool,
) -> (TempDir, Arc<ServiceState>, Arc<GoalCommands>) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let service = Arc::new(AgentConversationService::new(Arc::clone(&state.store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let commands = Arc::new(GoalCommands {
        service: Arc::clone(&service),
        store: Arc::clone(&state.store),
        calls: StdMutex::new(BTreeMap::new()),
        observed: Notify::new(),
        hold: Notify::new(),
        held_agent: held_agent.map(Into::into),
        fail,
    });
    for id in ["goal-a", "goal-b"] {
        let agent_id = AgentIdV1::new(id).unwrap();
        let provider_id = ProviderIdV1::new("provider.goal-fixture").unwrap();
        state
            .store
            .upsert_agent(&AgentRecordV1 {
                agent_id: agent_id.clone(),
                workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
                provider_id: provider_id.clone(),
                display_name: id.into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        let binding = AgentInteractionBindingV1 {
            schema_version: 1,
            interaction_session_id: AgentInteractionSessionIdV1::new(format!("conversation-{id}"))
                .unwrap(),
            agent_id,
            provider_id,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some(format!("provider-{id}")),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: format!("runtime-{id}"),
                provider_epoch: "epoch-1".into(),
            },
            timeline_epoch: AgentTimelineEpochV1::new(format!("timeline-{id}")).unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        service.create(&binding).await.unwrap();
        registry.register(binding, commands.clone()).unwrap();
    }
    state.agent_conversation_runtimes = Arc::clone(&registry);
    state.agent_conversations = Arc::new(AgentConversationApi::new(service, registry));
    (root, Arc::new(state), commands)
}

async fn put(state: &Arc<ServiceState>, id: &str, revision: u64, status: &str) -> Value {
    let response = request_over_test_connection(Arc::clone(state), "agent_goal.put", "agent_goal.v1",
        json!({ "schemaVersion": 1, "agentId": id, "expectedRevision": revision,
            "idempotencyKey": format!("{id}-{revision}-{status}"), "objective": "Finish both segments and check the result",
            "status": status, "detail": null })).await;
    assert_eq!(response["kind"], BACKEND_RESPONSE_KIND, "{response}");
    response["result"]["goal"].clone()
}

async fn wait_for_idle(state: &ServiceState, id: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let binding = state
                .store
                .agent_interaction_for_agent(&AgentIdV1::new(id).unwrap())
                .await
                .unwrap()
                .unwrap();
            let read = state
                .store
                .read_agent_timeline(&AgentTimelineReadRequestV1 {
                    schema_version: 1,
                    interaction_session_id: binding.interaction_session_id,
                    direction: AgentTimelineReadDirectionV1::Tail,
                    cursor: None,
                    limit: 1,
                })
                .await
                .unwrap();
            if matches!(read, AgentTimelineReadV1::Page { page } if page.active_turn.is_none()) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_status(state: &ServiceState, id: &str, status: AgentGoalStatusV1) {
    let outcome = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if state
                .store
                .agent_goal(&AgentIdV1::new(id).unwrap())
                .await
                .unwrap()
                .is_some_and(|goal| goal.status == status)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        outcome.is_ok(),
        "goal {id} did not reach {status:?}: {:?}",
        state
            .store
            .agent_goal(&AgentIdV1::new(id).unwrap())
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn explicit_goal_continues_after_a_successful_segment_without_another_human_request() {
    let (_root, state, commands) = goal_fixture(None, false).await;
    let runtime = tokio::spawn(crate::agent_goal::run(Arc::clone(&state)));
    put(&state, "goal-a", 0, "active").await;
    wait_for_status(&state, "goal-a", AgentGoalStatusV1::Complete).await;
    wait_for_idle(&state, "goal-a").await;
    runtime.abort();
    let _ = runtime.await;
    {
        let calls = commands.calls.lock().unwrap();
        assert_eq!(calls["goal-a"].len(), 2);
        assert!(
            !calls.contains_key("goal-b"),
            "ordinary conversations do not become goals"
        );
        assert!(
            calls["goal-a"]
                .iter()
                .all(|input| input.contains("Finish both segments"))
        );
    }
    let read = request_over_test_connection(
        Arc::clone(&state),
        "agent_goal.get",
        "agent_goal.v1",
        json!({ "schemaVersion": 1, "agentId": "goal-a" }),
    )
    .await;
    assert_eq!(read["result"]["goal"]["status"], "complete");
    let mcp_read = request_over_test_connection(
        Arc::clone(&state), "orchestration.invoke", "orchestration.invoke",
        json!({"apiVersion": "dure.orchestration/v1", "method": "agent_goal.get", "body": {"schemaVersion": 1, "agentId": "goal-a"}}),
    ).await;
    assert_eq!(mcp_read["result"]["receipt"], read["result"]);
}

#[tokio::test]
async fn goal_conflicts_are_terminal_without_replacing_current_state_or_accepted_receipts() {
    let (_root, state, _) = goal_fixture(None, false).await;
    let initial = put(&state, "goal-a", 0, "active").await;
    let current = put(&state, "goal-a", 1, "paused").await;
    let mut dispositions = Vec::new();
    for (revision, key) in [(1, "stale-completion"), (0, "goal-a-0-active")] {
        let body = json!({
            "schemaVersion": 1, "agentId": "goal-a", "expectedRevision": revision,
            "idempotencyKey": key, "objective": "Finish only the original work",
            "status": "complete", "detail": null,
        });
        for (operation, capability, request) in [
            ("agent_goal.put", "agent_goal.v1", body.clone()),
            (
                "orchestration.invoke",
                "orchestration.invoke",
                json!({
                    "apiVersion": "dure.orchestration/v1", "method": "agent_goal.put", "body": body,
                }),
            ),
        ] {
            let response =
                request_over_test_connection(Arc::clone(&state), operation, capability, request)
                    .await;
            assert_eq!(
                response["error"]["code"], "agent_goal_conflict",
                "{response}"
            );
            dispositions.push(response["error"]["details"]["disposition"].clone());
            let read = request_over_test_connection(
                Arc::clone(&state),
                "agent_goal.get",
                "agent_goal.v1",
                json!({"schemaVersion": 1, "agentId": "goal-a"}),
            )
            .await;
            assert_eq!(read["result"]["goal"], current);
        }
    }
    let completed = put(&state, "goal-a", 2, "complete").await;
    assert_eq!(completed["revision"], 3);
    assert_eq!(put(&state, "goal-a", 0, "active").await, initial);
    let read = request_over_test_connection(
        Arc::clone(&state),
        "agent_goal.get",
        "agent_goal.v1",
        json!({"schemaVersion": 1, "agentId": "goal-a"}),
    )
    .await;
    assert_eq!(
        read["result"]["goal"], completed,
        "replaying an accepted request must not restore its old state"
    );
    assert_eq!(dispositions, vec![json!("terminal"); 4]);
}

#[tokio::test]
async fn one_slow_goal_does_not_block_another_and_pause_stops_its_next_segment() {
    let (_root, state, commands) = goal_fixture(Some("goal-a"), false).await;
    let runtime = tokio::spawn(crate::agent_goal::run(Arc::clone(&state)));
    put(&state, "goal-a", 0, "active").await;
    tokio::time::timeout(Duration::from_secs(3), commands.observed.notified())
        .await
        .unwrap();
    put(&state, "goal-b", 0, "active").await;
    wait_for_status(&state, "goal-b", AgentGoalStatusV1::Complete).await;
    put(&state, "goal-a", 1, "paused").await;
    commands.hold.notify_one();
    wait_for_idle(&state, "goal-a").await;
    wait_for_idle(&state, "goal-b").await;
    // A later independent goal event drains the queue after the paused turn completes.
    put(&state, "goal-b", 2, "active").await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if commands
                .calls
                .lock()
                .unwrap()
                .get("goal-b")
                .is_some_and(|calls| calls.len() >= 3)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    wait_for_status(&state, "goal-a", AgentGoalStatusV1::Paused).await;
    runtime.abort();
    let _ = runtime.await;
    let calls = commands.calls.lock().unwrap();
    assert_eq!(calls["goal-a"].len(), 1);
    assert_eq!(calls["goal-b"].len(), 3);
}

#[tokio::test]
async fn an_actual_provider_command_failure_stays_failed_across_runtime_restart() {
    let (_root, state, commands) = goal_fixture(None, true).await;
    put(&state, "goal-a", 0, "active").await;
    let runtime = tokio::spawn(crate::agent_goal::run(Arc::clone(&state)));
    wait_for_status(&state, "goal-a", AgentGoalStatusV1::Failed).await;
    runtime.abort();
    let _ = runtime.await;
    let runtime = tokio::spawn(crate::agent_goal::run(Arc::clone(&state)));
    put(&state, "goal-b", 0, "active").await;
    wait_for_status(&state, "goal-b", AgentGoalStatusV1::Failed).await;
    runtime.abort();
    let _ = runtime.await;
    let second = state
        .store
        .agent_goal(&AgentIdV1::new("goal-b").unwrap())
        .await
        .unwrap();
    let calls = commands.calls.lock().unwrap();
    assert_eq!(calls.get("goal-a").map(Vec::len), Some(1), "{second:?}");
    assert_eq!(calls.get("goal-b").map(Vec::len), Some(1), "{second:?}");
}

#[tokio::test]
async fn goal_observation_survives_backend_handoff_and_closed_readers_negotiate_v4() {
    let (_root, state, _) = goal_fixture(None, false).await;
    put(&state, "goal-a", 0, "paused").await;
    let body = json!({"schemaVersion": 1, "interactionSessionId": "conversation-goal-a", "direction": "tail", "cursor": null, "limit": 1});
    let old = request_over_test_connection(
        Arc::clone(&state),
        "agent_conversation.read",
        "agent_conversation.read.v3",
        body.clone(),
    )
    .await;
    assert_eq!(old["error"]["code"], "backend_expectation_mismatch");
    let current = request_over_test_connection(
        Arc::clone(&state),
        "agent_conversation.read",
        "agent_conversation.read.v4",
        body,
    )
    .await;
    assert_eq!(current["result"]["read"]["type"], "page");
    let mut replacement = state.descriptor.clone();
    replacement.generation = "local-v1-11111111111111111111111111111111".into();
    write_descriptor(&state.canonical_descriptor_path, &replacement).unwrap();
    assert!(!state.is_mutation_authority());
    let read = request_over_test_connection(
        Arc::clone(&state),
        "agent_goal.get",
        "agent_goal.v1",
        json!({"schemaVersion": 1, "agentId": "goal-a"}),
    )
    .await;
    assert_eq!(read["result"]["goal"]["status"], "paused");
    let mutation = request_over_test_connection(Arc::clone(&state), "agent_goal.put", "agent_goal.v1", json!({"schemaVersion": 1, "agentId": "goal-a", "expectedRevision": 1, "idempotencyKey": "stale-process", "objective": "Finish both segments", "status": "active"})).await;
    assert_eq!(mutation["error"]["code"], "recovering");
    assert_eq!(
        state
            .store
            .agent_goal(&AgentIdV1::new("goal-a").unwrap())
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );
}

#[tokio::test]
async fn startup_readiness_does_not_fail_or_admit_a_goal_before_its_runtime_is_registered() {
    let (_root, state, commands) = goal_fixture(None, false).await;
    let id = AgentIdV1::new("goal-a").unwrap();
    let binding = state
        .store
        .agent_interaction_for_agent(&id)
        .await
        .unwrap()
        .unwrap();
    state
        .agent_conversation_runtimes
        .retire(&binding.interaction_session_id, &binding.runtime)
        .unwrap();
    put(&state, "goal-a", 0, "active").await;
    let goal = state.store.agent_goal(&id).await.unwrap().unwrap();
    crate::agent_goal::advance(&state, &goal).await.unwrap();
    assert_eq!(state.store.agent_goal(&id).await.unwrap().unwrap(), goal);
    assert!(commands.calls.lock().unwrap().is_empty());
    wait_for_idle(&state, "goal-a").await;
    state
        .agent_conversation_runtimes
        .register(binding, commands.clone())
        .unwrap();
    let runtime = tokio::spawn(crate::agent_goal::run(Arc::clone(&state)));
    state.goal_wakeup.notify_one();
    wait_for_status(&state, "goal-a", AgentGoalStatusV1::Complete).await;
    wait_for_idle(&state, "goal-a").await;
    runtime.abort();
    let _ = runtime.await;
    assert_eq!(commands.calls.lock().unwrap()["goal-a"].len(), 2);
}

#[tokio::test]
async fn goal_changes_invalidate_the_existing_conversation_without_a_new_timeline_row() {
    use crate::agent_conversation::AgentConversationNotificationKindV1;
    let (_root, state, _) = goal_fixture(None, false).await;
    let body = json!({"schemaVersion": 1, "interactionSessionId": "conversation-goal-a", "direction": "tail", "cursor": null, "limit": 1});
    let mut subscription = state.agent_conversations.subscribe(&body).await.unwrap();
    let AgentTimelineReadV1::Page { page: initial } = subscription.initial else {
        panic!("expected page")
    };
    assert!(initial.goal.is_none());
    let goal = put(&state, "goal-a", 0, "paused").await;
    let notification =
        tokio::time::timeout(Duration::from_secs(3), subscription.notifications.recv())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        notification.kinds,
        vec![AgentConversationNotificationKindV1::Goal]
    );
    assert_eq!(notification.timeline_cursor, initial.final_cursor);
    assert_eq!(
        notification.interaction_session_id,
        initial.binding.interaction_session_id
    );
    let response = request_over_test_connection(Arc::clone(&state), "agent_conversation.read", "agent_conversation.read.v4", json!({"direction": "after", "cursor": initial.final_cursor, "schemaVersion": 1, "interactionSessionId": "conversation-goal-a", "limit": 1})).await;
    assert_eq!(response["result"]["read"]["page"]["goal"], goal);
    assert_eq!(response["result"]["read"]["page"]["rows"], json!([]));
    let updated = put(&state, "goal-a", 1, "complete").await;
    let notification = subscription.notifications.recv().await.unwrap();
    assert_eq!(
        notification.kinds,
        vec![AgentConversationNotificationKindV1::Goal]
    );
    let reopened = state.agent_conversations.subscribe(&body).await.unwrap();
    let AgentTimelineReadV1::Page { page } = reopened.initial else {
        panic!("expected page")
    };
    assert_eq!(serde_json::to_value(page.goal).unwrap(), updated);
}
