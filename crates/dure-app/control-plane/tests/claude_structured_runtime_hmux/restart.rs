use super::*;

#[derive(Clone, Copy)]
enum Reattachment {
    /// The startup recovery of a new control plane.
    StartupRecovery,
    /// The next launch of the conversation, as input or a reader asks for it.
    Launch,
}

/// hebbianai/dure#777 on the real stack. The Claude relay removes its endpoint
/// and launch capability once the SDK Host connects, and the Host keeps its
/// Queries running after their controller exits. A restarted control plane
/// adopts that live Query instead of reading the missing endpoint as a dead
/// relay and replacing the running Claude.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn startup_recovery_reattaches_a_live_claude_after_a_control_plane_restart() {
    exercise_restart(Reattachment::StartupRecovery).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn launch_reattaches_a_live_claude_after_a_control_plane_restart() {
    exercise_restart(Reattachment::Launch).await;
}

async fn exercise_restart(mode: Reattachment) {
    let stack = ProductionClaudeStack::new("dure-claude-restart-").await;
    let service = Arc::clone(&stack.service);
    let (registry, host, manager) = stack.controller("backend-restart-1");
    let opened = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: dure_app::ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        })
        .await
        .unwrap();
    // A spawned Chat Agent has this committed selection; startup recovery
    // reattaches the runtime it selects.
    let selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        agent_id: opened.binding.agent_id.clone(),
        provider_id: ProviderIdV1::new("claude").unwrap(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: dure_app::ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: opened.binding.updated_at_ms,
    };
    stack
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let interaction = opened.binding.interaction_session_id.clone();
    let relay_session = stack.claude_sessions().remove(0);
    let mut session_guard = ExactSessionGuard(Some(relay_session.clone()));
    let api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));
    let response = api
        .dispatch(
            START_TURN_OPERATION,
            &start_turn_intent(
                &opened.binding,
                "restart-before",
                "hello before the restart",
            ),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response["receipt"]["state"], "accepted");
    wait_for_assistant(&service, &interaction, "sdk-echo:hello before the restart").await;
    wait_for_turn_idle(&service, &interaction).await;
    // Claude's session reference may be committed after open returned.
    let before_restart = service.binding(&interaction).await.unwrap().unwrap();
    let host_process_id = shared_sdk_host_process_id(&stack.host_state_root);
    assert_eq!(host.host_launch_count().unwrap(), 1);

    // The relay took its one connection: the files a not yet claimed relay
    // still holds are gone while its Claude keeps running.
    let runtime_directories = fs::read_dir(&stack.relay_state_root)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    assert_eq!(runtime_directories.len(), 1);
    assert!(!runtime_directories[0].join("relay.sock").exists());
    assert!(!runtime_directories[0].join("relay-capability").exists());
    assert_eq!(
        probe_local_process_generation(&relay_session.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );

    // The control plane exits; the SDK Host outlives its controller.
    drop(api);
    drop(manager);
    drop(host);
    drop(registry);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (registry, host, manager) = stack.controller("backend-restart-2");
    let api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));

    let reattached = match mode {
        Reattachment::StartupRecovery => manager
            .attach_existing(&selection, &before_restart)
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "startup recovery failed: {error:?}; {:?}",
                    stack.journal_failures()
                )
            }),
        Reattachment::Launch => {
            let receipt = manager
                .launch(ClaudeStructuredLaunchRequestV1 {
                    interaction_session_id: interaction.clone(),
                })
                .await
                .unwrap_or_else(|error| {
                    panic!("launch failed: {error:?}; {:?}", stack.journal_failures())
                });
            assert_eq!(receipt.runtime_generation, opened.launch.runtime_generation);
            assert_eq!(receipt.query_epoch, opened.launch.query_epoch);
            service.binding(&interaction).await.unwrap().unwrap()
        }
    };
    assert_eq!(reattached.runtime, opened.binding.runtime);
    assert_eq!(
        reattached, before_restart,
        "the reattached binding is the one the old control plane left"
    );
    assert_eq!(
        host.host_launch_count().unwrap(),
        0,
        "the restarted control plane adopts the running SDK Host"
    );
    assert_eq!(host.client_attach_count(), 1);
    assert_eq!(
        shared_sdk_host_process_id(&stack.host_state_root),
        host_process_id
    );
    assert_eq!(
        probe_local_process_generation(&relay_session.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "the restart kept the running Claude"
    );
    assert_eq!(
        stack
            .claude_sessions()
            .into_iter()
            .map(|descriptor| descriptor.session_id)
            .collect::<Vec<_>>(),
        vec![relay_session.session_id.clone()],
        "no replacement relay was started"
    );

    // The same Claude takes the next turn.
    let response = api
        .dispatch(
            START_TURN_OPERATION,
            &start_turn_intent(&reattached, "restart-after", "hello after the restart"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response["receipt"]["state"], "accepted");
    wait_for_assistant(&service, &interaction, "sdk-echo:hello after the restart").await;
    wait_for_turn_idle(&service, &interaction).await;

    assert!(
        manager
            .stop(&interaction, &opened.launch.runtime_generation)
            .await
            .unwrap()
    );
    wait_for_process_absence(&relay_session.provider_process);
    session_guard.0 = None;
}
