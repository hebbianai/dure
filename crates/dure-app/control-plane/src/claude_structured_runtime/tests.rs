use super::*;
use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1, AgentIdV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionIntentV1, OperationIdV1, ProviderPermissionModeV1, RuntimeKindIdV1,
    advance_agent_runtime_transition_v1,
};
use std::collections::BTreeSet;

#[test]
fn managed_profile_scrubs_ambient_auth_and_control_environment() {
    let credential_selectors = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_FEDERATION_RULE_ID",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_PROFILE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_USE_VERTEX",
    ];
    let mut inherited = BTreeMap::from([
        ("HOME".into(), "/home/test".into()),
        ("PATH".into(), "/bin".into()),
        ("DURE_INTERNAL_CAPABILITY".into(), "secret-c".into()),
        ("HMUX_SESSION_ID".into(), "session".into()),
        ("USER_TOOL_SETTING".into(), "preserved".into()),
    ]);
    for selector in credential_selectors {
        inherited.insert(selector.into(), "poisoned".into());
    }
    let mutation = ProviderStateEnvironment::from_mutations(
        BTreeMap::from([
            ("CLAUDE_CONFIG_DIR".into(), "/private/profile-a".into()),
            ("ANTHROPIC_CONFIG_DIR".into(), "/private/profile-a".into()),
        ]),
        credential_selectors
            .iter()
            .map(ToString::to_string)
            .collect(),
    )
    .unwrap();
    let environment = prepared_claude_environment(&inherited, &mutation).unwrap();
    assert_eq!(environment["CLAUDE_CONFIG_DIR"], "/private/profile-a");
    assert_eq!(environment["ANTHROPIC_CONFIG_DIR"], "/private/profile-a");
    assert_eq!(environment["USER_TOOL_SETTING"], "preserved");
    for removed in credential_selectors
        .into_iter()
        .chain(["DURE_INTERNAL_CAPABILITY", "HMUX_SESSION_ID"])
    {
        assert!(!environment.contains_key(removed));
    }
}

#[path = "launching_environment_tests.rs"]
mod launching_environment;

#[test]
fn provider_default_preserves_ambient_claude_credentials() {
    let environment = prepared_claude_environment(
        &BTreeMap::from([
            ("HOME".into(), "/home/test".into()),
            ("PATH".into(), "/bin".into()),
            ("ANTHROPIC_API_KEY".into(), "ambient-key".into()),
            ("CLAUDE_CONFIG_DIR".into(), "/credentials/default".into()),
            (
                "ANTHROPIC_CONFIG_DIR".into(),
                "/credentials/anthropic".into(),
            ),
            ("DURE_INTERNAL_CAPABILITY".into(), "control-secret".into()),
        ]),
        &ProviderStateEnvironment::from_mutations(
            BTreeMap::new(),
            BTreeSet::from(["CLAUDE_CONFIG_DIR".into(), "ANTHROPIC_CONFIG_DIR".into()]),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(environment["ANTHROPIC_API_KEY"], "ambient-key");
    assert!(!environment.contains_key("CLAUDE_CONFIG_DIR"));
    assert!(!environment.contains_key("ANTHROPIC_CONFIG_DIR"));
    assert!(!environment.contains_key("DURE_INTERNAL_CAPABILITY"));
}

#[test]
fn replacement_runtime_converges_within_one_backend_generation() {
    let interaction_session_id =
        AgentInteractionSessionIdV1::new("interaction-replacement-test").unwrap();
    let source = AgentProviderRuntimeFenceV1 {
        runtime_generation: "runtime-source-1".into(),
        provider_epoch: "query-source-1".into(),
    };
    let first = replacement_runtime(&interaction_session_id, &source, "backend-2");
    let retry = replacement_runtime(&interaction_session_id, &source, "backend-2");
    let next_backend = replacement_runtime(&interaction_session_id, &source, "backend-3");

    assert_eq!(first, retry);
    assert_ne!(first, source);
    assert_ne!(first, next_backend);
    assert!(safe_token(&first.runtime_generation));
    assert!(safe_token(&first.provider_epoch));
}

#[test]
fn structured_credential_replacement_accepts_only_the_exact_transition_target() {
    let source = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-credential").unwrap(),
        agent_id: AgentIdV1::new("agent-credential").unwrap(),
        provider_id: ProviderIdV1::new("claude").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-credential".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-source".into(),
            provider_epoch: "query-source".into(),
        },
        timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-credential").unwrap(),
        binding_revision: 2,
        history_complete: false,
        created_at_ms: 10,
        updated_at_ms: 20,
    };
    let request = ClaudeStructuredOpenRequestV1 {
        agent_id: source.agent_id.clone(),
        execution_profile: AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-b".into(),
            credential_generation: Some("credential-b-9".into()),
        },
        provider_conversation_ref: source.provider_conversation_ref.clone(),
        permission_mode: ProviderPermissionModeV1::SkipPermissions,
        model: Some(AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
        effort: Some(AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
    };
    let mut recovered = source.clone();
    recovered.execution_profile = request.execution_profile.clone();
    recovered.runtime = AgentProviderRuntimeFenceV1 {
        runtime_generation: "runtime-target-recovered".into(),
        provider_epoch: "query-target-recovered".into(),
    };
    recovered.binding_revision = 3;
    recovered.updated_at_ms = 30;

    assert!(is_exact_replacement_target(
        &recovered,
        &source,
        &request,
        &recovered.runtime,
        3,
    ));
    recovered.interaction_session_id =
        AgentInteractionSessionIdV1::new("interaction-other").unwrap();
    assert!(!is_exact_replacement_target(
        &recovered,
        &source,
        &request,
        &recovered.runtime,
        3,
    ));
}

#[test]
fn fresh_replacement_accepts_the_identity_allocated_by_the_exact_target_runtime() {
    let source = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-fresh").unwrap(),
        agent_id: AgentIdV1::new("agent-fresh").unwrap(),
        provider_id: ProviderIdV1::new("claude").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: None,
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-source".into(),
            provider_epoch: "query-source".into(),
        },
        timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-fresh").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    let request = ClaudeStructuredOpenRequestV1 {
        agent_id: source.agent_id.clone(),
        execution_profile: source.execution_profile.clone(),
        provider_conversation_ref: None,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
    };
    let mut target = source.clone();
    target.provider_conversation_ref = Some("allocated-by-session-start".into());
    target.runtime = AgentProviderRuntimeFenceV1 {
        runtime_generation: "runtime-target".into(),
        provider_epoch: "query-target".into(),
    };
    target.binding_revision = 3;
    target.updated_at_ms = 20;

    assert!(is_exact_replacement_target(
        &target,
        &source,
        &request,
        &target.runtime,
        2,
    ));
}

#[test]
fn structured_profile_replacement_can_stop_before_starting_native_cli() {
    let agent_id = AgentIdV1::new("agent-to-native").unwrap();
    let provider_id = ProviderIdV1::new("claude").unwrap();
    let execution_profile = AgentExecutionProfileV1::ProviderDefault;
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-to-native").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile: execution_profile.clone(),
        provider_conversation_ref: Some("conversation-to-native".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-to-native".into(),
            provider_epoch: "query-to-native".into(),
        },
        timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-to-native").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    let transition = AgentRuntimeTransitionRecordV1::admitted(AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("transition-to-native").unwrap(),
        idempotency_key: "transition-to-native-key".into(),
        source: AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id,
            provider_id,
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: execution_profile.clone(),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        },
        source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: binding.clone(),
        },
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
            "conversation-to-native",
        )
        .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        target_execution_profile: execution_profile,
        target_launch_selection: None,
        requested_at_ms: 11,
    })
    .unwrap();

    assert_eq!(
        structured_replacement_source_binding(&transition),
        Ok(&binding),
    );
}

#[test]
fn selection_only_replacement_admits_the_new_launch_selection() {
    let agent_id = AgentIdV1::new("agent-selection").unwrap();
    let provider_id = ProviderIdV1::new("claude").unwrap();
    let execution_profile = AgentExecutionProfileV1::ProviderDefault;
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-selection").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile: execution_profile.clone(),
        provider_conversation_ref: Some("conversation-selection".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-selection".into(),
            provider_epoch: "query-selection".into(),
        },
        timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-selection").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    let new_model = dure_app::AgentSpawnModelSelectionV1::parse("opus").unwrap();
    let new_effort = dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap();
    let admitted = AgentRuntimeTransitionRecordV1::admitted(AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("transition-selection").unwrap(),
        idempotency_key: "transition-selection-key".into(),
        source: AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: execution_profile.clone(),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        },
        source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: binding.clone(),
        },
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
            "conversation-selection",
        )
        .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        target_execution_profile: execution_profile.clone(),
        target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(new_model.clone()),
            effort: Some(new_effort.clone()),
            permission_mode: Some(ProviderPermissionModeV1::SkipPermissions),
        }),
        requested_at_ms: 11,
    })
    .unwrap();
    let stopped = dure_app::advance_agent_runtime_transition_v1(
        &admitted,
        &AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 12,
        },
    )
    .unwrap();

    // The request the transition apply path builds carries the NEW
    // selection; the fence must admit it and dispatch on the structured
    // source even though the execution profile is unchanged.
    let request = ClaudeStructuredOpenRequestV1 {
        agent_id: agent_id.clone(),
        execution_profile: execution_profile.clone(),
        provider_conversation_ref: Some("conversation-selection".into()),
        permission_mode: ProviderPermissionModeV1::SkipPermissions,
        model: Some(new_model),
        effort: Some(new_effort),
    };
    assert!(matches!(
        replacement_dispatch(&stopped, &request),
        Ok(ReplacementDispatch::StructuredSource)
    ));

    // A request still carrying the OLD source selection must conflict —
    // the intent's effective selection is the one authority.
    let stale = ClaudeStructuredOpenRequestV1 {
        model: None,
        effort: None,
        permission_mode: ProviderPermissionModeV1::Default,
        ..request
    };
    assert!(matches!(
        replacement_dispatch(&stopped, &stale),
        Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict)
    ));
}

#[test]
fn lazy_reopen_projects_only_the_latest_committed_structured_authority() {
    let agent_id = AgentIdV1::new("agent-reopen").unwrap();
    let provider_id = ProviderIdV1::new("claude").unwrap();
    let native_binding = SessionBindingRecordV1 {
        agent_id: agent_id.clone(),
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        session_id: "native-session-1".into(),
        provider_conversation_id: Some("conversation-1".into()),
        credential_reference_id: None,
        binding_generation: 1,
        bound_at_ms: 10,
    };
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::SkipPermissions,
        model: Some(AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
        effort: Some(AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    let intent = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("transition-reopen").unwrap(),
        idempotency_key: "transition-reopen-key".into(),
        source,
        source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: AgentCheckpointBindingAuthorityV1 {
                schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
                binding: native_binding.clone(),
                runtime_workspace_id: "workspace-1".into(),
                runner_principal: "runner-principal-1".into(),
                runner_instance: "runner-instance-1".into(),
                channel_epoch: "1".into(),
                host_instance_id: "host-instance-1".into(),
                terminal_epoch: "terminal-epoch-1".into(),
                updated_at_ms: 10,
            },
        },
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
            "conversation-1",
        )
        .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
        target_launch_selection: None,
        requested_at_ms: 11,
    };
    let admitted = AgentRuntimeTransitionRecordV1::admitted(intent).unwrap();
    let stopped = advance_agent_runtime_transition_v1(
        &admitted,
        &AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 12,
        },
    )
    .unwrap();
    let interaction_session_id = AgentInteractionSessionIdV1::new("interaction-reopen").unwrap();
    let started = advance_agent_runtime_transition_v1(
        &stopped,
        &AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: stopped.intent.operation_id.clone(),
            expected_journal_revision: 2,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: AgentInteractionBindingV1 {
                        schema_version: 1,
                        interaction_session_id: interaction_session_id.clone(),
                        agent_id: agent_id.clone(),
                        provider_id: provider_id.clone(),
                        execution_profile: AgentExecutionProfileV1::ProviderDefault,
                        provider_conversation_ref: Some("conversation-1".into()),
                        runtime: AgentProviderRuntimeFenceV1 {
                            runtime_generation: "runtime-1".into(),
                            provider_epoch: "query-1".into(),
                        },
                        timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-1").unwrap(),
                        binding_revision: 1,
                        history_complete: false,
                        created_at_ms: 13,
                        updated_at_ms: 13,
                    },
                }),
            },
            advanced_at_ms: 13,
        },
    )
    .unwrap();
    let committed = advance_agent_runtime_transition_v1(
        &started,
        &AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: started.intent.operation_id.clone(),
            expected_journal_revision: 3,
            advance: AgentRuntimeTransitionAdvanceV1::Committed,
            advanced_at_ms: 14,
        },
    )
    .unwrap();
    let selection = committed.intent.target_selection_at(14).unwrap();
    let projected = ClaudeStructuredOpenRequestV1::from_committed_or_legacy(
        agent_id.clone(),
        AgentExecutionProfileV1::ProviderDefault,
        Some("conversation-1".into()),
        Some(&selection),
    )
    .unwrap();
    assert_eq!(
        projected.permission_mode,
        ProviderPermissionModeV1::SkipPermissions
    );
    assert_eq!(
        projected.model.as_ref().map(|model| model.as_str()),
        Some("claude-opus-4-1")
    );
    assert_eq!(
        projected.effort.as_ref().map(|effort| effort.as_str()),
        Some("xhigh")
    );
    let legacy = ClaudeStructuredOpenRequestV1::from_committed_or_legacy(
        agent_id.clone(),
        AgentExecutionProfileV1::ProviderDefault,
        None,
        None,
    )
    .unwrap();
    assert_eq!(legacy.permission_mode, ProviderPermissionModeV1::Default);
    assert!(legacy.model.is_none() && legacy.effort.is_none());
    let request = ClaudeStructuredOpenRequestV1 {
        agent_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-1".into()),
        permission_mode: ProviderPermissionModeV1::SkipPermissions,
        model: Some(AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
        effort: Some(AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
    };

    assert_eq!(
        committed_structured_interaction(&selection, &committed, &request, &provider_id,),
        Some(interaction_session_id.clone())
    );
    assert!(
        committed_structured_interaction(
            &committed.intent.source,
            &committed,
            &request,
            &provider_id,
        )
        .is_none()
    );
    for mismatched_request in [
        ClaudeStructuredOpenRequestV1 {
            permission_mode: ProviderPermissionModeV1::Default,
            ..request.clone()
        },
        ClaudeStructuredOpenRequestV1 {
            model: Some(AgentSpawnModelSelectionV1::parse("claude-sonnet-4-6").unwrap()),
            ..request.clone()
        },
        ClaudeStructuredOpenRequestV1 {
            effort: Some(AgentSpawnEffortSelectionV1::parse("high").unwrap()),
            ..request.clone()
        },
    ] {
        assert!(
            committed_structured_interaction(
                &selection,
                &committed,
                &mismatched_request,
                &provider_id,
            )
            .is_none()
        );
    }

    let second_intent = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("transition-reopen-model").unwrap(),
        idempotency_key: "transition-reopen-model-key".into(),
        source: selection,
        source_authority: committed.target_authority.clone().unwrap(),
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
            "conversation-1",
        )
        .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
        target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(AgentSpawnModelSelectionV1::parse("claude-sonnet-4-6").unwrap()),
            effort: request.effort.clone(),
            permission_mode: Some(request.permission_mode.clone()),
        }),
        requested_at_ms: 15,
    };
    let second_admitted = AgentRuntimeTransitionRecordV1::admitted(second_intent).unwrap();
    let second_stopped = advance_agent_runtime_transition_v1(
        &second_admitted,
        &AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: second_admitted.intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 16,
        },
    )
    .unwrap();
    let second_started = advance_agent_runtime_transition_v1(
        &second_stopped,
        &AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: second_stopped.intent.operation_id.clone(),
            expected_journal_revision: 2,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: AgentInteractionBindingV1 {
                        schema_version: 1,
                        interaction_session_id: interaction_session_id.clone(),
                        agent_id: request.agent_id.clone(),
                        provider_id: provider_id.clone(),
                        execution_profile: request.execution_profile.clone(),
                        provider_conversation_ref: request.provider_conversation_ref.clone(),
                        runtime: AgentProviderRuntimeFenceV1 {
                            runtime_generation: "runtime-2".into(),
                            provider_epoch: "query-2".into(),
                        },
                        timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-1").unwrap(),
                        binding_revision: 2,
                        history_complete: false,
                        created_at_ms: 13,
                        updated_at_ms: 17,
                    },
                }),
            },
            advanced_at_ms: 17,
        },
    )
    .unwrap();
    let second_committed = advance_agent_runtime_transition_v1(
        &second_started,
        &AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: second_started.intent.operation_id.clone(),
            expected_journal_revision: 3,
            advance: AgentRuntimeTransitionAdvanceV1::Committed,
            advanced_at_ms: 18,
        },
    )
    .unwrap();
    let latest_selection = second_committed.intent.target_selection_at(18).unwrap();
    let latest_request = ClaudeStructuredOpenRequestV1 {
        model: Some(AgentSpawnModelSelectionV1::parse("claude-sonnet-4-6").unwrap()),
        ..request
    };
    assert_eq!(
        committed_structured_interaction(
            &latest_selection,
            &second_committed,
            &latest_request,
            &provider_id,
        ),
        Some(interaction_session_id)
    );
}
