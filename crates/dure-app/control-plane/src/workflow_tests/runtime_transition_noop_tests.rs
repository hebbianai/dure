use super::*;

#[tokio::test]
async fn unchanged_request_replay_cannot_retarget_after_credential_or_profile_changes() {
    for credential_change in [true, false] {
        let (root, mut state, launcher, _) = fixture(Vec::new()).await;
        let (source, binding) = initialize_structured_source(&state).await;
        let body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: source.agent_id.clone(),
            target_interaction_profile: source.interaction_profile,
            expected_source_revision: None,
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            target_execution_profile: None,
            target_launch_selection: None,
        };
        let original = agent_runtime_transition_apply::apply(&state, "unchanged", body.clone())
            .await
            .unwrap();
        assert_eq!(
            agent_runtime_transition_apply::apply(&state, "unchanged", body.clone())
                .await
                .unwrap(),
            original
        );
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&source.agent_id)
                .await
                .unwrap(),
            Some(source.clone())
        );

        let key = agent_runtime_transition_apply::runtime_transition_identity("unchanged")
            .unwrap()
            .1;
        let recorded = state
            .store
            .agent_runtime_request_receipt(&key)
            .await
            .unwrap();
        assert!(recorded.is_some());
        commit_intervening_selection(&state, &source, &binding, credential_change).await;
        let current = state
            .store
            .agent_runtime_selection(&source.agent_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.revision, 2);
        if credential_change {
            assert_ne!(current.execution_profile, source.execution_profile);
        } else {
            assert_ne!(current.interaction_profile, source.interaction_profile);
        }
        state.store = Arc::new(
            SqliteDomainStore::open(root.path().join("domain.sqlite"))
                .await
                .unwrap(),
        );
        assert_eq!(
            agent_runtime_transition_apply::apply(&state, "unchanged", body.clone())
                .await
                .unwrap_err()
                .code,
            "agent_runtime_transition_commit_stale"
        );
        assert_eq!(
            state
                .store
                .agent_runtime_request_receipt(&key)
                .await
                .unwrap(),
            recorded
        );
        let mut different_target = body.clone();
        different_target.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
        let mut different_agent = body;
        different_agent.agent_id = AgentIdV1::new("another-agent").unwrap();
        for changed in [different_target, different_agent] {
            assert_eq!(
                agent_runtime_transition_apply::apply(&state, "unchanged", changed)
                    .await
                    .unwrap_err()
                    .code,
                "agent_runtime_transition_idempotency_conflict"
            );
        }
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&source.agent_id)
                .await
                .unwrap(),
            Some(current)
        );
        assert!(
            state
                .store
                .active_agent_runtime_transition(&source.agent_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(launcher.requests().is_empty());
    }
}

// Publish a valid intervening journal outcome without involving a provider.
// Real process creation and closed-source replay are covered by the Hmux smoke.
async fn commit_intervening_selection(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    binding: &AgentInteractionBindingV1,
    credential_change: bool,
) {
    let execution = if credential_change {
        AgentExecutionProfileV1::CredentialReference {
            reference_id: "another-account".into(),
            credential_generation: Some("another-generation".into()),
        }
    } else {
        AgentExecutionProfileV1::ProviderDefault
    };
    let intent = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("intervening-selection").unwrap(),
        idempotency_key: "intervening-selection-key".into(),
        source: source.clone(),
        source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: binding.clone(),
        },
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::from_option(
            binding.provider_conversation_ref.clone(),
        )
        .unwrap(),
        target_interaction_profile: if credential_change {
            AgentInteractionProfileV1::StructuredProtocol
        } else {
            AgentInteractionProfileV1::NativeCli
        },
        target_execution_profile: execution.clone(),
        target_launch_selection: None,
        requested_at_ms: 20,
    };
    state
        .store
        .admit_agent_runtime_transition(&intent)
        .await
        .unwrap();
    let advance = |revision, action, time| AgentRuntimeTransitionAdvanceRequestV1 {
        schema_version: 1,
        operation_id: intent.operation_id.clone(),
        expected_journal_revision: revision,
        advance: action,
        advanced_at_ms: time,
    };
    state
        .store
        .advance_agent_runtime_transition(&advance(
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            21,
        ))
        .await
        .unwrap();
    let authority = if credential_change {
        let replacement = state
            .store
            .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
                schema_version: 1,
                interaction_session_id: binding.interaction_session_id.clone(),
                expected_binding_revision: binding.binding_revision,
                source: binding.runtime.clone(),
                source_execution_profile: binding.execution_profile.clone(),
                target: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "intervening-runtime".into(),
                    provider_epoch: "intervening-epoch".into(),
                },
                target_execution_profile: execution,
                provider_conversation_ref: binding.provider_conversation_ref.clone(),
                replaced_at_ms: 30,
            })
            .await
            .unwrap();
        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: replacement,
        }
    } else {
        let mut authority = state
            .store
            .agent_checkpoint_binding_authority(&source.agent_id)
            .await
            .unwrap()
            .unwrap();
        authority.binding.provider_conversation_id = binding.provider_conversation_ref.clone();
        authority.binding.binding_generation += 1;
        authority.binding.session_id =
            dure_app::agent_runtime_native_launch_identity_v1(&intent.operation_id).session_id;
        authority.binding.bound_at_ms = 30;
        authority.host_instance_id = "intervening-host".into();
        authority.terminal_epoch = "intervening-terminal".into();
        authority.updated_at_ms = 30;
        state
            .store
            .upsert_agent_checkpoint_binding_authority(&authority)
            .await
            .unwrap();
        AgentRuntimeBindingAuthorityV1::NativeCli { authority }
    };
    state
        .store
        .advance_agent_runtime_transition(&advance(
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: (!credential_change).then(|| {
                    dure_app::agent_runtime_native_launch_identity_v1(&intent.operation_id)
                        .launch_idempotency_key
                }),
                authority: Box::new(authority),
            },
            30,
        ))
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_transition(&advance(
            3,
            AgentRuntimeTransitionAdvanceV1::Committed,
            31,
        ))
        .await
        .unwrap();
}
