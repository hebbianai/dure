use super::*;

pub(super) fn report(
    hmux: &RealHmux,
    source: &WorkflowSessionGenerationV1,
    activity: hmux_client::AgentRuntimeActivity,
    attention: hmux_client::AgentRuntimeAttention,
    completed: bool,
) {
    hmux_client::ManagedAgentStateReporter::new(
        PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap()),
        &hmux.root,
    )
    .with_discovery_root(&hmux.discovery)
    .report_agent_state_for_fence(
        hmux_client::ManagedAttachRequest::new(&source.session_id, &source.workspace_id).unwrap(),
        hmux_client::AgentStateReport {
            identity_only: false,
            activity,
            attention,
            turn_completed: completed,
            turn_completion_id: None,
            causality: None,
            working_ttl_ms: Some(60_000),
            conversation_identity: None,
            expected_observation: None,
        },
        hmux_client::SessionFence {
            workspace_id: source.workspace_id.clone(),
            session_id: source.session_id.clone(),
            runner_principal: source.runner_principal.clone(),
            runner_instance: source.runner_instance.clone(),
            channel_epoch: source.channel_epoch.parse().unwrap(),
            host_instance_id: source.host_instance_id.clone(),
            terminal_epoch: source.terminal_epoch.clone(),
        },
    )
    .unwrap();
}
