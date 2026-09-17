use super::conformance_support::*;
use super::*;
use dure_app::*;
use serde_json::json;
use tokio::time::{Duration, timeout};

#[test]
#[ignore = "requires isolated actual Pi, deterministic model backend and Hmux fixture"]
fn live_pi_preserves_conversation_across_settings_busy_turns_and_reconnect() {
    let root = env_path("DURE_QA_PI_RUNTIME_ROOT");
    let run = |reconnect| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(exercise(&root, reconnect))
    };
    let (first, descriptor, endpoint) = run(false);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            release(3).await;
            let (observer, _events) = crate::pi_session_client::PiSessionClient::connect(
                &endpoint,
                &root.join("workspace-0"),
                &first,
            )
            .await
            .unwrap();
            timeout(Duration::from_secs(20), async {
                loop {
                    if !observer.state().await.unwrap().busy() {
                        let entries = observer.entries().await.unwrap();
                        assert!(entries.entries.iter().any(|entry| {
                            entry
                                .pointer("/message/content/0/text")
                                .and_then(serde_json::Value::as_str)
                                == Some("DURE_PI_BLOCK_3")
                        }));
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            })
            .await
            .expect("Pi must complete its accepted turn while the CP is disconnected");
            let decoy = tokio::process::Command::new(env_path("DURE_QA_PI_BIN"))
                .args([
                    "--print",
                    "--session-id",
                    "780ae739-a1f9-4f86-8173-93e51c358c62",
                    "--model",
                    "fixture/model-a",
                    "--thinking",
                    "low",
                    "DURE_PI_DECOY",
                ])
                .current_dir(root.join("workspace-0"))
                .output()
                .await
                .unwrap();
            assert!(
                decoy.status.success(),
                "newer decoy session must be created"
            );
        });
    let (reconnected, observed, _) = run(true);
    assert_eq!(first, reconnected);
    assert_eq!(descriptor.host_instance_id, observed.host_instance_id);
    assert_eq!(descriptor.session_id, observed.session_id);
}

fn settings(model: &str, effort: &str) -> ProviderTurnSettings {
    ProviderTurnSettings::new(
        ProviderPermissionModeV1::Default,
        Some(AgentSpawnModelSelectionV1::parse(model).unwrap()),
        Some(AgentSpawnEffortSelectionV1::parse(effort).unwrap()),
    )
}

async fn release(index: usize) {
    reqwest::get(format!(
        "{}/release/{index}",
        std::env::var("DURE_QA_PI_FIXTURE_URL").unwrap()
    ))
    .await
    .unwrap()
    .error_for_status()
    .unwrap();
}

async fn replace(
    manager: &Manager,
    service: &AgentConversationService<SqliteDomainStore>,
    store: &SqliteDomainStore,
    binding: &AgentInteractionBindingV1,
    next: &ProviderTurnSettings,
    transition: &AgentRuntimeTransitionRecordV1,
) -> AgentInteractionBindingV1 {
    manager.stop_replacement(transition).await.unwrap();
    let stopped = advance(
        store,
        transition,
        AgentRuntimeTransitionAdvanceV1::SourceStopped,
    )
    .await;
    let target = manager
        .open_replacement_runtime(
            open_request(
                &binding.agent_id,
                binding.provider_conversation_ref.clone(),
                next,
            ),
            &stopped,
            ProviderStateEnvironment::default(),
        )
        .await
        .unwrap();
    let started = advance(
        store,
        &stopped,
        AgentRuntimeTransitionAdvanceV1::TargetStarted {
            authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: target.clone(),
            }),
            launch_idempotency_key: None,
        },
    )
    .await;
    advance(store, &started, AgentRuntimeTransitionAdvanceV1::Committed).await;
    assert_eq!(
        target.provider_conversation_ref,
        binding.provider_conversation_ref
    );
    assert_eq!(
        service
            .binding(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(target.clone())
    );
    target
}

async fn exercise(
    root: &Path,
    reconnect: bool,
) -> (AgentInteractionBindingV1, SessionDescriptor, PathBuf) {
    let (store, service, manager) = fixture(
        root,
        reconnect,
        ManagedProviderKind::Pi,
        env_path("DURE_QA_PI_BIN"),
    )
    .await;
    let agent = AgentIdV1::new("agent-pi-scale-0").unwrap();
    let initial = settings("fixture/model-a", "low");
    let mut binding = if reconnect {
        let selection = store
            .agent_runtime_selection(&agent)
            .await
            .unwrap()
            .unwrap();
        let binding = service.binding_for_agent(&agent).await.unwrap().unwrap();
        manager
            .attach_existing_runtime(&selection, &binding)
            .await
            .unwrap()
    } else {
        store
            .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
                schema_version: 1,
                agent_id: agent.clone(),
                provider_id: ProviderIdV1::new("pi").unwrap(),
                interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                permission_mode: initial.permission_mode.clone(),
                model: initial.model.clone(),
                effort: initial.effort.clone(),
                revision: 1,
                selected_by_operation_id: None,
                updated_at_ms: 4,
            })
            .await
            .unwrap();
        manager
            .open_runtime(open_request(&agent, None, &initial))
            .await
            .unwrap()
    };
    if !reconnect {
        assert!(
            binding.provider_conversation_ref.is_none(),
            "Pi has not persisted an empty conversation yet"
        );
        let expected = crate::pi_session_client::SessionId::for_binding(&binding).unwrap();
        let next = settings("fixture/model-a", "high");
        let empty = admit(&store, &binding, &next, 0).await;
        binding = replace(&manager, &service, &store, &binding, &next, &empty).await;
        assert_eq!(
            crate::pi_session_client::SessionId::for_binding(&binding).unwrap(),
            expected
        );
        let warmup = turn_intent(
            &binding,
            "pi-warmup",
            "한글 입력\nDURE_PI_ALLOCATE keep the exact Pi conversation",
        );
        service
            .start_turn(bridge(&manager, &binding).await.as_ref(), &warmup)
            .await
            .unwrap();
        let allocating = admit(&store, &binding, &settings("fixture/model-b", "high"), 99).await;
        let slot = manager
            .slots
            .lock()
            .await
            .get(&binding.interaction_session_id)
            .unwrap()
            .clone();
        let original = slot.lock().await.as_ref().unwrap().bridge.clone();
        slot.lock().await.as_mut().unwrap().bridge = Arc::new(AllocationDuringDrain {
            inner: original.clone(),
            service: service.clone(),
            binding: binding.clone(),
            turn: warmup.turn_id.clone(),
        });
        let failure = manager
            .stop_replacement(&allocating)
            .await
            .expect_err("identity publication while draining must retain the running source");
        assert_eq!(failure.kind, ErrorKind::RuntimeConflict);
        assert!(
            original.is_connected(),
            "the retained Pi process must remain usable"
        );
        slot.lock().await.as_mut().unwrap().bridge = original;
        advance(
            &store,
            &allocating,
            AgentRuntimeTransitionAdvanceV1::SourceRetained,
        )
        .await;
        binding = service.binding_for_agent(&agent).await.unwrap().unwrap();
        assert_eq!(
            binding.provider_conversation_ref.as_deref(),
            Some(expected.as_str())
        );
        for (index, next) in [
            (1, settings("fixture/model-b", "high")),
            (2, settings("fixture/model-b", "low")),
        ] {
            let commands = bridge(&manager, &binding).await;
            let turn = turn_intent(
                &binding,
                &format!("pi-block-{index}"),
                &format!("DURE_PI_BLOCK_{index}"),
            );
            service.start_turn(commands.as_ref(), &turn).await.unwrap();
            let transition = admit(&store, &binding, &next, index).await;
            let error = manager.stop_replacement(&transition).await.unwrap_err();
            assert_eq!(error.kind, ErrorKind::SourceBusy);
            assert_eq!(
                service.binding_for_agent(&agent).await.unwrap(),
                Some(binding.clone())
            );
            let stale = commands
                .interrupt_turn(
                    &binding,
                    &AgentInterruptTurnRequestV1 {
                        schema_version: 1,
                        interaction_session_id: binding.interaction_session_id.clone(),
                        runtime: binding.runtime.clone(),
                        turn_id: AgentTurnIdV1::new("stale-turn").unwrap(),
                        client_message_id: turn.client_message_id.clone(),
                        interrupt_request_id: format!("stale-interrupt-{index}"),
                        requested_at_ms: now_ms().unwrap(),
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(stale.code, "stale_turn");
            release(index).await;
            wait_completed(&service, &binding, &turn.turn_id).await;
            // A repeated canonical input must never ask the model twice.
            service.start_turn(commands.as_ref(), &turn).await.unwrap();
            binding = replace(&manager, &service, &store, &binding, &next, &transition).await;
        }
        let commands = bridge(&manager, &binding).await;
        let question = turn_intent(&binding, "pi-question", "DURE_PI_QUESTION");
        service
            .start_turn(commands.as_ref(), &question)
            .await
            .unwrap();
        let pending = timeout(Duration::from_secs(10), async {
            loop {
                if let Some(request) = page(&service, &binding).await.pending_requests.first() {
                    break request.clone();
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("Pi extension question must reach the common pending surface");
        service
            .answer_pending(
                commands.as_ref(),
                &AgentPendingAnswerIntentV1 {
                    schema_version: 1,
                    interaction_session_id: binding.interaction_session_id.clone(),
                    runtime: binding.runtime.clone(),
                    request_id: pending.request.request_id,
                    client_message_id: pending.request.client_message_id,
                    idempotency_key: "pi-question-answer".into(),
                    answer: json!({"answers":{"answer":"Fixture approved answer"}}),
                    requested_at_ms: now_ms().unwrap(),
                },
            )
            .await
            .unwrap();
        wait_completed(&service, &binding, &question.turn_id).await;
        assert!(page(&service, &binding).await.pending_requests.is_empty());
        let offline = turn_intent(&binding, "pi-offline", "DURE_PI_BLOCK_3");
        service
            .start_turn(bridge(&manager, &binding).await.as_ref(), &offline)
            .await
            .unwrap();
    } else {
        let turn = turn_intent(
            &binding,
            "pi-reconnected",
            "Continue the same Pi conversation after reconnect.",
        );
        service
            .start_turn(bridge(&manager, &binding).await.as_ref(), &turn)
            .await
            .unwrap();
        wait_completed(&service, &binding, &turn.turn_id).await;
        let observed = page(&service, &binding).await;
        assert_eq!(
            observed
                .rows
                .iter()
                .filter(|row| matches!(
                    &row.item.body,
                    AgentTimelineItemBodyV1::Message {
                        role: AgentTimelineMessageRoleV1::User,
                        ..
                    }
                ))
                .count(),
            6
        );
        assert!(!observed.rows.iter().any(|row| matches!(&row.item.body, AgentTimelineItemBodyV1::Message { markdown, .. } if markdown.contains("DURE_PI_DECOY"))));
    }
    let slot = manager
        .slots
        .lock()
        .await
        .get(&binding.interaction_session_id)
        .unwrap()
        .clone();
    let descriptor = slot.lock().await.as_ref().unwrap().descriptor.clone();
    let endpoint = slot.lock().await.as_ref().unwrap().files.endpoint.clone();
    if reconnect {
        manager.stop_binding(&binding, false).await.unwrap();
    }
    (binding, descriptor, endpoint)
}

/// Force the real provider's first persisted answer into the interval between
/// transition admission and drain completion, without scheduling assumptions.
struct AllocationDuringDrain {
    inner: Arc<dyn ManagedProviderConnection>,
    service: Arc<AgentConversationService<SqliteDomainStore>>,
    binding: AgentInteractionBindingV1,
    turn: AgentTurnIdV1,
}
impl crate::agent_conversation::AgentProviderCommands for AllocationDuringDrain {
    fn start_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.inner.start_turn(binding, intent)
    }
    fn answer_pending<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        intent: &'a AgentPendingAnswerIntentV1,
        request: &'a AgentPendingRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.inner.answer_pending(binding, intent, request)
    }
    fn interrupt_turn<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
        request: &'a AgentInterruptTurnRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.inner.interrupt_turn(binding, request)
    }
}
impl ManagedProviderConnection for AllocationDuringDrain {
    fn is_connected(&self) -> bool {
        self.inner.is_connected()
    }
    fn cancel_drain(&self) {
        self.inner.cancel_drain();
    }
    fn begin_idle_drain(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            release(0).await;
            wait_completed(&self.service, &self.binding, &self.turn).await;
            self.inner.begin_idle_drain().await
        })
    }
}
