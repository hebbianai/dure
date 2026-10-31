//! A busy refusal must say which Host evidence kept the source, so a caller
//! can wait for, finish or answer that work instead of guessing. These cases
//! reuse the project-move fixture's exact fake Host descriptor.
use super::*;

fn write_runtime_inspection(state: &mut ServiceState, runtime: Value, pending: bool) {
    let mut agent_state = json!({"terminal_epoch": "coordinator-terminal", "revision": "3",
        "observed_through_output_seq": "9", "lifecycle": "running", "activity": "waiting",
        "attention": "none", "attention_id": null, "source": "provider_event", "turn_completed_count": "1"});
    agent_state
        .as_object_mut()
        .unwrap()
        .extend(runtime.as_object().unwrap().clone());
    write_observed_inspection(
        state,
        "ready",
        None,
        Some(json!({
            "output_seq": "9",
            "controllerInputPending": pending,
            "agentRuntimeState": agent_state,
            "providerConversationIdentity": {"session_id": "coordinator-session", "workspace_id": "coordinator-workspace",
                "runner_principal": "coordinator-runner", "runner_instance": "coordinator-instance", "channel_epoch": "1",
                "host_instance_id": "coordinator-host", "terminal_epoch": "coordinator-terminal", "revision": "1",
                "observed_through_output_seq": "9", "provider_id": "codex", "conversation_id": CONVERSATION, "source": "provider_event"}
        })),
    );
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
}

fn busy_cases() -> Vec<(Value, bool, &'static str)> {
    vec![
        (json!({"activity": "working"}), false, "agent_working"),
        // A Host that negotiated the background-work fact keeps `working` and
        // adds the fact; the refusal names it instead of a running turn.
        (
            json!({"activity": "working", "background_work": true}),
            false,
            "agent_background_work",
        ),
        (
            json!({"attention": "approval_required", "attention_id": "approval-1"}),
            false,
            "agent_attention_required",
        ),
        (
            json!({"activity": "working", "attention": "input_required", "attention_id": "question-1"}),
            false,
            "agent_attention_required",
        ),
        (json!({"lifecycle": "starting"}), false, "agent_starting"),
    ]
}

fn reason(error: &BackendDispatchError) -> Option<&str> {
    error
        .details
        .as_ref()
        .and_then(|details| details["reasonCode"].as_str())
}

#[tokio::test]
async fn account_switch_busy_refusal_names_the_host_evidence_and_changes_nothing() {
    for (runtime, pending, expected) in busy_cases() {
        let (_root, _destination, mut state, launcher) = setup(Vec::new()).await;
        write_runtime_inspection(&mut state, runtime.clone(), pending);
        let error = agent_runtime_transition_apply::apply(
            &state,
            &format!("busy-switch-{expected}"),
            agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
                schema_version: 1,
                agent_id: AgentIdV1::new("coordinator-1").unwrap(),
                target_interaction_profile: AgentInteractionProfileV1::NativeCli,
                expected_source_revision: Some(1),
                expected_operation_id: None,
                source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
                target_execution_profile: Some(AgentExecutionProfileV1::ProviderDefault),
                target_launch_selection: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "agent_runtime_source_busy", "{runtime}");
        assert_eq!(reason(&error), Some(expected), "{runtime}: {error:?}");
        assert_eq!(
            error.disposition,
            BackendFailureDispositionV1::RetrySame,
            "the same request may be retried once the source is idle"
        );
        assert!(launcher.requests().is_empty());
        let selection = state
            .store
            .agent_runtime_selection(&AgentIdV1::new("coordinator-1").unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selection.revision, 1, "a refusal never changes the account");
    }
}

#[tokio::test]
async fn project_move_preview_names_why_a_live_source_is_not_idle() {
    let mut cases = busy_cases();
    cases.push((json!({}), true, "controller_input_pending"));
    for (runtime, pending, expected) in cases {
        let (_root, _destination, mut state, launcher) = setup(Vec::new()).await;
        write_runtime_inspection(&mut state, runtime.clone(), pending);
        let error = preview(&state, &format!("busy-move-{expected}"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "agent_runtime_source_busy", "{runtime}");
        assert_eq!(reason(&error), Some(expected), "{runtime}: {error:?}");
        assert!(launcher.requests().is_empty());
    }
}
