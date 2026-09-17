use super::*;

mod publication_observation_tests;
mod recorded_rehost_fixture;
mod resume_publication_failure_tests;

use recorded_rehost_fixture::record_completion;

fn runtime_transition_target_authority(
    agent_id: &AgentIdV1,
    session: &WorkflowSessionGenerationV1,
    binding_generation: i64,
    credential_reference_id: &str,
    updated_at_ms: i64,
) -> AgentCheckpointBindingAuthorityV1 {
    AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: session.session_id.clone(),
            provider_conversation_id: None,
            credential_reference_id: Some(credential_reference_id.into()),
            binding_generation,
            bound_at_ms: updated_at_ms,
        },
        runtime_workspace_id: session.workspace_id.clone(),
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch: session.channel_epoch.clone(),
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
        updated_at_ms,
    }
}

fn write_hmux_rehost_evidence(
    root: &TempDir,
    source: &WorkflowSessionGenerationV1,
    target: &WorkflowSessionGenerationV1,
    operation_id: &str,
) {
    let discovery_root = root.path().join("discovery");
    fs::write(
        discovery_root.join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        discovery_root.join("rehost-resolution.json"),
        serde_json::to_vec(&json!({
            "schema": "hmux-managed-rehost-resolution-v1",
            "schemaVersion": 1,
            "state": "resolved",
            "operationIds": [operation_id],
            "sourceGeneration": source,
            "currentGeneration": target,
            "providerId": target.provider_id,
            "permissionMode": "default",
        }))
        .unwrap(),
    )
    .unwrap();
}

fn write_ready_hmux_session(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
    conversation_id: &str,
) {
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": session.session_id,
            "workspace_id": session.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": session.provider_id,
            "runner_principal": session.runner_principal,
            "runner_instance": session.runner_instance,
            "channel_epoch": session.channel_epoch,
            "host_instance_id": session.host_instance_id,
            "terminal_epoch": session.terminal_epoch,
            "output_seq": "0",
            "health": "healthy",
            "agentRuntimeState": null,
            "providerConversationIdentity": {
                "session_id": session.session_id,
                "workspace_id": session.workspace_id,
                "runner_principal": session.runner_principal,
                "runner_instance": session.runner_instance,
                "channel_epoch": session.channel_epoch,
                "host_instance_id": session.host_instance_id,
                "terminal_epoch": session.terminal_epoch,
                "provider_id": session.provider_id,
                "conversation_id": conversation_id,
            },
        }))
        .unwrap(),
    )
    .unwrap();
}

#[derive(Clone, Copy)]
struct NativeTransitionFixture<'a> {
    operation: &'a str,
    target_workspace_id: &'a str,
    target_credential_reference_id: &'a str,
    binding_generation: i64,
    requested_at_ms: i64,
}

async fn start_native_runtime_transition(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    source_authority: &AgentCheckpointBindingAuthorityV1,
    fixture: NativeTransitionFixture<'_>,
) -> (
    AgentRuntimeTransitionRecordV1,
    AgentCheckpointBindingAuthorityV1,
    WorkflowSessionGenerationV1,
) {
    let NativeTransitionFixture {
        operation,
        target_workspace_id,
        target_credential_reference_id,
        binding_generation,
        requested_at_ms,
    } = fixture;
    let operation_id = OperationIdV1::new(operation).unwrap();
    let launch_identity = dure_app::agent_runtime_native_launch_identity_v1(&operation_id);
    let target_session = WorkflowSessionGenerationV1 {
        session_id: launch_identity.session_id,
        workspace_id: target_workspace_id.into(),
        provider_id: source.provider_id.clone(),
        runner_principal: "transition-runner".into(),
        runner_instance: format!("transition-instance-{binding_generation}"),
        channel_epoch: binding_generation.to_string(),
        host_instance_id: format!("transition-host-{binding_generation}"),
        terminal_epoch: format!("transition-terminal-{binding_generation}"),
    };
    let target_authority = runtime_transition_target_authority(
        &source.agent_id,
        &target_session,
        binding_generation,
        target_credential_reference_id,
        requested_at_ms + 2,
    );
    let target_execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: target_credential_reference_id.into(),
        credential_generation: Some(format!("{target_credential_reference_id}-generation")),
    };
    let admitted = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            idempotency_key: format!("{operation}-key"),
            source: source.clone(),
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::fresh(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile,
            target_launch_selection: None,
            requested_at_ms,
        })
        .await
        .unwrap();
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: requested_at_ms + 1,
        })
        .await
        .unwrap();
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&target_authority)
        .await
        .unwrap();
    let started = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: Some(launch_identity.launch_idempotency_key),
                authority: Box::new(AgentRuntimeBindingAuthorityV1::NativeCli {
                    authority: target_authority.clone(),
                }),
            },
            advanced_at_ms: requested_at_ms + 2,
        })
        .await
        .unwrap();
    (started, target_authority, target_session)
}

async fn commit_native_runtime_transition(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    source_authority: &AgentCheckpointBindingAuthorityV1,
    fixture: NativeTransitionFixture<'_>,
) -> (
    AgentRuntimeSelectionV1,
    AgentCheckpointBindingAuthorityV1,
    WorkflowSessionGenerationV1,
) {
    let (started, target_authority, target_session) =
        start_native_runtime_transition(state, source, source_authority, fixture).await;
    let committed = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: started.intent.operation_id.clone(),
            expected_journal_revision: started.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::Committed,
            advanced_at_ms: fixture.requested_at_ms + 3,
        })
        .await
        .unwrap();
    (
        committed
            .intent
            .target_selection_at(committed.updated_at_ms)
            .unwrap(),
        target_authority,
        target_session,
    )
}

fn native_rehost_request(state: &ServiceState, body: Value) -> BackendRequest {
    BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: "runtime-native-rehost-request-1".into(),
        operation: "agent_runtime.native_rehost.reconcile".into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            // The behavioral RED must reach the unsupported operation on the
            // pre-fix control plane. Capability advertisement is asserted by
            // the build-identity contract once the operation exists.
            required_capabilities: Vec::new(),
        },
        body,
        connection: None,
    }
}

fn native_resume_request(state: &ServiceState, body: Value) -> BackendRequest {
    BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: "runtime-native-resume-request-1".into(),
        operation: "agent_runtime.native_resume.publish".into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities: Vec::new(),
        },
        body,
        connection: None,
    }
}

fn generation_json(
    session_id: &str,
    runner_principal: &str,
    runner_instance: &str,
    channel_epoch: &str,
    host_instance_id: &str,
    terminal_epoch: &str,
) -> Value {
    json!({
        "sessionId": session_id,
        "workspaceId": "coordinator-workspace",
        "runnerPrincipal": runner_principal,
        "runnerInstance": runner_instance,
        "channelEpoch": channel_epoch,
        "hostInstanceId": host_instance_id,
        "terminalEpoch": terminal_epoch,
    })
}

fn rejected_state_body(agent_id: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "operationId": format!("native-rehost-{agent_id}"),
        "providerId": "codex",
        "targetCredential": { "kind": "provider_default" },
        "source": generation_json(
            "source-session",
            "source-runner",
            "source-instance",
            "1",
            "source-host",
            "source-terminal",
        ),
        "target": generation_json(
            "target-session",
            "target-runner",
            "target-instance",
            "2",
            "target-host",
            "target-terminal",
        ),
    })
}

async fn initialize_structured_agent(
    state: &ServiceState,
    agent_id: &str,
) -> (AgentRuntimeSelectionV1, AgentInteractionBindingV1) {
    let agent_id = AgentIdV1::new(agent_id).unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Rejected native rehost state".into(),
            created_at_ms: 1,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let identity_suffix = agent_id.as_str().to_string();
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new(format!(
            "interaction-{}",
            agent_id.as_str()
        ))
        .unwrap(),
        agent_id,
        provider_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some(format!("conversation-{identity_suffix}")),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: format!("runtime-{identity_suffix}"),
            provider_epoch: format!("provider-{identity_suffix}"),
        },
        timeline_epoch: AgentTimelineEpochV1::new(format!("timeline-{identity_suffix}")).unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    (selection, binding)
}

async fn stop_native_runtime(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    operation: &str,
) -> (AgentRuntimeSelectionV1, OperationIdV1) {
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let source_authority = state
        .store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .unwrap()
        .unwrap();
    let close_operation = OperationIdV1::new(operation).unwrap();
    let admitted = state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: close_operation.clone(),
            idempotency_key: operation.into(),
            source: source.clone(),
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority,
            },
            stopped_transition: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: close_operation.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 30,
        })
        .await
        .unwrap();
    (source, close_operation)
}

async fn assert_rehost_state_rejected(state: &ServiceState, agent_id: &str) {
    let error = dispatch(
        state,
        &native_rehost_request(state, rejected_state_body(agent_id)),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "agent_runtime_native_rehost_conflict");
}

#[tokio::test]
async fn native_rehost_rejects_unmanaged_structured_transitioning_and_closed_states() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    assert_rehost_state_rejected(&state, "coordinator-1").await;

    initialize_structured_agent(&state, "structured-rehost-agent").await;
    assert_rehost_state_rejected(&state, "structured-rehost-agent").await;

    let (transitioning, transitioning_binding) =
        initialize_structured_agent(&state, "transitioning-rehost-agent").await;
    state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("other-runtime-transition").unwrap(),
            idempotency_key: "other-runtime-transition-key".into(),
            source: transitioning,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: transitioning_binding,
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-transitioning-rehost-agent",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "other-account".into(),
                credential_generation: Some("other-generation".into()),
            },
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    assert_rehost_state_rejected(&state, "transitioning-rehost-agent").await;

    let (closed, closed_binding) = initialize_structured_agent(&state, "closed-rehost-agent").await;
    state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("other-runtime-close").unwrap(),
            idempotency_key: "other-runtime-close-key".into(),
            source: closed,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: closed_binding,
            },
            stopped_transition: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    assert_rehost_state_rejected(&state, "closed-rehost-agent").await;
}

#[tokio::test]
async fn native_resume_publishes_a_ready_target_without_retiring_repair_authority() {
    let agent_id = AgentIdV1::new("native-resume-repair-agent").unwrap();
    let (_root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            conversation_id: Some("conversation-1".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let source_selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source_selection)
        .await
        .unwrap();
    let source_authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let failed_binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new(
            "interaction-native-resume-repair",
        )
        .unwrap(),
        agent_id: agent_id.clone(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-1".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-native-resume-repair".into(),
            provider_epoch: "provider-native-resume-repair".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-native-resume-repair").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 20,
        updated_at_ms: 20,
    };
    state
        .store
        .create_agent_interaction(&failed_binding)
        .await
        .unwrap();
    let failed_operation = OperationIdV1::new("failed-native-resume-transition").unwrap();
    let admitted = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: failed_operation.clone(),
            idempotency_key: "failed-native-resume-transition-key".into(),
            source: source_selection,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority,
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-1",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: failed_operation.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 30,
        })
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: failed_operation.clone(),
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "structured_runtime_launch_failed",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                    authority: Some(Box::new(AgentRuntimeReplacementAuthorityV1(
                        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                            binding: failed_binding.clone(),
                        },
                    ))),
                },
            },
            advanced_at_ms: 40,
        })
        .await
        .unwrap();

    write_ready_hmux_session(
        &state,
        &WorkflowSessionGenerationV1 {
            session_id: "native-resume-target".into(),
            workspace_id: "coordinator-workspace".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: "resume-runner".into(),
            runner_instance: "resume-instance".into(),
            channel_epoch: "2".into(),
            host_instance_id: "resume-host".into(),
            terminal_epoch: "resume-terminal".into(),
        },
        "conversation-1",
    );
    let response = dispatch(
        &state,
        &native_resume_request(
            &state,
            json!({
                "schemaVersion": 1,
                "agentId": agent_id,
                "operationId": "managed-resume-create-1",
                "providerId": "codex",
                "targetCredential": { "kind": "provider_default" },
                "providerConversationRef": "conversation-1",
                "permissionMode": "default",
                "launchIdempotencyKey": "managed-resume-create-1",
                "target": generation_json(
                    "native-resume-target",
                    "resume-runner",
                    "resume-instance",
                    "2",
                    "resume-host",
                    "resume-terminal",
                ),
            }),
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        response["receipt"]["authority"]["authority"]["binding"]["sessionId"],
        "native-resume-target",
    );
    assert_eq!(
        response["receipt"]["providerConversationRef"],
        "conversation-1"
    );
    let selected = state
        .store
        .agent_runtime_selection(&AgentIdV1::new("native-resume-repair-agent").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.revision, 2);
    assert_eq!(
        selected.interaction_profile,
        AgentInteractionProfileV1::NativeCli
    );
    let superseded = state
        .store
        .agent_runtime_transition(&failed_operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(superseded.state, AgentRuntimeTransitionStateV1::Superseded);
    assert_eq!(
        superseded.replacement_authority,
        Some(AgentRuntimeReplacementAuthorityV1(
            AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: failed_binding,
            },
        )),
    );
}

#[tokio::test]
async fn native_resume_reopens_a_terminally_stopped_native_runtime() {
    let agent_id = AgentIdV1::new("native-resume-closed-agent").unwrap();
    let (_root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            conversation_id: Some("conversation-closed".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let (_, close_operation) =
        stop_native_runtime(&state, &agent_id, "native-resume-closed-stop").await;

    write_ready_hmux_session(
        &state,
        &WorkflowSessionGenerationV1 {
            session_id: "native-resume-after-close".into(),
            workspace_id: "coordinator-workspace".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: "resume-runner".into(),
            runner_instance: "resume-instance".into(),
            channel_epoch: "2".into(),
            host_instance_id: "resume-host".into(),
            terminal_epoch: "resume-terminal".into(),
        },
        "conversation-closed",
    );

    let response = dispatch(
        &state,
        &native_resume_request(
            &state,
            json!({
                "schemaVersion": 1,
                "agentId": agent_id,
                "operationId": "native-resume-after-close",
                "providerId": "codex",
                "targetCredential": { "kind": "provider_default" },
                "providerConversationRef": "conversation-closed",
                "permissionMode": "default",
                "launchIdempotencyKey": "native-resume-after-close",
                "target": generation_json(
                    "native-resume-after-close",
                    "resume-runner",
                    "resume-instance",
                    "2",
                    "resume-host",
                    "resume-terminal",
                ),
            }),
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        response["receipt"]["authority"]["authority"]["binding"]["sessionId"],
        "native-resume-after-close",
    );
    assert!(
        state
            .store
            .effective_agent_runtime_close(&AgentIdV1::new("native-resume-closed-agent").unwrap())
            .await
            .unwrap()
            .is_none(),
    );
    let historical_close = state
        .store
        .agent_runtime_close(&close_operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(historical_close.state, AgentRuntimeCloseStateV1::Stopped);
}

#[tokio::test]
async fn credential_transition_restarts_a_terminally_stopped_native_source() {
    let agent_id = AgentIdV1::new("native-transition-closed-agent").unwrap();
    let (root, state, launcher, _, _) = fixture_with_source_launch_authority(
        vec![LaunchOutcome::Succeed],
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            conversation_id: Some("conversation-transition-closed".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let (_, close_operation) =
        stop_native_runtime(&state, &agent_id, "native-transition-closed-stop").await;
    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("codex-account-b");
    fs::create_dir(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let credential = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "codex".into(),
                reference_id: "account-b".into(),
                profile_directory_name: "codex-account-b".into(),
            },
        )
        .await
        .unwrap();
    let (transition_operation, _) = agent_runtime_transition_apply::runtime_transition_identity(
        "native-transition-after-close",
    )
    .unwrap();
    let target_identity = dure_app::agent_runtime_native_launch_identity_v1(&transition_operation);
    write_ready_hmux_session(
        &state,
        &WorkflowSessionGenerationV1 {
            session_id: target_identity.session_id,
            workspace_id: "workspace-1".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: "worker-runner".into(),
            runner_instance: "worker-instance".into(),
            channel_epoch: "2".into(),
            host_instance_id: "worker-host".into(),
            terminal_epoch: "worker-terminal".into(),
        },
        "conversation-transition-closed",
    );

    agent_runtime_transition_apply::apply(
        &state,
        "native-transition-after-close",
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            expected_source_revision: None,
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            target_execution_profile: Some(AgentExecutionProfileV1::CredentialReference {
                reference_id: "account-b".into(),
                credential_generation: Some(credential.credential_generation),
            }),
            target_launch_selection: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        2,
    );
    assert_eq!(launcher.requests().len(), 1);
    assert!(
        state
            .store
            .effective_agent_runtime_close(&agent_id)
            .await
            .unwrap()
            .is_none(),
    );
    assert_eq!(
        state
            .store
            .agent_runtime_close(&close_operation)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeCloseStateV1::Stopped,
    );
}

#[tokio::test]
async fn native_runtime_transition_commit_atomically_moves_the_hidden_reporting_dispatch() {
    let agent_id = AgentIdV1::new("native-transition-dispatch-agent").unwrap();
    let (root, state, launcher, prompt_deliverer, _activity_observer) =
        fixture_with_source_launch_authority(
            vec![LaunchOutcome::Succeed],
            vec![DeliveryOutcome::Succeed],
            vec![ActivityOutcome::Observed("9")],
            HmuxPermissionMode::Default,
            "coordinator-terminal",
            SourceLaunchAuthorityFixture {
                agent_id: agent_id.clone(),
                agent_provider_id: ProviderIdV1::new("codex").unwrap(),
                ..SourceLaunchAuthorityFixture::default()
            },
        )
        .await;
    let source_authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let source = state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let created = invoke_orchestration(
        &state,
        "native-transition-hidden-dispatch-create",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let target: InteractionTarget =
        serde_json::from_value(created["receipt"]["context"]["target"].clone()).unwrap();
    let source_session = WorkflowSessionGenerationV1::from_checkpoint_authority(
        &source_authority,
        &source.provider_id,
    );
    let parent_agent = AgentIdV1::new("native-transition-parent-agent").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: parent_agent.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Parent-owned PTY".into(),
            created_at_ms: 11,
            updated_at_ms: 11,
        })
        .await
        .unwrap();
    let parent_session = WorkflowSessionGenerationV1 {
        session_id: "native-transition-parent-session".into(),
        workspace_id: source_session.workspace_id.clone(),
        provider_id: source_session.provider_id.clone(),
        runner_principal: "native-transition-parent-runner".into(),
        runner_instance: "native-transition-parent-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "native-transition-parent-host".into(),
        terminal_epoch: "native-transition-parent-terminal".into(),
    };
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&runtime_transition_target_authority(
            &parent_agent,
            &parent_session,
            1,
            "parent-account",
            11,
        ))
        .await
        .unwrap();
    let mut parent_request = request();
    parent_request.coordinator.agent_id = agent_id.clone();
    parent_request.coordinator.session_id = source_session.session_id.clone();
    parent_request.idempotency_key = "native-transition-parent-pty".into();
    let parent_pty = receipt(&delegate_once(&state, parent_request).await.unwrap());
    let co_located_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE workflow_dispatch_launches
        SET session_id = ?1,
            workspace_id = ?2,
            provider_id = ?3,
            runner_principal = ?4,
            runner_instance = ?5,
            channel_epoch = ?6,
            host_instance_id = ?7,
            terminal_epoch = ?8
        WHERE dispatch_id = ?9
        "#,
    )
    .bind(&source_session.session_id)
    .bind(&source_session.workspace_id)
    .bind(source_session.provider_id.as_str())
    .bind(&source_session.runner_principal)
    .bind(&source_session.runner_instance)
    .bind(&source_session.channel_epoch)
    .bind(&source_session.host_instance_id)
    .bind(&source_session.terminal_epoch)
    .bind(parent_pty.dispatch_id.as_str())
    .execute(&co_located_pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        UPDATE workflow_runs
        SET coordinator_agent_id = ?1,
            coordinator_session_id = ?2,
            coordinator_binding_generation = 1
        WHERE run_id = (
            SELECT task.run_id
            FROM workflow_dispatches AS dispatch
            JOIN workflow_tasks AS task ON task.task_id = dispatch.task_id
            WHERE dispatch.dispatch_id = ?3
        )
        "#,
    )
    .bind(parent_agent.as_str())
    .bind(&parent_session.session_id)
    .bind(parent_pty.dispatch_id.as_str())
    .execute(&co_located_pool)
    .await
    .unwrap();
    co_located_pool.close().await;

    let (started, target_authority, target_session) = start_native_runtime_transition(
        &state,
        &source,
        &source_authority,
        NativeTransitionFixture {
            operation: "native-transition-dispatch-1",
            target_workspace_id: "agent-workspace:native-transition-dispatch-agent",
            target_credential_reference_id: "account-b",
            binding_generation: 2,
            requested_at_ms: 20,
        },
    )
    .await;
    state
        .store
        .converge_agent_checkpoint_provider_conversation(
            &target_authority,
            "native-transition-dispatch-conversation",
        )
        .await
        .unwrap();

    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_runtime_transition_dispatch_rebind
        BEFORE UPDATE OF session_id ON workflow_dispatch_launches
        WHEN OLD.session_id = 'coordinator-session'
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected runtime transition Dispatch rebind');
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let commit_request = AgentRuntimeTransitionAdvanceRequestV1 {
        schema_version: 1,
        operation_id: started.intent.operation_id.clone(),
        expected_journal_revision: started.journal_revision,
        advance: AgentRuntimeTransitionAdvanceV1::Committed,
        advanced_at_ms: 23,
    };
    assert!(
        state
            .store
            .advance_agent_runtime_transition(&commit_request)
            .await
            .is_err()
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&source.agent_id)
            .await
            .unwrap(),
        Some(source.clone())
    );
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&started.intent.operation_id)
            .await
            .unwrap(),
        Some(started.clone())
    );
    assert_eq!(
        state
            .store
            .orchestration_session_for_dispatch_target(
                &TaskIdV1::new(target.task_id.as_str()).unwrap(),
                &DispatchIdV1::new(target.dispatch_id.as_str()).unwrap(),
                i64::try_from(target.generation.get()).unwrap(),
            )
            .await
            .unwrap(),
        source_session
    );
    sqlx::query("DROP TRIGGER fail_runtime_transition_dispatch_rebind")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;
    state
        .store
        .advance_agent_runtime_transition(&commit_request)
        .await
        .unwrap();

    assert_eq!(
        state
            .store
            .orchestration_target_for_exact_session(&target_session)
            .await
            .unwrap(),
        target
    );
    let exact = OrchestrationDispatchGenerationV1 {
        task_id: TaskIdV1::new(target.task_id.as_str()).unwrap(),
        dispatch_id: DispatchIdV1::new(target.dispatch_id.as_str()).unwrap(),
        generation: i64::try_from(target.generation.get()).unwrap(),
    };
    let wrong_owner = AgentIdV1::new("native-transition-wrong-owner").unwrap();
    let owner_error = state
        .store
        .reconcile_orchestration_dispatch_runtime_transition(
            &wrong_owner,
            &exact,
            &source_session,
            &target_session,
            24,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        owner_error,
        dure_app::DomainStoreErrorV1::IdentityConflict { .. }
    ));
    let replay = state
        .store
        .reconcile_orchestration_dispatch_runtime_transition(
            &source.agent_id,
            &exact,
            &source_session,
            &target_session,
            24,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.target, target_session);
    assert_eq!(
        state
            .store
            .orchestration_session_for_dispatch_target(
                &parent_pty.task_id,
                &parent_pty.dispatch_id,
                parent_pty.generation,
            )
            .await
            .unwrap(),
        source_session
    );
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(prompt_deliverer.requests().len(), 1);
}

#[tokio::test]
async fn committed_native_runtime_transition_chain_recovers_when_hmux_forgets_rehost() {
    let agent_id = AgentIdV1::new("native-transition-chain-agent").unwrap();
    let (root, state, launcher, prompt_deliverer, _activity_observer) =
        fixture_with_source_launch_authority(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            HmuxPermissionMode::Default,
            "coordinator-terminal",
            SourceLaunchAuthorityFixture {
                agent_id: agent_id.clone(),
                agent_provider_id: ProviderIdV1::new("codex").unwrap(),
                ..SourceLaunchAuthorityFixture::default()
            },
        )
        .await;
    let source_session: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    let source_authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let source = state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id,
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let created = invoke_orchestration(
        &state,
        "native-transition-chain-dispatch-create",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let context = created["receipt"]["context"].clone();
    let completed = invoke_orchestration(
        &state,
        "native-transition-chain-dispatch-complete",
        "dispatch.complete",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "native-transition-chain-dispatch-complete",
            "messageId": "native-transition-chain-completion",
            "target": context["target"],
            "expectedDispatchRevision": 1,
            "completedBy": context["participant"],
            "endpointFence": context["endpointFence"],
            "audience": { "grants": [context["coordinatorGrant"].clone()] },
            "completionCapability": context["completionCapability"],
            "title": "Transition chain reporting complete",
            "resultMarkdown": "The original reporting cycle completed before both transitions.",
            "completedAtMs": 15
        }),
    )
    .await;
    assert_eq!(completed["receipt"]["dispatchState"], "completed");
    invoke_orchestration(
        &state,
        "native-transition-chain-events-observe",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "target": context["target"],
            "participant": context["coordinatorGrant"]["participant"],
            "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 128
        }),
    )
    .await;
    let (intermediate, intermediate_authority, intermediate_session) =
        commit_native_runtime_transition(
            &state,
            &source,
            &source_authority,
            NativeTransitionFixture {
                operation: "native-transition-chain-1",
                target_workspace_id: "agent-workspace:native-transition-chain-agent",
                target_credential_reference_id: "account-b",
                binding_generation: 2,
                requested_at_ms: 20,
            },
        )
        .await;
    let (_selected, target_authority, target_session) = commit_native_runtime_transition(
        &state,
        &intermediate,
        &intermediate_authority,
        NativeTransitionFixture {
            operation: "native-transition-chain-2",
            target_workspace_id: &intermediate_session.workspace_id,
            target_credential_reference_id: "account-c",
            binding_generation: 3,
            requested_at_ms: 30,
        },
    )
    .await;
    let converged_authority = state
        .store
        .converge_agent_checkpoint_provider_conversation(
            &target_authority,
            "native-transition-chain-conversation",
        )
        .await
        .unwrap();
    assert_eq!(
        converged_authority
            .binding
            .provider_conversation_id
            .as_deref(),
        Some("native-transition-chain-conversation")
    );
    let other_runtime_agent = AgentIdV1::new("native-transition-other-runtime-agent").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: other_runtime_agent.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Same generation in another runtime".into(),
            created_at_ms: 35,
            updated_at_ms: 35,
        })
        .await
        .unwrap();
    let mut other_runtime_authority = converged_authority.clone();
    other_runtime_authority.binding.agent_id = other_runtime_agent;
    other_runtime_authority.binding.runtime_kind_id =
        RuntimeKindIdV1::new("runtime.other").unwrap();
    other_runtime_authority.binding.binding_generation = 1;
    other_runtime_authority.binding.bound_at_ms = 35;
    other_runtime_authority.updated_at_ms = 35;
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&other_runtime_authority)
        .await
        .unwrap();

    // A fully observed completed reporting Dispatch is intentionally absent
    // from the forward transition scan, reproducing the pre-fix durable state:
    // runtime selection is current while reporting remains on the source.
    fs::write(
        root.path().join("discovery/current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target_session.session_id,
            "workspace_id": target_session.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target_session.provider_id,
            "runner_principal": target_session.runner_principal,
            "runner_instance": target_session.runner_instance,
            "channel_epoch": target_session.channel_epoch,
            "host_instance_id": target_session.host_instance_id,
            "terminal_epoch": target_session.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.path().join("discovery/rehost-resolution.json"),
        serde_json::to_vec(&json!({ "state": "not_found" })).unwrap(),
    )
    .unwrap();

    let reconcile_body = json!({
        "schemaVersion": 1,
        "expected": {
            "taskId": context["target"]["taskId"],
            "dispatchId": context["target"]["dispatchId"],
            "generation": context["target"]["generation"],
        },
        "target": target_session,
        "reconciledAtMs": 50,
    });
    let fence_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE workflow_dispatches SET runtime_kind_id = 'runtime.other'")
        .execute(&fence_pool)
        .await
        .unwrap();
    let runtime_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "native-transition-chain-runtime-kind-fence",
            "dispatch.session.reconcile-rehost",
            reconcile_body.clone(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(runtime_error.code, "orchestration_generation_conflict");
    sqlx::query("UPDATE workflow_dispatches SET runtime_kind_id = 'runtime.hmux'")
        .execute(&fence_pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_runs SET coordinator_binding_generation = 4")
        .execute(&fence_pool)
        .await
        .unwrap();
    let authority_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "native-transition-chain-run-authority-fence",
            "dispatch.session.reconcile-rehost",
            reconcile_body.clone(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(authority_error.code, "orchestration_generation_conflict");
    sqlx::query("UPDATE workflow_runs SET coordinator_binding_generation = 1")
        .execute(&fence_pool)
        .await
        .unwrap();
    fence_pool.close().await;

    let reconciled = invoke_orchestration(
        &state,
        "native-transition-chain-reconcile",
        "dispatch.session.reconcile-rehost",
        reconcile_body,
    )
    .await;
    assert_eq!(reconciled["receipt"]["outcome"], "rebound");
    assert_eq!(reconciled["receipt"]["target"], json!(target_session));
    let replay = invoke_orchestration(
        &state,
        "native-transition-chain-reconcile-replay",
        "dispatch.session.reconcile-rehost",
        json!({
            "schemaVersion": 1,
            "expected": {
                "taskId": context["target"]["taskId"],
                "dispatchId": context["target"]["dispatchId"],
                "generation": context["target"]["generation"],
            },
            "target": target_session,
            "reconciledAtMs": 50,
        }),
    )
    .await;
    assert_eq!(replay["receipt"]["outcome"], "current");
    let rebound = invoke_orchestration(
        &state,
        "native-transition-chain-context",
        "dispatch.context.get",
        json!({ "schemaVersion": 1, "session": target_session }),
    )
    .await;
    assert_eq!(rebound["receipt"]["target"], context["target"]);
    assert!(launcher.requests().is_empty());
    assert!(prompt_deliverer.requests().is_empty());
    let read_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_runs")
        .fetch_one(&read_pool)
        .await
        .unwrap();
    assert_eq!(run_count, 1);
    read_pool.close().await;
    assert_ne!(intermediate_session, source_session);
}

#[tokio::test]
async fn stale_hmux_proof_cannot_move_reporting_behind_current_agent_authority() {
    for scenario in 0..3 {
        let agent_id = AgentIdV1::new(match scenario {
            0 => "stale-reporting-newer-agent",
            1 => "stale-reporting-structured-agent",
            _ => "stale-reporting-credential-agent",
        })
        .unwrap();
        let (root, state, _, _, _) = fixture_with_source_launch_authority(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            HmuxPermissionMode::Default,
            "coordinator-terminal",
            SourceLaunchAuthorityFixture {
                agent_id: agent_id.clone(),
                agent_provider_id: ProviderIdV1::new("codex").unwrap(),
                ..SourceLaunchAuthorityFixture::default()
            },
        )
        .await;
        let created = invoke_orchestration(
            &state,
            "stale-reporting-dispatch-create",
            "run.create",
            existing_session_run_body(),
        )
        .await;
        let dispatch_target: InteractionTarget =
            serde_json::from_value(created["receipt"]["context"]["target"].clone()).unwrap();
        let source: WorkflowSessionGenerationV1 =
            serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
        let target = WorkflowSessionGenerationV1 {
            session_id: "stale-reporting-target".into(),
            workspace_id: source.workspace_id.clone(),
            provider_id: source.provider_id.clone(),
            runner_principal: source.runner_principal.clone(),
            runner_instance: "stale-reporting-target-instance".into(),
            channel_epoch: "2".into(),
            host_instance_id: "stale-reporting-target-host".into(),
            terminal_epoch: "stale-reporting-target-terminal".into(),
        };
        write_hmux_rehost_evidence(&root, &source, &target, "stale-reporting-hmux-proof");
        let stale_operation_id = exact_hmux_rehost_operation_id(&state, &source, &target, None)
            .await
            .unwrap();

        let current = if scenario == 0 {
            WorkflowSessionGenerationV1 {
                session_id: "newer-reporting-target".into(),
                workspace_id: source.workspace_id.clone(),
                provider_id: source.provider_id.clone(),
                runner_principal: source.runner_principal.clone(),
                runner_instance: "newer-reporting-target-instance".into(),
                channel_epoch: "3".into(),
                host_instance_id: "newer-reporting-target-host".into(),
                terminal_epoch: "newer-reporting-target-terminal".into(),
            }
        } else {
            target.clone()
        };
        state
            .store
            .upsert_agent_checkpoint_binding_authority(&runtime_transition_target_authority(
                &agent_id,
                &current,
                2,
                "stale-reporting-account",
                20,
            ))
            .await
            .unwrap();
        if scenario != 0 {
            state
                .store
                .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
                    schema_version: 1,
                    agent_id: agent_id.clone(),
                    provider_id: ProviderIdV1::new("codex").unwrap(),
                    interaction_profile: if scenario == 1 {
                        AgentInteractionProfileV1::StructuredProtocol
                    } else {
                        AgentInteractionProfileV1::NativeCli
                    },
                    execution_profile: AgentExecutionProfileV1::ProviderDefault,
                    permission_mode: ProviderPermissionModeV1::Default,
                    model: None,
                    effort: None,
                    revision: 1,
                    selected_by_operation_id: None,
                    updated_at_ms: 20,
                })
                .await
                .unwrap();
        }
        let error = state
            .store
            .reconcile_orchestration_dispatch_session(
                Some(&agent_id),
                &RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                &OrchestrationDispatchSessionRebindRequestV1 {
                    schema_version: 1,
                    operation_id: stale_operation_id,
                    source: source.clone(),
                    target: target.clone(),
                    rebound_at_ms: 30,
                },
                &OrchestrationDispatchGenerationV1 {
                    task_id: TaskIdV1::new(dispatch_target.task_id.as_str()).unwrap(),
                    dispatch_id: DispatchIdV1::new(dispatch_target.dispatch_id.as_str()).unwrap(),
                    generation: i64::try_from(dispatch_target.generation.get()).unwrap(),
                },
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            dure_app::DomainStoreErrorV1::IdentityConflict { .. }
        ));
        assert_eq!(
            state
                .store
                .orchestration_session_for_dispatch_target(
                    &TaskIdV1::new(dispatch_target.task_id.as_str()).unwrap(),
                    &DispatchIdV1::new(dispatch_target.dispatch_id.as_str()).unwrap(),
                    i64::try_from(dispatch_target.generation.get()).unwrap(),
                )
                .await
                .unwrap(),
            source
        );
    }
}

#[tokio::test]
async fn pty_rehost_keeps_worker_ownership_but_requires_hmux_runtime() {
    let (root, state, _, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    bind_fixture_worker_context(&state, &active).await;
    let source = active.session.clone().unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "worker-owned-rehost-target".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "worker-owned-rehost-instance".into(),
        channel_epoch: "3".into(),
        host_instance_id: "worker-owned-rehost-host".into(),
        terminal_epoch: "worker-owned-rehost-terminal".into(),
    };
    write_hmux_rehost_evidence(&root, &source, &target, "worker-owned-rehost-proof");
    complete_fixture_managed_create(&state, &target, "worker-owned-rehost-create");
    let worker_agent = AgentIdV1::new("worker-owned-rehost-agent").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: worker_agent.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Worker-owned rehost target".into(),
            created_at_ms: 1_100,
            updated_at_ms: 1_100,
        })
        .await
        .unwrap();
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&runtime_transition_target_authority(
            &worker_agent,
            &target,
            1,
            "worker-owned-account",
            1_100,
        ))
        .await
        .unwrap();
    let reconcile_body = json!({
        "schemaVersion": 1,
        "expected": {
            "taskId": active.task_id,
            "dispatchId": active.dispatch_id,
            "generation": active.generation,
        },
        "target": target,
        "reconciledAtMs": 1_200,
    });
    let fence_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE workflow_dispatches SET runtime_kind_id = 'runtime.other'")
        .execute(&fence_pool)
        .await
        .unwrap();
    let runtime_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "pty-rehost-runtime-kind-fence",
            "dispatch.session.reconcile-rehost",
            reconcile_body.clone(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(runtime_error.code, "orchestration_generation_conflict");
    assert_eq!(
        state
            .store
            .delegate_once_receipt("workflow-control-plane-1")
            .await
            .unwrap()
            .unwrap()
            .session,
        Some(source)
    );
    sqlx::query("UPDATE workflow_dispatches SET runtime_kind_id = 'runtime.hmux'")
        .execute(&fence_pool)
        .await
        .unwrap();
    fence_pool.close().await;

    let reconciled = invoke_orchestration(
        &state,
        "pty-rehost-distinct-worker-owner",
        "dispatch.session.reconcile-rehost",
        reconcile_body.clone(),
    )
    .await;
    assert_eq!(reconciled["receipt"]["outcome"], "rebound");
    assert_eq!(reconciled["receipt"]["target"], json!(target));

    let current_fence_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE workflow_dispatches SET runtime_kind_id = 'runtime.other'")
        .execute(&current_fence_pool)
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_dispatch_launches SET effective_launch_idempotency_key = NULL")
        .execute(&current_fence_pool)
        .await
        .unwrap();
    let current_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "pty-current-runtime-kind-fence",
            "dispatch.session.reconcile-rehost",
            reconcile_body,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(current_error.code, "orchestration_generation_conflict");
    let effective_key: Option<String> = sqlx::query_scalar(
        "SELECT effective_launch_idempotency_key FROM workflow_dispatch_launches",
    )
    .fetch_one(&current_fence_pool)
    .await
    .unwrap();
    assert_eq!(effective_key, None);
    current_fence_pool.close().await;
}

#[tokio::test]
async fn native_rehost_adopts_a_verified_orphan_only_after_exact_source_stop() {
    let agent_id = AgentIdV1::new("native-rehost-orphan-agent").unwrap();
    let (_root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        Vec::new(),
        Vec::new(),
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            conversation_id: Some("conversation-1".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let source_selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source_selection)
        .await
        .unwrap();
    let source_authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();

    // A restarted pane can retain an older source identity while Hmux already
    // owns the unique healthy writer for the same workspace and conversation.
    let operation_id = "native-rehost-orphan-operation";
    let rehost_request = hmux_client::ManagedRehostRequest::new(
        operation_id,
        "stale-client-session",
        "coordinator-workspace",
        "stale-client-runner",
        "stale-client-instance",
        1,
        "stale-client-host",
        "stale-client-terminal",
        true,
    )
    .unwrap()
    .with_expected_provider_id("codex")
    .unwrap()
    .with_expected_conversation_id("conversation-1")
    .unwrap();
    let source_stop = hmux_client::ManagedStopReceipt::from_request(
        rehost_request.source(),
        hmux_client::ManagedStopOutcome::AlreadyExited,
        "stale client source already exited",
    )
    .unwrap();
    let replacement = hmux_client::ManagedCreateReceipt::new(
        "native-rehost-orphan-create",
        "native-rehost-orphan-target",
        "coordinator-workspace",
        "codex",
        hmux_client::PermissionMode::Default,
        &state.hmux_identity.discovery_root,
        hmux_client::ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        hmux_client::ManagedCreateGenerationFence::new(
            "orphan-runner",
            "orphan-instance",
            2,
            "orphan-host",
            "orphan-terminal",
        )
        .unwrap(),
    )
    .unwrap();
    let receipt = hmux_client::ManagedRehostReceipt::new(
        &rehost_request,
        source_stop.clone(),
        replacement.clone(),
        "conversation-1",
        None,
        true,
    )
    .unwrap();
    let resolution = hmux_client::ManagedRehostResolution::from_receipts(
        operation_id,
        &source_stop,
        &replacement,
    )
    .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("rehost-resolution.json"),
        serde_json::to_vec(&resolution).unwrap(),
    )
    .unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "native-rehost-orphan-target".into(),
        workspace_id: "coordinator-workspace".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: "orphan-runner".into(),
        runner_instance: "orphan-instance".into(),
        channel_epoch: "2".into(),
        host_instance_id: "orphan-host".into(),
        terminal_epoch: "orphan-terminal".into(),
    };
    write_ready_hmux_session(&state, &target, "conversation-1");
    record_completion(
        &state.hmux_identity.discovery_root,
        &rehost_request,
        &receipt,
    );
    let body = json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "operationId": operation_id,
        "providerId": "codex",
        "targetCredential": { "kind": "provider_default" },
        "source": generation_json(
            "stale-client-session",
            "stale-client-runner",
            "stale-client-instance",
            "1",
            "stale-client-host",
            "stale-client-terminal",
        ),
        "target": generation_json(
            "native-rehost-orphan-target",
            "orphan-runner",
            "orphan-instance",
            "2",
            "orphan-host",
            "orphan-terminal",
        ),
    });

    let active_error = dispatch(&state, &native_rehost_request(&state, body.clone()))
        .await
        .unwrap_err();
    assert_eq!(
        active_error.code, "agent_runtime_native_rehost_conflict",
        "an active backend source must not adopt an unlineaged Hmux writer"
    );

    stop_native_runtime(&state, &agent_id, "native-rehost-orphan-close").await;
    let repair_operation = OperationIdV1::new("native-rehost-orphan-repair").unwrap();
    let repair = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: repair_operation.clone(),
            idempotency_key: "native-rehost-orphan-repair-key".into(),
            source: source_selection,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority,
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-1",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 40,
        })
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: repair_operation.clone(),
            expected_journal_revision: repair.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "hmux_managed_conversation_writer_conflict",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            advanced_at_ms: 50,
        })
        .await
        .unwrap();

    let inspection = serde_json::to_value(
        agent_runtime_transition_apply::inspect(
            &state,
            agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
            },
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(inspection["state"], "transitioning");
    assert_eq!(inspection["stage"], "repair_required");
    assert_eq!(
        inspection["targetFailure"]["providerCode"],
        "hmux_managed_conversation_writer_conflict"
    );

    let response = dispatch(&state, &native_rehost_request(&state, body))
        .await
        .unwrap();
    assert_eq!(response["receipt"]["selectionRevision"], 2);
    assert_eq!(
        response["receipt"]["authority"]["authority"]["binding"]["sessionId"],
        "native-rehost-orphan-target"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&repair_operation)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::Superseded
    );
}

#[tokio::test]
async fn native_rehost_atomically_converges_the_exact_hmux_successor() {
    let agent_id = AgentIdV1::new("native-rehost-agent-1").unwrap();
    let (root, mut state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            credential_reference_id: Some("account-b".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("codex-account-b");
    fs::create_dir(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let registered = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "codex".into(),
                reference_id: "account-b".into(),
                profile_directory_name: "codex-account-b".into(),
            },
        )
        .await
        .unwrap();
    let execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: "account-b".into(),
        credential_generation: Some(registered.credential_generation),
    };
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: execution_profile.clone(),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();

    // The Agent projection passed to native rehost intentionally carries no
    // Dispatch hint. Only the backend store knows this exact source generation
    // is enrolled, so the runtime transaction must discover and move it.
    let enrolled = invoke_orchestration(
        &state,
        "native-rehost-enroll-hidden-dispatch",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let enrolled_target: InteractionTarget =
        serde_json::from_value(enrolled["receipt"]["context"]["target"].clone()).unwrap();

    let first_operation_id = "native-rehost-operation-1";
    let operation_id = "native-rehost-operation-2";
    let first_request = hmux_client::ManagedRehostRequest::new(
        first_operation_id,
        "coordinator-session",
        "coordinator-workspace",
        "coordinator-runner",
        "coordinator-instance",
        1,
        "coordinator-host",
        "coordinator-terminal",
        true,
    )
    .unwrap()
    .with_expected_provider_id("codex")
    .unwrap()
    .with_expected_conversation_id("conversation-1")
    .unwrap()
    .with_expected_launch_reference("account-b")
    .unwrap();
    let source_stop = hmux_client::ManagedStopReceipt::from_request(
        first_request.source(),
        hmux_client::ManagedStopOutcome::AlreadyExited,
        "managed source already exited",
    )
    .unwrap();
    let intermediate = hmux_client::ManagedCreateReceipt::new(
        "replacement-create-1",
        "worker-session-intermediate",
        "coordinator-workspace",
        "codex",
        hmux_client::PermissionMode::Default,
        &state.hmux_identity.discovery_root,
        hmux_client::ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        hmux_client::ManagedCreateGenerationFence::new(
            "worker-runner",
            "worker-instance",
            2,
            "worker-host",
            "worker-terminal",
        )
        .unwrap(),
    )
    .unwrap();
    let first_receipt = hmux_client::ManagedRehostReceipt::new(
        &first_request,
        source_stop.clone(),
        intermediate.clone(),
        "conversation-1",
        Some("account-b".into()),
        true,
    )
    .unwrap();
    let final_request = hmux_client::ManagedRehostRequest::new(
        operation_id,
        "worker-session-intermediate",
        "coordinator-workspace",
        "worker-runner",
        "worker-instance",
        2,
        "worker-host",
        "worker-terminal",
        true,
    )
    .unwrap()
    .with_expected_provider_id("codex")
    .unwrap()
    .with_expected_conversation_id("conversation-1")
    .unwrap()
    .with_expected_launch_reference("codex-account-b")
    .unwrap();
    let intermediate_stop = hmux_client::ManagedStopReceipt::from_request(
        final_request.source(),
        hmux_client::ManagedStopOutcome::AlreadyExited,
        "intermediate managed source already exited",
    )
    .unwrap();
    let replacement = hmux_client::ManagedCreateReceipt::new(
        "replacement-create-2",
        "worker-session-rehosted",
        "coordinator-workspace",
        "codex",
        hmux_client::PermissionMode::BypassApprovals,
        &state.hmux_identity.discovery_root,
        hmux_client::ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        hmux_client::ManagedCreateGenerationFence::new(
            "worker-runner-final",
            "worker-instance-final",
            3,
            "worker-host-final",
            "worker-terminal-final",
        )
        .unwrap(),
    )
    .unwrap();
    let final_receipt = hmux_client::ManagedRehostReceipt::new(
        &final_request,
        intermediate_stop.clone(),
        replacement.clone(),
        "conversation-1",
        Some("codex-account-b".into()),
        true,
    )
    .unwrap();
    let first_resolution = hmux_client::ManagedRehostResolution::from_receipts(
        first_operation_id,
        &source_stop,
        &intermediate,
    )
    .unwrap();
    let mut resolution = first_resolution.clone();
    resolution
        .append(operation_id, &intermediate_stop, &replacement)
        .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("rehost-resolution.json"),
        serde_json::to_vec(&resolution).unwrap(),
    )
    .unwrap();
    let final_session = json!({
        "schema_version": 1,
        "session_id": "worker-session-rehosted",
        "workspace_id": "coordinator-workspace",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "codex",
        "runner_principal": "worker-runner-final",
        "runner_instance": "worker-instance-final",
        "channel_epoch": "3",
        "host_instance_id": "worker-host-final",
        "terminal_epoch": "worker-terminal-final",
        "output_seq": "0",
        "health": "healthy",
        "agentRuntimeState": null,
        "providerConversationIdentity": {
            "session_id": "worker-session-rehosted",
            "workspace_id": "coordinator-workspace",
            "runner_principal": "worker-runner-final",
            "runner_instance": "worker-instance-final",
            "channel_epoch": "3",
            "host_instance_id": "worker-host-final",
            "terminal_epoch": "worker-terminal-final",
            "provider_id": "codex",
            "conversation_id": "conversation-1"
        }
    });
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&final_session).unwrap(),
    )
    .unwrap();
    let runtime = state.hmux_identity.runtime_executable_path.clone();
    let first_record = record_completion(
        &state.hmux_identity.discovery_root,
        &first_request,
        &first_receipt,
    );
    let final_record = record_completion(
        &state.hmux_identity.discovery_root,
        &final_request,
        &final_receipt,
    );

    let source = generation_json(
        "coordinator-session",
        "coordinator-runner",
        "coordinator-instance",
        "1",
        "coordinator-host",
        "coordinator-terminal",
    );
    let target = generation_json(
        "worker-session-rehosted",
        "worker-runner-final",
        "worker-instance-final",
        "3",
        "worker-host-final",
        "worker-terminal-final",
    );
    let body = json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "operationId": operation_id,
        "providerId": "codex",
        "targetCredential": {
            "kind": "credential_reference",
            "referenceId": "account-b",
        },
        "source": source,
        "target": target,
    });

    let wrong_launch_request = hmux_client::ManagedRehostRequest::new(
        operation_id,
        "worker-session-intermediate",
        "coordinator-workspace",
        "worker-runner",
        "worker-instance",
        2,
        "worker-host",
        "worker-terminal",
        true,
    )
    .unwrap()
    .with_expected_provider_id("codex")
    .unwrap()
    .with_expected_conversation_id("conversation-1")
    .unwrap()
    .with_expected_launch_reference("codex-wrong")
    .unwrap();
    let wrong_launch_receipt = hmux_client::ManagedRehostReceipt::new(
        &wrong_launch_request,
        intermediate_stop.clone(),
        replacement.clone(),
        "conversation-1",
        Some("codex-wrong".into()),
        true,
    )
    .unwrap();
    final_record.replace(&wrong_launch_request, &wrong_launch_receipt);
    let wrong_launch_error = dispatch(&state, &native_rehost_request(&state, body.clone()))
        .await
        .unwrap_err();
    assert_eq!(
        wrong_launch_error.code,
        "agent_runtime_native_rehost_conflict"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&AgentIdV1::new("native-rehost-agent-1").unwrap())
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );

    final_record.restore();
    let selection_before_unavailable = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let authority_before_unavailable = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE provider_credential_profiles RENAME TO provider_credential_profiles_fault",
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let unavailable_error = dispatch(&state, &native_rehost_request(&state, body.clone()))
        .await
        .unwrap_err();
    assert_eq!(
        unavailable_error.code,
        "agent_runtime_native_rehost_unavailable"
    );
    assert_eq!(
        unavailable_error.disposition,
        BackendFailureDispositionV1::RetrySame
    );
    assert_eq!(
        unavailable_error.details,
        Some(json!({
            "stage": "credential_resolution",
            "cause": "provider_credential_profile_store_failed",
        })),
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap(),
        selection_before_unavailable
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap(),
        authority_before_unavailable
    );
    sqlx::query(
        "ALTER TABLE provider_credential_profiles_fault RENAME TO provider_credential_profiles",
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    fault_pool.close().await;

    // Persist the first Hmux edge, then lose the frontend response. The
    // frontend still owns the root request while both CP and Hmux advance.
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("rehost-resolution.json"),
        serde_json::to_vec(&first_resolution).unwrap(),
    )
    .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": "worker-session-intermediate",
            "workspace_id": "coordinator-workspace",
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": "codex",
            "runner_principal": "worker-runner",
            "runner_instance": "worker-instance",
            "channel_epoch": "2",
            "host_instance_id": "worker-host",
            "terminal_epoch": "worker-terminal",
            "output_seq": "0",
            "health": "healthy",
            "agentRuntimeState": null,
            "providerConversationIdentity": {
                "session_id": "worker-session-intermediate",
                "workspace_id": "coordinator-workspace",
                "runner_principal": "worker-runner",
                "runner_instance": "worker-instance",
                "channel_epoch": "2",
                "host_instance_id": "worker-host",
                "terminal_epoch": "worker-terminal",
                "provider_id": "codex",
                "conversation_id": "conversation-1"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let hmux_executable = state.hmux_identity.executable_path.clone();
    let final_hmux_script = fs::read_to_string(&hmux_executable).unwrap();
    fs::write(
        &hmux_executable,
        final_hmux_script.replace("worker-session-rehosted ]", "worker-session-intermediate ]"),
    )
    .unwrap();
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &hmux_executable,
        &runtime,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    let first_body = json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "operationId": first_operation_id,
        "providerId": "codex",
        "targetCredential": {
            "kind": "credential_reference",
            "referenceId": "account-b",
        },
        "source": body["source"].clone(),
        "target": generation_json(
            "worker-session-intermediate",
            "worker-runner",
            "worker-instance",
            "2",
            "worker-host",
            "worker-terminal",
        ),
    });
    let repair_operation_id = OperationIdV1::new("failed-native-credential-transition").unwrap();
    let admitted = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: repair_operation_id.clone(),
            idempotency_key: "failed-native-credential-transition-key".into(),
            source: selection_before_unavailable.clone(),
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: authority_before_unavailable.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::fresh(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: repair_operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 30,
        })
        .await
        .unwrap();
    let repair_required = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: repair_operation_id.clone(),
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "hmux_managed_conversation_writer_conflict",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            advanced_at_ms: 40,
        })
        .await
        .unwrap();
    assert_eq!(
        repair_required.state,
        AgentRuntimeTransitionStateV1::RepairRequired
    );
    let repair_fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_repair_native_rehost_dispatch_transfer
        BEFORE UPDATE OF session_id ON workflow_dispatch_launches
        WHEN OLD.session_id = 'coordinator-session'
          AND NEW.session_id = 'worker-session-intermediate'
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected repair Dispatch transfer');
        END
        "#,
    )
    .execute(&repair_fault_pool)
    .await
    .unwrap();
    let repair_commit_error = dispatch(&state, &native_rehost_request(&state, first_body.clone()))
        .await
        .unwrap_err();
    assert_eq!(
        repair_commit_error.code,
        "agent_runtime_native_rehost_store_failed"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&repair_operation_id)
            .await
            .unwrap()
            .unwrap(),
        repair_required
    );
    sqlx::query("DROP TRIGGER fail_repair_native_rehost_dispatch_transfer")
        .execute(&repair_fault_pool)
        .await
        .unwrap();
    repair_fault_pool.close().await;

    let first_response = dispatch(&state, &native_rehost_request(&state, first_body))
        .await
        .unwrap();
    assert_eq!(first_response["receipt"]["selectionRevision"], 2);
    assert_eq!(
        first_response["receipt"]["authority"]["authority"]["binding"]["sessionId"],
        "worker-session-intermediate"
    );
    let superseded = state
        .store
        .agent_runtime_transition(&repair_operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(superseded.state, AgentRuntimeTransitionStateV1::Superseded);
    assert_eq!(
        superseded
            .superseded_by_operation_id
            .as_ref()
            .map(OperationIdV1::as_str),
        Some(first_operation_id)
    );
    let intermediate_session = WorkflowSessionGenerationV1 {
        session_id: "worker-session-intermediate".into(),
        workspace_id: "coordinator-workspace".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: "worker-runner".into(),
        runner_instance: "worker-instance".into(),
        channel_epoch: "2".into(),
        host_instance_id: "worker-host".into(),
        terminal_epoch: "worker-terminal".into(),
    };
    assert_eq!(
        state
            .store
            .orchestration_target_for_exact_session(&intermediate_session)
            .await
            .unwrap(),
        enrolled_target
    );
    let database_path = state.store.database_path().to_path_buf();
    state.store.close().await;
    state = reopen_fixture_service_state(&state, &database_path).await.0;

    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("rehost-resolution.json"),
        serde_json::to_vec(&resolution).unwrap(),
    )
    .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&final_session).unwrap(),
    )
    .unwrap();
    fs::write(&hmux_executable, final_hmux_script).unwrap();
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &hmux_executable,
        &runtime,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();

    let mismatched_intermediate = hmux_client::ManagedCreateReceipt::new(
        "replacement-create-unrelated",
        "worker-session-intermediate",
        "coordinator-workspace",
        "codex",
        hmux_client::PermissionMode::Default,
        &state.hmux_identity.discovery_root,
        hmux_client::ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        hmux_client::ManagedCreateGenerationFence::new(
            "worker-runner",
            "worker-instance",
            2,
            "worker-host",
            "worker-terminal",
        )
        .unwrap(),
    )
    .unwrap();
    let mismatched_prefix = hmux_client::ManagedRehostReceipt::new(
        &first_request,
        source_stop.clone(),
        mismatched_intermediate,
        "conversation-1",
        Some("account-b".into()),
        true,
    )
    .unwrap();
    first_record.replace(&first_request, &mismatched_prefix);
    let mismatched_prefix_error = dispatch(&state, &native_rehost_request(&state, body.clone()))
        .await
        .unwrap_err();
    assert_eq!(
        mismatched_prefix_error.code,
        "agent_runtime_native_rehost_conflict"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .session_id,
        "worker-session-intermediate"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_native_rehost_receipt(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .operation_id
            .as_str(),
        first_operation_id
    );
    first_record.restore();

    // Reproduce the pane incident exactly: Chat startup stopped the stale native
    // source, published one exact failed structured binding, and then Hmux proved
    // that a native successor was already alive for the same conversation.
    let repair_source = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let repair_source_authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let repair_requested_at = repair_source
        .updated_at_ms
        .max(repair_source_authority.updated_at_ms)
        .saturating_add(1);
    let failed_structured_binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new(
            "interaction-native-rehost-failed-chat",
        )
        .unwrap(),
        agent_id: agent_id.clone(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        execution_profile: repair_source.execution_profile.clone(),
        provider_conversation_ref: Some("conversation-1".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-failed-b".into(),
            provider_epoch: "provider-failed-b".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-failed-chat").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: repair_requested_at,
        updated_at_ms: repair_requested_at,
    };
    state
        .store
        .create_agent_interaction(&failed_structured_binding)
        .await
        .unwrap();
    let failed_chat_operation_id = OperationIdV1::new("failed-chat-transition").unwrap();
    let admitted_failed_chat = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: failed_chat_operation_id.clone(),
            idempotency_key: "failed-chat-transition-key".into(),
            source: repair_source,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: repair_source_authority,
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-1",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: failed_structured_binding.execution_profile.clone(),
            target_launch_selection: None,
            requested_at_ms: repair_requested_at.saturating_add(1),
        })
        .await
        .unwrap();
    let stopped_failed_chat = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: failed_chat_operation_id.clone(),
            expected_journal_revision: admitted_failed_chat.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: repair_requested_at.saturating_add(2),
        })
        .await
        .unwrap();
    let failed_chat = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: failed_chat_operation_id.clone(),
            expected_journal_revision: stopped_failed_chat.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "codex_app_server_recovery_required",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                    authority: Some(Box::new(AgentRuntimeReplacementAuthorityV1(
                        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                            binding: failed_structured_binding,
                        },
                    ))),
                },
            },
            advanced_at_ms: repair_requested_at.saturating_add(3),
        })
        .await
        .unwrap();
    assert_eq!(
        failed_chat.state,
        AgentRuntimeTransitionStateV1::RepairRequired
    );
    let retire_count = Arc::new(AtomicUsize::new(0));
    let mut structured_runtimes =
        structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    structured_runtimes
        .register(
            ProviderIdV1::new("codex").unwrap(),
            Arc::new(ReplacementLineageRuntime {
                store: Arc::clone(&state.store),
                open_count: Arc::new(AtomicUsize::new(0)),
                retire_count: Arc::clone(&retire_count),
                observed_replacement_authorities: Arc::new(StdMutex::new(Vec::new())),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(structured_runtimes);

    // An operation-only publication must not inherit explicit repair's authority
    // to retire a different failed target, even when native completion is proven.
    let publication = json!({
        "schemaVersion": 1, "agentId": agent_id, "operationId": operation_id,
        "sourceSessionId": final_request.source().session_id(),
        "sourceWorkspaceId": final_request.source().workspace_id(),
    });
    let error = dispatch(&state, &native_rehost_request(&state, publication))
        .await
        .unwrap_err();
    assert_eq!(
        error.code,
        "agent_runtime_native_rehost_explicit_recovery_required"
    );
    assert_eq!(retire_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&failed_chat_operation_id)
            .await
            .unwrap()
            .unwrap(),
        failed_chat
    );

    // A transient failure while moving the hidden Dispatch rolls the Agent
    // authority back too. Replaying the same backend-owned operation after the
    // store recovers converges both authorities without a frontend rebind.
    let lineage_fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_native_rehost_dispatch_transfer
        BEFORE UPDATE OF session_id ON workflow_dispatch_launches
        WHEN OLD.session_id = 'worker-session-intermediate'
          AND NEW.session_id = 'worker-session-rehosted'
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected Dispatch transfer');
        END
        "#,
    )
    .execute(&lineage_fault_pool)
    .await
    .unwrap();
    let lineage_error = dispatch(&state, &native_rehost_request(&state, body.clone()))
        .await
        .unwrap_err();
    assert_eq!(
        lineage_error.code,
        "agent_runtime_native_rehost_store_failed"
    );
    assert_eq!(
        lineage_error.disposition,
        BackendFailureDispositionV1::RetrySame
    );
    assert_eq!(retire_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&failed_chat_operation_id)
            .await
            .unwrap()
            .unwrap(),
        failed_chat
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        state
            .store
            .orchestration_target_for_exact_session(&intermediate_session)
            .await
            .unwrap(),
        enrolled_target
    );
    sqlx::query("DROP TRIGGER fail_native_rehost_dispatch_transfer")
        .execute(&lineage_fault_pool)
        .await
        .unwrap();
    lineage_fault_pool.close().await;

    let detached_profile_directory = accounts.join("codex-account-b-detached");
    fs::rename(&profile_directory, &detached_profile_directory).unwrap();
    let response = dispatch(&state, &native_rehost_request(&state, body.clone()))
        .await
        .unwrap();
    assert_eq!(retire_count.load(Ordering::SeqCst), 2);

    assert_eq!(response["receipt"]["agentId"], "native-rehost-agent-1");
    assert_eq!(response["receipt"]["selectionRevision"], 3);
    assert_eq!(
        response["receipt"]["authority"]["authority"]["binding"]["sessionId"],
        "worker-session-rehosted"
    );
    let selected = state
        .store
        .agent_runtime_selection(&AgentIdV1::new("native-rehost-agent-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&AgentIdV1::new("native-rehost-agent-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.revision, 3);
    assert_eq!(
        selected
            .selected_by_operation_id
            .as_ref()
            .map(OperationIdV1::as_str),
        Some(operation_id)
    );
    assert_eq!(authority.binding.session_id, "worker-session-rehosted");
    assert_eq!(authority.binding.binding_generation, 3);
    let superseded_failed_chat = state
        .store
        .agent_runtime_transition(&failed_chat_operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        superseded_failed_chat.state,
        AgentRuntimeTransitionStateV1::Superseded
    );
    assert!(superseded_failed_chat.replacement_authority.is_none());
    assert_eq!(
        authority.binding.credential_reference_id.as_deref(),
        Some("account-b")
    );
    let target_session = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted".into(),
        workspace_id: "coordinator-workspace".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: "worker-runner-final".into(),
        runner_instance: "worker-instance-final".into(),
        channel_epoch: "3".into(),
        host_instance_id: "worker-host-final".into(),
        terminal_epoch: "worker-terminal-final".into(),
    };
    assert_eq!(
        state
            .store
            .orchestration_target_for_exact_session(&target_session)
            .await
            .unwrap(),
        enrolled_target
    );
    let target_context = invoke_orchestration(
        &state,
        "native-rehost-hidden-dispatch-context",
        "dispatch.context.get",
        json!({ "schemaVersion": 1, "session": target_session }),
    )
    .await;
    assert_eq!(
        target_context["receipt"]["endpointFence"]["sessionIdentity"],
        orchestration_session_identity(&target_session)
            .unwrap()
            .as_str()
    );

    let database_path = state.store.database_path().to_path_buf();
    state.store.close().await;
    state = reopen_fixture_service_state(&state, &database_path).await.0;

    let detached_runtime = runtime.with_extension("detached");
    fs::rename(&runtime, &detached_runtime).unwrap();
    let detached_hmux_executable = hmux_executable.with_extension("detached");
    fs::rename(&hmux_executable, &detached_hmux_executable).unwrap();
    let replay = dispatch(&state, &native_rehost_request(&state, body.clone()))
        .await
        .unwrap();
    assert_eq!(replay, response);
    fs::rename(&detached_runtime, &runtime).unwrap();
    fs::rename(&detached_hmux_executable, &hmux_executable).unwrap();
    fs::rename(&detached_profile_directory, &profile_directory).unwrap();
    let mut wrong_operation = body.clone();
    wrong_operation["operationId"] = json!("native-rehost-operation-other");
    let mut wrong_provider = body.clone();
    wrong_provider["providerId"] = json!("claude");
    let mut wrong_profile = body.clone();
    wrong_profile["targetCredential"] = json!({
        "kind": "credential_reference",
        "referenceId": "other-account",
    });
    let mut wrong_source = body.clone();
    wrong_source["source"]["terminalEpoch"] = json!("source-terminal-other");
    let mut wrong_target = body.clone();
    wrong_target["target"]["terminalEpoch"] = json!("worker-terminal-other");
    for conflicting in [
        wrong_operation,
        wrong_provider,
        wrong_profile,
        wrong_source,
        wrong_target,
    ] {
        let error = dispatch(&state, &native_rehost_request(&state, conflicting))
            .await
            .unwrap_err();
        assert_eq!(error.code, "agent_runtime_native_rehost_conflict");
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&AgentIdV1::new("native-rehost-agent-1").unwrap())
                .await
                .unwrap()
                .unwrap(),
            selected
        );
        assert_eq!(
            state
                .store
                .agent_checkpoint_binding_authority(
                    &AgentIdV1::new("native-rehost-agent-1").unwrap(),
                )
                .await
                .unwrap()
                .unwrap(),
            authority
        );
    }
    let inspected = dispatch(
        &state,
        &BackendRequest {
            schema_version: 1,
            api_version: BACKEND_PROTOCOL_API.into(),
            kind: BACKEND_REQUEST_KIND.into(),
            request_id: "runtime-native-rehost-inspect-1".into(),
            operation: "agent_runtime.inspect".into(),
            expected: ExpectedBackend {
                scope_id: None,
                backend_id: BACKEND_ID.into(),
                generation: state.descriptor.generation.clone(),
                protocol: ExpectedProtocol {
                    minimum: ProtocolVersion { major: 1, minor: 0 },
                    maximum: ProtocolVersion { major: 1, minor: 0 },
                },
                required_capabilities: Vec::new(),
            },
            body: json!({
                "schemaVersion": 1,
                "agentId": "native-rehost-agent-1",
            }),
            connection: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(inspected["state"], "stable");
    assert_eq!(
        inspected["receipt"]["authority"]["authority"]["binding"]["sessionId"],
        "worker-session-rehosted"
    );
    assert_eq!(
        inspected["receipt"]["launchIdempotencyKey"],
        "replacement-create-2"
    );

    let second_operation_id = "native-rehost-operation-3";
    let second_request = hmux_client::ManagedRehostRequest::new(
        second_operation_id,
        "worker-session-rehosted",
        "coordinator-workspace",
        "worker-runner-final",
        "worker-instance-final",
        3,
        "worker-host-final",
        "worker-terminal-final",
        true,
    )
    .unwrap()
    .with_expected_provider_id("codex")
    .unwrap()
    .with_expected_conversation_id("conversation-1")
    .unwrap()
    .with_expected_launch_reference("account-b")
    .unwrap();
    let second_stop = hmux_client::ManagedStopReceipt::from_request(
        second_request.source(),
        hmux_client::ManagedStopOutcome::AlreadyExited,
        "first successor already exited",
    )
    .unwrap();
    let second_replacement = hmux_client::ManagedCreateReceipt::new(
        "replacement-create-3",
        "worker-session-rehosted-again",
        "coordinator-workspace",
        "codex",
        hmux_client::PermissionMode::Default,
        &state.hmux_identity.discovery_root,
        hmux_client::ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        hmux_client::ManagedCreateGenerationFence::new(
            "worker-runner-next",
            "worker-instance-next",
            4,
            "worker-host-next",
            "worker-terminal-next",
        )
        .unwrap(),
    )
    .unwrap();
    let second_receipt = hmux_client::ManagedRehostReceipt::new(
        &second_request,
        second_stop.clone(),
        second_replacement.clone(),
        "conversation-1",
        Some("account-b".into()),
        true,
    )
    .unwrap();
    let second_resolution = hmux_client::ManagedRehostResolution::from_receipts(
        second_operation_id,
        &second_stop,
        &second_replacement,
    )
    .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("rehost-resolution.json"),
        serde_json::to_vec(&second_resolution).unwrap(),
    )
    .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": "worker-session-rehosted-again",
            "workspace_id": "coordinator-workspace",
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": "codex",
            "runner_principal": "worker-runner-next",
            "runner_instance": "worker-instance-next",
            "channel_epoch": "4",
            "host_instance_id": "worker-host-next",
            "terminal_epoch": "worker-terminal-next",
            "output_seq": "0",
            "health": "healthy",
            "agentRuntimeState": null,
            "providerConversationIdentity": {
                "session_id": "worker-session-rehosted-again",
                "workspace_id": "coordinator-workspace",
                "runner_principal": "worker-runner-next",
                "runner_instance": "worker-instance-next",
                "channel_epoch": "4",
                "host_instance_id": "worker-host-next",
                "terminal_epoch": "worker-terminal-next",
                "provider_id": "codex",
                "conversation_id": "conversation-1"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let second_record = record_completion(
        &state.hmux_identity.discovery_root,
        &second_request,
        &second_receipt,
    );
    let hmux_script = fs::read_to_string(&hmux_executable).unwrap().replace(
        "worker-session-rehosted ]",
        "worker-session-rehosted-again ]",
    );
    fs::write(&hmux_executable, hmux_script).unwrap();
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &hmux_executable,
        &runtime,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    let second_body = json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "operationId": second_operation_id,
        "providerId": "codex",
        "targetCredential": {
            "kind": "credential_reference",
            "referenceId": "account-b",
        },
        "source": target,
        "target": generation_json(
            "worker-session-rehosted-again",
            "worker-runner-next",
            "worker-instance-next",
            "4",
            "worker-host-next",
            "worker-terminal-next",
        ),
    });
    let second_response = dispatch(&state, &native_rehost_request(&state, second_body.clone()))
        .await
        .unwrap();
    assert_eq!(second_response["receipt"]["selectionRevision"], 4);
    assert_eq!(
        second_response["receipt"]["launchIdempotencyKey"],
        "replacement-create-3"
    );

    // The second operation was committed from its direct predecessor, but a
    // restarted stale pane can still own the original root. Replaying that
    // root must read and prove the complete Hmux lineage without admitting a
    // new transition or stopping another Host.
    let mut root_to_second_resolution = resolution.clone();
    root_to_second_resolution
        .append(second_operation_id, &second_stop, &second_replacement)
        .unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("rehost-resolution.json"),
        serde_json::to_vec(&root_to_second_resolution).unwrap(),
    )
    .unwrap();

    let cp_mismatch_replacement = hmux_client::ManagedCreateReceipt::new(
        "replacement-create-cp-mismatch",
        "worker-session-rehosted-again",
        "coordinator-workspace",
        "codex",
        hmux_client::PermissionMode::Default,
        &state.hmux_identity.discovery_root,
        hmux_client::ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        hmux_client::ManagedCreateGenerationFence::new(
            "worker-runner-next",
            "worker-instance-next",
            4,
            "worker-host-next",
            "worker-terminal-next",
        )
        .unwrap(),
    )
    .unwrap();
    let cp_mismatch_receipt = hmux_client::ManagedRehostReceipt::new(
        &second_request,
        second_stop.clone(),
        cp_mismatch_replacement,
        "conversation-1",
        Some("account-b".into()),
        true,
    )
    .unwrap();
    let mut root_replay_body = second_body.clone();
    root_replay_body["source"] = body["source"].clone();
    second_record.replace(&second_request, &cp_mismatch_receipt);
    let cp_mismatch_error = dispatch(
        &state,
        &native_rehost_request(&state, root_replay_body.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(
        cp_mismatch_error.code,
        "agent_runtime_native_rehost_conflict"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        4
    );

    second_record.restore();
    let root_replay = dispatch(
        &state,
        &native_rehost_request(&state, root_replay_body.clone()),
    )
    .await
    .unwrap();
    assert_eq!(root_replay, second_response);
    assert_eq!(root_replay["receipt"]["selectionRevision"], 4);

    let mut foreign_root_replay = root_replay_body;
    foreign_root_replay["source"]["terminalEpoch"] = json!("foreign-root-terminal");
    let foreign_root_error = dispatch(&state, &native_rehost_request(&state, foreign_root_replay))
        .await
        .unwrap_err();
    assert_eq!(
        foreign_root_error.code,
        "agent_runtime_native_rehost_conflict"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        4
    );

    let database_path = state.store.database_path().to_path_buf();
    state.store.close().await;
    state = reopen_fixture_service_state(&state, &database_path).await.0;
    fs::remove_dir_all(&profile_directory).unwrap();
    let second_replay = dispatch(&state, &native_rehost_request(&state, second_body))
        .await
        .unwrap();
    assert_eq!(second_replay, second_response);
    let inspected_again = dispatch(
        &state,
        &BackendRequest {
            schema_version: 1,
            api_version: BACKEND_PROTOCOL_API.into(),
            kind: BACKEND_REQUEST_KIND.into(),
            request_id: "runtime-native-rehost-inspect-2".into(),
            operation: "agent_runtime.inspect".into(),
            expected: ExpectedBackend {
                scope_id: None,
                backend_id: BACKEND_ID.into(),
                generation: state.descriptor.generation.clone(),
                protocol: ExpectedProtocol {
                    minimum: ProtocolVersion { major: 1, minor: 0 },
                    maximum: ProtocolVersion { major: 1, minor: 0 },
                },
                required_capabilities: Vec::new(),
            },
            body: json!({
                "schemaVersion": 1,
                "agentId": "native-rehost-agent-1",
            }),
            connection: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        inspected_again["receipt"]["launchIdempotencyKey"],
        "replacement-create-3"
    );

    drop(root);
}
