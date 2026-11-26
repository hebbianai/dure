use super::*;
use crate::child_result_delivery::{self, ChildResultDeliveries};
use dure_app::{
    AgentClientMessageIdV1, AgentInteractionRequestIdV1, AgentPendingRequestDraftV1,
    AgentPendingRequestKindV1, AgentProviderEventCommitV1, AgentProviderEventIdentityV1,
    AgentSpawnJournalReceiptV1, AgentSpawnParentV1, AgentTimelineItemBodyV1,
    AgentTimelineItemDraftV1, AgentTimelineItemIdV1, AgentTimelineLifecycleStateV1,
    AgentTimelineMessageRoleV1, AgentTimelineMutationV1, AgentTimelineStore, AgentTurnIdV1,
};

const PARENT_SESSION: &str = "coordinator-session";
const PARENT_WORKSPACE: &str = "coordinator-workspace";

/// Starts a native child through the public spawn path, linked to the
/// fixture's coordinator Session as its parent. The repository it runs in is
/// returned so it outlives the Run.
async fn spawn_linked_child(state: &ServiceState) -> (AgentSpawnJournalReceiptV1, TempDir) {
    let repository = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        "child-result-project".into(),
        "Child result fixture".into(),
        repository
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    )
    .unwrap();
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let preview = preview_agent_spawn(
        state,
        &authority,
        &json!({
            "schemaVersion": 1,
            "idempotencyKey": "child-result",
            "projectId": "child-result-project",
            "providerId": "codex",
            "agentName": "fix-12",
            "interactionPreference": "native_cli",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
            "parent": { "sessionId": PARENT_SESSION, "workspaceId": PARENT_WORKSPACE },
        }),
    )
    .await
    .unwrap();
    let planned: AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    let mut wire = orchestration_backend_request(state, "child-result-apply", "", Value::Null);
    wire.operation = "agent_spawn.apply".into();
    wire.expected.required_capabilities = vec!["agent_spawn.apply".into()];
    wire.body = json!({
        "schemaVersion": 1,
        "operationId": planned.operation_id,
        "planToken": planned.plan.plan_token,
        "expectedLastSequence": planned.last_sequence,
        "prompt": null,
    });
    let applied = dispatch(state, &wire).await.unwrap();
    assert_eq!(applied["receipt"]["state"], "succeeded");
    (
        serde_json::from_value(applied["receipt"].clone()).unwrap(),
        repository,
    )
}

/// What the fixture Host reports for the child's exact Session. A pending
/// attention carries the ID the Host gave that request.
fn report_child(
    state: &ServiceState,
    authority: &AgentCheckpointBindingAuthorityV1,
    lifecycle: &str,
    activity: &str,
    attention: (&str, Option<&str>),
    turns: &str,
) {
    let (attention, attention_id) = attention;
    let session = json!({
        "schema_version": 1,
        "session_id": authority.binding.session_id,
        "workspace_id": authority.runtime_workspace_id,
        "session_class": "managed",
        "lifecycle": lifecycle,
        "provider_id": "codex",
        "runner_principal": authority.runner_principal,
        "runner_instance": authority.runner_instance,
        "channel_epoch": authority.channel_epoch,
        "host_instance_id": authority.host_instance_id,
        "terminal_epoch": authority.terminal_epoch,
        "output_seq": "9",
        "health": if lifecycle == "exited" { "exited" } else { "healthy" },
        "controllerInputPending": false,
        "agentRuntimeState": {
            "terminal_epoch": authority.terminal_epoch,
            "revision": "3",
            "observed_through_output_seq": "9",
            "turn_completed_count": turns,
            "lifecycle": if lifecycle == "exited" { "exited" } else { "running" },
            "activity": activity,
            "attention": attention,
            "attention_id": attention_id,
            "background_work": false,
        },
    });
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join(format!("session-{}.json", authority.binding.session_id)),
        session.to_string(),
    )
    .unwrap();
}

async fn parent_message(state: &ServiceState, context: &Value, interaction_id: &str) -> Value {
    invoke_orchestration(
        state,
        &format!("read-{interaction_id}"),
        "interaction.get",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "interactionId": interaction_id,
            // Read as the parent's inbox does.
            "participant": context["participant"],
            "readCapability": context["deliveryCapability"],
            "endpointFence": context["endpointFence"],
        }),
    )
    .await["receipt"]
        .clone()
}

#[tokio::test]
async fn a_child_outcome_reaches_its_parent_once_as_a_durable_message() {
    let (_root, state, launcher, prompt_deliverer) = fixture_with_delivery(
        vec![LaunchOutcome::Succeed],
        vec![DeliveryOutcome::Succeed; 4],
    )
    .await;
    let (context, _) = prepare_exact_session_run(&state).await;
    let (child, _repository) = spawn_linked_child(&state).await;
    assert_eq!(launcher.requests().len(), 1);
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&child.plan.agent_id)
        .await
        .unwrap()
        .unwrap();
    let parent = AgentSpawnParentV1 {
        session_id: PARENT_SESSION.into(),
        workspace_id: PARENT_WORKSPACE.into(),
    };
    let epoch = authority.terminal_epoch.clone();
    let mut deliveries = ChildResultDeliveries::new(&state);

    // A child that is still working has nothing to report.
    report_child(&state, &authority, "ready", "working", ("none", None), "0");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert!(prompt_deliverer.requests().is_empty());

    // A finished turn opens one Message on the parent and wakes it once.
    report_child(&state, &authority, "ready", "waiting", ("none", None), "1");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let turn = child_result_delivery::interaction_id(
        &child.operation_id,
        &parent,
        &format!("turn_completed:{epoch}:1"),
    );
    let message = parent_message(&state, &context, &turn).await;
    assert_eq!(message["kind"], "message");
    assert_eq!(message["common"]["title"], "fix-12 finished a turn");
    let body = message["common"]["descriptionMarkdown"].as_str().unwrap();
    assert!(body.starts_with("Your child Run **fix-12** finished a turn"));
    assert!(body.contains(child.operation_id.as_str()));
    let wakes = prompt_deliverer.requests();
    assert_eq!(wakes.len(), 1);
    assert_eq!(wakes[0].session.session_id, PARENT_SESSION);
    assert!(wakes[0].handoff.starts_with("Dure inbox message: "));

    // The same outcome is not sent again, nor after a restart forgets it.
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    child_result_delivery::tick(&state, &mut ChildResultDeliveries::new(&state))
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 1);

    // A pending approval is its own outcome, and so is the Run's exit.
    let approval_in_turn = |attention_id: &str| {
        child_result_delivery::interaction_id(
            &child.operation_id,
            &parent,
            &format!("approval_required:{epoch}:1:{attention_id}"),
        )
    };
    report_child(
        &state,
        &authority,
        "ready",
        "working",
        ("approval_required", Some("attention-4")),
        "1",
    );
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(
        parent_message(&state, &context, &approval_in_turn("attention-4")).await["common"]["title"],
        "fix-12 needs approval"
    );
    assert_eq!(prompt_deliverer.requests().len(), 2);

    // The same pending request is not sent again.
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 2);

    // Once answered, the child works on in the same turn and asks again. The
    // new request is a new outcome even though no turn finished in between.
    report_child(&state, &authority, "ready", "working", ("none", None), "1");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    report_child(
        &state,
        &authority,
        "ready",
        "working",
        ("approval_required", Some("attention-7")),
        "1",
    );
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(
        parent_message(&state, &context, &approval_in_turn("attention-7")).await["common"]["title"],
        "fix-12 needs approval"
    );
    assert_eq!(prompt_deliverer.requests().len(), 3);
    report_child(&state, &authority, "exited", "waiting", ("none", None), "2");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let exited = child_result_delivery::interaction_id(
        &child.operation_id,
        &parent,
        &format!("exited:{epoch}"),
    );
    assert_eq!(
        parent_message(&state, &context, &exited).await["common"]["title"],
        "fix-12 exited"
    );
    assert_eq!(prompt_deliverer.requests().len(), 4);

    // An exited Run is finished; nothing more is observed or sent.
    report_child(&state, &authority, "ready", "waiting", ("none", None), "3");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 4);
}

#[tokio::test]
async fn a_child_whose_parent_exited_is_not_reported() {
    let (_root, state, _launcher, prompt_deliverer) =
        fixture_with_delivery(vec![LaunchOutcome::Succeed], Vec::new()).await;
    prepare_exact_session_run(&state).await;
    let (child, _repository) = spawn_linked_child(&state).await;
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&child.plan.agent_id)
        .await
        .unwrap()
        .unwrap();
    report_child(&state, &authority, "ready", "waiting", ("none", None), "1");
    let parent = json!({
        "schema_version": 1,
        "session_id": PARENT_SESSION,
        "workspace_id": PARENT_WORKSPACE,
        "session_class": "managed",
        "lifecycle": "exited",
        "provider_id": "codex",
        "runner_principal": "coordinator-runner",
        "runner_instance": "coordinator-instance",
        "channel_epoch": "1",
        "host_instance_id": "coordinator-host",
        "terminal_epoch": "coordinator-terminal",
        "output_seq": "4",
        "health": "exited",
    });
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join(format!("session-{PARENT_SESSION}.json")),
        parent.to_string(),
    )
    .unwrap();
    let mut deliveries = ChildResultDeliveries::new(&state);
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    // No delivery is attempted; the fixture has no wake outcome to give.
    assert!(prompt_deliverer.requests().is_empty());
}

/// Moves the child onto the chat runtime the way a committed runtime switch
/// does, and returns its new conversation.
async fn move_child_to_chat(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> AgentInteractionBindingV1 {
    let source = state
        .store
        .agent_runtime_selection(agent_id)
        .await
        .unwrap()
        .unwrap();
    let authority = state
        .store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .unwrap()
        .unwrap();
    let operation_id = OperationIdV1::new("child-to-chat").unwrap();
    let at_ms = source.updated_at_ms + 1;
    let conversation = match authority.binding.provider_conversation_id.clone() {
        Some(conversation) => dure_app::AgentProviderConversationPlanV1::resume(conversation),
        None => Ok(dure_app::AgentProviderConversationPlanV1::fresh()),
    }
    .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("child-chat").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: source.provider_id.clone(),
        execution_profile: source.execution_profile.clone(),
        provider_conversation_ref: authority.binding.provider_conversation_id.clone(),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "child-chat-runtime".into(),
            provider_epoch: "child-chat-provider".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("child-chat-timeline").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: at_ms,
        updated_at_ms: at_ms,
    };
    state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            idempotency_key: "child-to-chat-key".into(),
            source: source.clone(),
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli { authority },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: conversation,
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: source.execution_profile.clone(),
            target_launch_selection: None,
            workspace_move: None,
            requested_at_ms: at_ms,
        })
        .await
        .unwrap();
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    for (revision, advance) in [
        AgentRuntimeTransitionAdvanceV1::SourceStopped,
        AgentRuntimeTransitionAdvanceV1::TargetStarted {
            authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            }),
            launch_idempotency_key: None,
            workspace: None,
        },
        AgentRuntimeTransitionAdvanceV1::Committed,
    ]
    .into_iter()
    .enumerate()
    {
        state
            .store
            .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
                schema_version: 1,
                operation_id: operation_id.clone(),
                expected_journal_revision: i64::try_from(revision).unwrap() + 1,
                advance,
                advanced_at_ms: at_ms,
            })
            .await
            .unwrap();
    }
    binding
}

/// Writes the chat child's conversation as its provider bridge does. An
/// unannounced write reaches only the store, as if its change notice were
/// still in flight.
struct ChatConversation {
    binding: AgentInteractionBindingV1,
    sequence: i64,
}

impl ChatConversation {
    fn at_ms(&self) -> i64 {
        self.binding.created_at_ms + self.sequence
    }
}

impl ChatConversation {
    fn event(&mut self, mutations: Vec<AgentTimelineMutationV1>) -> AgentProviderEventCommitV1 {
        self.sequence += 1;
        AgentProviderEventCommitV1 {
            schema_version: 1,
            interaction_session_id: self.binding.interaction_session_id.clone(),
            event: AgentProviderEventIdentityV1 {
                runtime: self.binding.runtime.clone(),
                sequence: self.sequence,
            },
            source_fingerprint: format!("child-chat-event-{}", self.sequence),
            recorded_at_ms: self.at_ms(),
            mutations,
        }
    }

    async fn commit(&mut self, state: &ServiceState, mutations: Vec<AgentTimelineMutationV1>) {
        let event = self.event(mutations);
        state
            .agent_conversations
            .service()
            .commit_provider_event(&event)
            .await
            .unwrap();
    }

    async fn write_unannounced(
        &mut self,
        state: &ServiceState,
        mutations: Vec<AgentTimelineMutationV1>,
    ) {
        let event = self.event(mutations);
        state
            .store
            .apply_agent_provider_event(&event)
            .await
            .unwrap();
    }

    fn row(&self, id: &str, body: AgentTimelineItemBodyV1) -> AgentTimelineMutationV1 {
        AgentTimelineMutationV1::Append {
            item: AgentTimelineItemDraftV1 {
                item_id: AgentTimelineItemIdV1::new(id).unwrap(),
                turn_id: Some(AgentTurnIdV1::new("child-turn").unwrap()),
                client_message_id: Some(AgentClientMessageIdV1::new("child-message").unwrap()),
                provider_message_id: None,
                body,
                created_at_ms: self.at_ms(),
            },
        }
    }

    fn lifecycle(&self, id: &str, state: AgentTimelineLifecycleStateV1) -> AgentTimelineMutationV1 {
        let detail = (state == AgentTimelineLifecycleStateV1::TurnFailed)
            .then(|| "provider_error".to_owned());
        self.row(id, AgentTimelineItemBodyV1::Lifecycle { state, detail })
    }

    fn message(
        &self,
        id: &str,
        role: AgentTimelineMessageRoleV1,
        text: &str,
    ) -> AgentTimelineMutationV1 {
        self.row(
            id,
            AgentTimelineItemBodyV1::Message {
                role,
                markdown: text.into(),
            },
        )
    }

    fn ask(&self, id: &str, kind: AgentPendingRequestKindV1) -> AgentTimelineMutationV1 {
        AgentTimelineMutationV1::PutPending {
            request: AgentPendingRequestDraftV1 {
                request_id: AgentInteractionRequestIdV1::new(id).unwrap(),
                kind,
                turn_id: Some(AgentTurnIdV1::new("child-turn").unwrap()),
                client_message_id: AgentClientMessageIdV1::new("child-message").unwrap(),
                payload: json!({}),
                created_at_ms: self.at_ms(),
            },
        }
    }

    fn answer(&self, id: &str) -> AgentTimelineMutationV1 {
        AgentTimelineMutationV1::ResolvePending {
            request_id: AgentInteractionRequestIdV1::new(id).unwrap(),
            outcome: json!({"allowed": true}),
            resolved_at_ms: self.at_ms(),
        }
    }
}

#[tokio::test]
async fn a_chat_child_reports_each_outcome_once_after_moving_from_a_terminal() {
    let (_root, state, _launcher, prompt_deliverer) = fixture_with_delivery(
        vec![LaunchOutcome::Succeed],
        vec![DeliveryOutcome::Succeed; 6],
    )
    .await;
    let (context, _) = prepare_exact_session_run(&state).await;
    let (child, _repository) = spawn_linked_child(&state).await;
    let agent = child.plan.agent_id.clone();
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent)
        .await
        .unwrap()
        .unwrap();
    let parent = AgentSpawnParentV1 {
        session_id: PARENT_SESSION.into(),
        workspace_id: PARENT_WORKSPACE.into(),
    };
    let message = |marker: String| {
        let id = child_result_delivery::interaction_id(&child.operation_id, &parent, &marker);
        let state = &state;
        let context = &context;
        async move { parent_message(state, context, &id).await }
    };
    let mut deliveries = ChildResultDeliveries::new(&state);

    // On its terminal, the child reports through its Host.
    report_child(&state, &authority, "ready", "waiting", ("none", None), "1");
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 1);

    // Moved into Chat, its conversation is the authority. A conversation
    // that has not finished a turn reports nothing, and neither does a turn
    // that is still running.
    let binding = move_child_to_chat(&state, &agent).await;
    let session = binding.interaction_session_id.as_str().to_owned();
    let mut chat = ChatConversation {
        binding,
        sequence: 0,
    };
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    chat.commit(
        &state,
        vec![
            chat.message("user-1", AgentTimelineMessageRoleV1::User, "Fix #12"),
            chat.lifecycle("started-1", AgentTimelineLifecycleStateV1::TurnStarted),
        ],
    )
    .await;
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 1);

    // Two requests in one turn are two outcomes, each named by its request.
    chat.commit(
        &state,
        vec![chat.ask("permission-1", AgentPendingRequestKindV1::Permission)],
    )
    .await;
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let approval = message(format!("approval_required:{session}:permission-1")).await;
    assert_eq!(approval["common"]["title"], "fix-12 needs approval");
    let body = approval["common"]["descriptionMarkdown"].as_str().unwrap();
    assert!(body.contains(&format!("`dure transcript {}`", agent.as_str())));
    assert!(!body.contains("dure read"));
    chat.commit(
        &state,
        vec![
            chat.answer("permission-1"),
            chat.ask("question-2", AgentPendingRequestKindV1::Question),
        ],
    )
    .await;
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(
        message(format!("input_required:{session}:question-2")).await["common"]["title"],
        "fix-12 needs input"
    );
    assert_eq!(prompt_deliverer.requests().len(), 3);

    // The finished turn carries its answer and pull request.
    chat.commit(
        &state,
        vec![
            chat.answer("question-2"),
            chat.message(
                "answer-1",
                AgentTimelineMessageRoleV1::Assistant,
                "Fixed in https://github.com/hebbianai/dure/pull/77",
            ),
            chat.lifecycle("completed-1", AgentTimelineLifecycleStateV1::TurnCompleted),
        ],
    )
    .await;
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let finished = message(format!("turn_completed:{session}:completed-1")).await;
    assert_eq!(finished["common"]["title"], "fix-12 finished a turn");
    let body = finished["common"]["descriptionMarkdown"].as_str().unwrap();
    assert!(body.contains("Pull requests:\n- https://github.com/hebbianai/dure/pull/77\n"));
    assert!(
        body.contains("Final response:\n\n> Fixed in https://github.com/hebbianai/dure/pull/77\n")
    );
    assert_eq!(prompt_deliverer.requests().len(), 4);

    // Nothing is sent again, nor by a restarted control plane, which reads
    // each chat child once and replays what it already delivered.
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    child_result_delivery::tick(&state, &mut ChildResultDeliveries::new(&state))
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 4);

    // An idle child's conversation is not read until it changes: a failure
    // written without its change notice is not seen yet.
    chat.write_unannounced(
        &state,
        vec![
            chat.message("user-2", AgentTimelineMessageRoleV1::User, "And #13"),
            chat.lifecycle("started-2", AgentTimelineLifecycleStateV1::TurnStarted),
            chat.lifecycle("failed-2", AgentTimelineLifecycleStateV1::TurnFailed),
        ],
    )
    .await;
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 4);
    chat.commit(
        &state,
        vec![chat.row(
            "error-2",
            AgentTimelineItemBodyV1::Error {
                code: "provider_error".into(),
                message: "The provider failed".into(),
            },
        )],
    )
    .await;
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(
        message(format!("error:{session}:failed-2")).await["common"]["title"],
        "fix-12 stopped on an error"
    );
    assert_eq!(prompt_deliverer.requests().len(), 5);

    // A stop ends the Run's reports.
    let selection = state
        .store
        .agent_runtime_selection(&agent)
        .await
        .unwrap()
        .unwrap();
    let close = OperationIdV1::new("child-chat-stop").unwrap();
    state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            operation_id: close.clone(),
            idempotency_key: "child-chat-stop-key".into(),
            source: selection,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: chat.binding.clone(),
            },
            stopped_transition: None,
            requested_at_ms: chat.at_ms() + 1,
        })
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            operation_id: close.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: chat.at_ms() + 2,
        })
        .await
        .unwrap();
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    let stopped = message(format!("stopped:{}", close.as_str())).await;
    assert_eq!(stopped["common"]["title"], "fix-12 was stopped");
    assert!(
        stopped["common"]["descriptionMarkdown"]
            .as_str()
            .unwrap()
            .contains(&format!(
                "Read its conversation with `dure transcript {}`.",
                agent.as_str()
            ))
    );
    assert_eq!(prompt_deliverer.requests().len(), 6);
    child_result_delivery::tick(&state, &mut deliveries)
        .await
        .unwrap();
    assert_eq!(prompt_deliverer.requests().len(), 6);
}
