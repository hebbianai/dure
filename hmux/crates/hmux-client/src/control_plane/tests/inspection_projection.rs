use super::*;

#[test]
fn fresh_observation_projects_only_the_matching_host_generation() {
    let manifest = ready_descriptor(1);
    let mut observed = manifest.clone();
    observed.output_seq = "9".into();
    let inspection = inspection_from_observation(
        manifest,
        Some(SessionProbeObservation {
            status: SessionProbeStatus::Healthy,
            observed_descriptor: Some(observed),
            controller_input_pending: Some(true),
            semantic_idle_ms: None,
            working_directory: Some(WorkingDirectoryDescriptor {
                terminal_epoch: "terminal-001".into(),
                observed_through_output_seq: "8".into(),
                path: "/repo/worktree".into(),
                source: crate::WorkingDirectorySource::ProcessInspection,
            }),
            execution_location: Some(ExecutionLocationDescriptor {
                terminal_epoch: "terminal-001".into(),
                observed_through_output_seq: "8".into(),
                location: crate::ExecutionLocation::Local,
                source: crate::ExecutionLocationSource::ProcessInspection,
            }),
            agent_identity: Some(AgentIdentityDescriptor {
                terminal_epoch: "terminal-001".into(),
                observed_through_output_seq: "8".into(),
                agent: Some(crate::AgentProvider::Codex),
                source: crate::AgentIdentitySource::ProcessInspection,
            }),
            agent_runtime_state: Some(AgentRuntimeStateDescriptor {
                terminal_epoch: "terminal-001".into(),
                revision: "3".into(),
                observed_through_output_seq: "8".into(),
                lifecycle: crate::AgentRuntimeLifecycle::Running,
                activity: crate::AgentRuntimeActivity::Waiting,
                attention: crate::AgentRuntimeAttention::None,
                attention_id: None,
                source: crate::AgentRuntimeStateSource::ProviderEvent,
                turn_completed_count: "1".into(),
            }),
            provider_conversation_identity: Some(Box::new(
                ProviderConversationIdentityDescriptor {
                    session_id: "session-001".into(),
                    workspace_id: "workspace".into(),
                    runner_principal: "runner".into(),
                    runner_instance: "runner-1".into(),
                    channel_epoch: "1".into(),
                    host_instance_id: "host-001".into(),
                    terminal_epoch: "terminal-001".into(),
                    revision: "2".into(),
                    observed_through_output_seq: "8".into(),
                    provider_id: "fixture".into(),
                    conversation_id: "conversation-1".into(),
                    source: crate::ProviderConversationIdentitySource::ProviderEvent,
                },
            )),
            recovered_presentation: None,
        }),
    );

    assert_eq!(inspection.output_seq, "9");
    assert_eq!(
        inspection
            .working_directory
            .as_ref()
            .map(|working_directory| working_directory.path.as_str()),
        Some("/repo/worktree")
    );
    assert_eq!(
        inspection
            .provider_conversation_identity
            .as_ref()
            .map(|identity| identity.conversation_id.as_str()),
        Some("conversation-1")
    );
    assert_eq!(
        inspection
            .agent_runtime_state
            .as_ref()
            .map(|state| state.activity),
        Some(crate::AgentRuntimeActivity::Waiting)
    );
    let projected = serde_json::to_value(&inspection).unwrap();
    assert_eq!(projected["controllerInputPending"], true);
    assert_eq!(projected["executionLocation"]["location"]["kind"], "local");
    assert_eq!(projected["agentIdentity"]["agent"], "codex");
    assert_eq!(
        projected["workingDirectory"]["path"],
        serde_json::json!("/repo/worktree")
    );
    assert_eq!(
        projected["agentRuntimeState"]["activity"],
        serde_json::json!("waiting")
    );
    assert_eq!(
        projected["providerConversationIdentity"]["conversation_id"],
        serde_json::json!("conversation-1")
    );
}

#[test]
fn unavailable_observations_remain_absent() {
    for status in [
        None,
        Some(SessionProbeStatus::StaleTransport),
        Some(SessionProbeStatus::IncompatibleProtocol),
        Some(SessionProbeStatus::GenerationChanged),
        Some(SessionProbeStatus::Exited),
    ] {
        let inspection = inspection_from_probe(ready_descriptor(1), status);
        let json = serde_json::to_value(inspection).unwrap();
        assert!(json["executionLocation"].is_null());
        assert!(json["agentIdentity"].is_null());
        assert!(json["controllerInputPending"].is_null());
        assert!(json["semanticIdleMs"].is_null());
    }
}

#[test]
fn observed_ordinary_shell_is_distinct_from_an_absent_observation() {
    let mut observation = SessionProbeObservation::from(SessionProbeStatus::Healthy);
    observation.execution_location = Some(ExecutionLocationDescriptor {
        terminal_epoch: "terminal-001".into(),
        observed_through_output_seq: "0".into(),
        location: crate::ExecutionLocation::Ssh {
            target: "qa@host.example".into(),
        },
        source: crate::ExecutionLocationSource::ProcessInspection,
    });
    observation.agent_identity = Some(AgentIdentityDescriptor {
        terminal_epoch: "terminal-001".into(),
        observed_through_output_seq: "0".into(),
        agent: None,
        source: crate::AgentIdentitySource::ProcessInspection,
    });
    let json = serde_json::to_value(inspection_from_observation(
        ready_descriptor(1),
        Some(observation),
    ))
    .unwrap();
    assert_eq!(json["executionLocation"]["location"]["kind"], "ssh");
    assert_eq!(
        json["executionLocation"]["location"]["target"],
        "qa@host.example"
    );
    assert!(json["agentIdentity"].is_object());
    assert!(json["agentIdentity"]["agent"].is_null());
    assert_eq!(json["agentIdentity"]["terminal_epoch"], "terminal-001");
}
