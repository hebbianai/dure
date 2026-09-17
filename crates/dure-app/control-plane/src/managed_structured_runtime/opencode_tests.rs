use super::*;
use dure_app::*;
use serde_json::json;
use tokio::time::{Duration, timeout};

use super::conformance_support::*;

#[test]
#[ignore = "requires isolated OpenCode, fake LLM, and actual Hmux conformance fixture"]
fn live_opencode_keeps_the_exact_conversation_across_settings_and_reconnect() {
    let root = PathBuf::from(std::env::var_os("DURE_QA_OPENCODE_RUNTIME_ROOT").unwrap());
    let run = |reconnect| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(exercise(&root, reconnect))
    };
    let (first, descriptor, endpoint) = run(false);
    // Dropping the first Tokio runtime disconnects its control plane, while
    // the Hmux-owned provider process continues serving the same generation.
    let observer = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    observer.block_on(async {
        use crate::opencode_session_client::{OpenCodeSessionClient, SessionId};
        reqwest::get(std::env::var("DURE_QA_OPENCODE_OFFLINE_RELEASE").unwrap())
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let client = OpenCodeSessionClient::connect(&endpoint, &root.join("workspace-0"))
            .await
            .unwrap();
        let session =
            SessionId::parse(first.provider_conversation_ref.as_deref().unwrap()).unwrap();
        let user = format!("msg_dure_{}", digest("client-automatic-permission"));
        timeout(Duration::from_secs(20), async {
            loop {
                let messages = client.messages(&session).await.unwrap();
                if messages.iter().any(|message| {
                    message
                        .pointer("/info/parentID")
                        .and_then(serde_json::Value::as_str)
                        == Some(user.as_str())
                        && message
                            .pointer("/info/finish")
                            .and_then(serde_json::Value::as_str)
                            == Some("stop")
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("automatic permission must finish without a connected control plane");
        assert!(client.pending(&session).await.unwrap().is_empty());
        client
            .create(&SessionId::parse("ses_dure_newer_decoy").unwrap())
            .await
            .unwrap();
    });
    let (reconnected, observed, _) = run(true);
    assert_eq!(first, reconnected);
    assert_eq!(descriptor.host_instance_id, observed.host_instance_id);
    assert_eq!(descriptor.session_id, observed.session_id);
}

async fn exercise(
    root: &Path,
    reconnect: bool,
) -> (AgentInteractionBindingV1, SessionDescriptor, PathBuf) {
    let (store, service, manager) = fixture(
        root,
        reconnect,
        ManagedProviderKind::OpenCode,
        env_path("DURE_QA_OPENCODE_BIN"),
    )
    .await;
    let agent_id = AgentIdV1::new("agent-opencode-scale-0").unwrap();
    let mut settings = ProviderTurnSettings::new(
        ProviderPermissionModeV1::Default,
        Some(AgentSpawnModelSelectionV1::parse("fixture/fixture-model").unwrap()),
        Some(AgentSpawnEffortSelectionV1::parse("low").unwrap()),
    );
    let mut binding = if reconnect {
        let selected = store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap();
        let binding = service.binding_for_agent(&agent_id).await.unwrap().unwrap();
        manager
            .attach_existing_runtime(&selected, &binding)
            .await
            .unwrap()
    } else {
        store
            .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
                provider_id: ProviderIdV1::new("opencode").unwrap(),
                interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                permission_mode: settings.permission_mode.clone(),
                model: settings.model.clone(),
                effort: settings.effort.clone(),
                revision: 1,
                selected_by_operation_id: None,
                updated_at_ms: 4,
            })
            .await
            .unwrap();
        manager
            .open_runtime(open_request(&agent_id, None, &settings))
            .await
            .unwrap()
    };
    let conversation = binding
        .provider_conversation_ref
        .clone()
        .expect("fresh allocation must be durable");
    if !reconnect {
        for (index, (model, effort, permission)) in [
            (
                "fixture/fixture-alternate",
                "low",
                ProviderPermissionModeV1::Default,
            ),
            (
                "fixture/fixture-alternate",
                "high",
                ProviderPermissionModeV1::Default,
            ),
            (
                "fixture/fixture-alternate",
                "high",
                ProviderPermissionModeV1::SkipPermissions,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let bridge = bridge(&manager, &binding).await;
            let intent = turn_intent(
                &binding,
                &format!("permission-{index}"),
                "DURE_QA_PERMISSION",
            );
            service.start_turn(bridge.as_ref(), &intent).await.unwrap();
            let pending = timeout(Duration::from_secs(20), async {
                loop {
                    let page = page(&service, &binding).await;
                    if let Some(request) = page.pending_requests.first() {
                        break request.clone();
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .unwrap();
            for (turn_id, client_message_id) in [
                (
                    AgentTurnIdV1::new("stale-turn").unwrap(),
                    intent.client_message_id.clone(),
                ),
                (
                    intent.turn_id.clone(),
                    AgentClientMessageIdV1::new("stale-client").unwrap(),
                ),
            ] {
                let error = bridge
                    .interrupt_turn(
                        &binding,
                        &AgentInterruptTurnRequestV1 {
                            schema_version: 1,
                            interaction_session_id: binding.interaction_session_id.clone(),
                            runtime: binding.runtime.clone(),
                            turn_id,
                            client_message_id,
                            interrupt_request_id: "stale-interrupt".into(),
                            requested_at_ms: now_ms().unwrap(),
                        },
                    )
                    .await
                    .unwrap_err();
                assert_eq!(error.code, "stale_turn");
            }
            let next = ProviderTurnSettings::new(
                permission,
                Some(AgentSpawnModelSelectionV1::parse(model).unwrap()),
                Some(AgentSpawnEffortSelectionV1::parse(effort).unwrap()),
            );
            let transition = admit(&store, &binding, &next, index).await;
            let error = manager.stop_replacement(&transition).await.unwrap_err();
            assert_eq!(error.kind, ErrorKind::SourceBusy);
            assert_eq!(
                service
                    .binding(&binding.interaction_session_id)
                    .await
                    .unwrap(),
                Some(binding.clone())
            );
            service
                .answer_pending(
                    bridge.as_ref(),
                    &AgentPendingAnswerIntentV1 {
                        schema_version: 1,
                        interaction_session_id: binding.interaction_session_id.clone(),
                        runtime: binding.runtime.clone(),
                        request_id: pending.request.request_id,
                        client_message_id: pending.request.client_message_id,
                        idempotency_key: format!("permission-answer-{index}"),
                        answer: json!({"decision":"allow"}),
                        requested_at_ms: now_ms().unwrap(),
                    },
                )
                .await
                .unwrap();
            wait_completed(&service, &binding, &intent.turn_id).await;
            manager.stop_replacement(&transition).await.unwrap();
            let stopped = advance(
                &store,
                &transition,
                AgentRuntimeTransitionAdvanceV1::SourceStopped,
            )
            .await;
            binding = manager
                .open_replacement_runtime(
                    open_request(&agent_id, Some(conversation.clone()), &next),
                    &stopped,
                    ProviderStateEnvironment::default(),
                )
                .await
                .unwrap();
            let started = advance(
                &store,
                &stopped,
                AgentRuntimeTransitionAdvanceV1::TargetStarted {
                    authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                        binding: binding.clone(),
                    }),
                    launch_idempotency_key: None,
                },
            )
            .await;
            advance(&store, &started, AgentRuntimeTransitionAdvanceV1::Committed).await;
            assert_eq!(
                binding.provider_conversation_ref.as_deref(),
                Some(conversation.as_str())
            );
            settings = next;
        }
        let bridge = bridge(&manager, &binding).await;
        let intent = turn_intent(&binding, "automatic-permission", "DURE_QA_PERMISSION");
        service.start_turn(bridge.as_ref(), &intent).await.unwrap();
        let selection = store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selection.model, settings.model);
        assert_eq!(selection.effort, settings.effort);
        assert_eq!(selection.permission_mode, settings.permission_mode);
    } else {
        let bridge = bridge(&manager, &binding).await;
        let intent = turn_intent(
            &binding,
            "after-reconnect",
            "Continue the same Dure fixture conversation.",
        );
        service.start_turn(bridge.as_ref(), &intent).await.unwrap();
        wait_completed(&service, &binding, &intent.turn_id).await;
        let page = page(&service, &binding).await;
        let users = page
            .rows
            .iter()
            .filter(|row| {
                matches!(
                    row.item.body,
                    AgentTimelineItemBodyV1::Message {
                        role: AgentTimelineMessageRoleV1::User,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(
            users, 5,
            "reattach must not duplicate or replace user messages"
        );
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
