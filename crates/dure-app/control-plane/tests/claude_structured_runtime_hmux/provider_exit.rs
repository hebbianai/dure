use super::*;

/// hebbianai/dure#777 on the real stack: the shared SDK Host, the Claude
/// process relay in Hmux, and a Claude CLI that ends by itself after a turn.
/// The ended Query stops taking input, and the next launch of the same
/// conversation relaunches Claude on it instead of returning the dead one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn a_claude_process_that_ends_by_itself_relaunches_on_the_same_conversation() {
    let stack = ProductionClaudeStack::new("dure-claude-exit-").await;
    let service = Arc::clone(&stack.service);
    let (registry, _host, manager) = stack.controller("backend-provider-exit");
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
    let first = stack.claude_sessions().remove(0);
    let mut first_guard = ExactSessionGuard(Some(first.clone()));
    let api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));
    let interaction = opened.binding.interaction_session_id.clone();

    // Claude answers, then its process ends by itself.
    let response = api
        .dispatch(
            START_TURN_OPERATION,
            &start_turn_intent(&opened.binding, "provider-exit-last", "exit-after-turn"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response["receipt"]["state"], "accepted");
    wait_for_assistant(&service, &interaction, "sdk-echo:exit-after-turn").await;
    wait_for_process_absence(&first.provider_process);

    // Input meets no runtime, which is what starts a relaunch, instead of
    // failing against the exited Query.
    let deadline = Instant::now() + Duration::from_secs(10);
    let refusal = loop {
        match api
            .dispatch(
                START_TURN_OPERATION,
                &start_turn_intent(
                    &opened.binding,
                    "provider-exit-after-exit",
                    "must not reach the exited Query",
                ),
            )
            .await
            .unwrap()
        {
            Err(error) if error.code() == "agent_conversation_runtime_unavailable" => {
                break error;
            }
            outcome => {
                assert!(
                    Instant::now() < deadline,
                    "the exited Query kept taking input: {outcome:?}"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    assert_eq!(refusal.code(), "agent_conversation_runtime_unavailable");

    // The next launch relaunches Claude on the same conversation. Claude's
    // session reference may be committed after open returned, so the count
    // starts here.
    let before_relaunch = service.binding(&interaction).await.unwrap().unwrap();
    let relaunched = manager
        .launch(ClaudeStructuredLaunchRequestV1 {
            interaction_session_id: interaction.clone(),
        })
        .await
        .unwrap_or_else(|error| {
            panic!("relaunch failed: {error:?}; {:?}", stack.journal_failures())
        });
    assert_ne!(
        relaunched.runtime_generation,
        opened.launch.runtime_generation
    );
    let current = service.binding(&interaction).await.unwrap().unwrap();
    assert_eq!(
        current.runtime.runtime_generation,
        relaunched.runtime_generation
    );
    assert_eq!(
        current.binding_revision,
        before_relaunch.binding_revision + 1,
        "the relaunch replaced the runtime once"
    );
    assert!(current.provider_conversation_ref.is_some());
    let second = stack
        .claude_sessions()
        .into_iter()
        .find(|descriptor| descriptor.session_id != first.session_id)
        .expect("the relaunch started a new Claude relay");
    first_guard.0 = None;
    let mut second_guard = ExactSessionGuard(Some(second.clone()));

    let response = api
        .dispatch(
            START_TURN_OPERATION,
            &start_turn_intent(
                &current,
                "provider-exit-relaunched",
                "hello after the relaunch",
            ),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response["receipt"]["state"], "accepted");
    wait_for_assistant(&service, &interaction, "sdk-echo:hello after the relaunch").await;
    wait_for_turn_idle(&service, &interaction).await;

    assert!(
        manager
            .stop(&interaction, &relaunched.runtime_generation)
            .await
            .unwrap()
    );
    wait_for_process_absence(&second.provider_process);
    second_guard.0 = None;
}
