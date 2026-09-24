pub(super) fn operation_capability(operation: &str) -> Option<&'static str> {
    match operation {
        "agent_runtime.native.read" => Some("agent_runtime.native.read"),
        "agent_runtime.native.input" => Some("agent_runtime.native.input"),
        "backend.scope" => Some("backend.scope.v1"),
        "workspace_environment.invoke" => Some("workspace_environment.v1"),
        "agent_goal.get" | "agent_goal.put" => Some("agent_goal.v1"),
        "provider_recovery.get" | "provider_recovery.put" | "provider_recovery.observe_usage"
        | "agent_recovery.read" => Some("account_recovery.v1"),
        "browser.resource" => Some("browser.resource.v1"),
        "slack.connector" => Some("slack.connector.v1"),
        "agent_conversation.answer_pending" => Some("agent_conversation.answer_pending"),
        "agent_conversation.inspect" => Some("agent_conversation.inspect"),
        "agent_conversation.interrupt_turn" => Some("agent_conversation.interrupt_turn"),
        "agent_conversation.read" => Some("agent_conversation.read.v7"),
        "agent_conversation.read_queue" => Some("agent_conversation.read_queue"),
        "agent_conversation.inspect_input" => Some("agent_conversation.inspect_input"),
        "agent_conversation.recover" => Some("agent_conversation.recover"),
        "agent_conversation.start_turn" => Some("agent_conversation.start_turn"),
        "agent_conversation.continue_turn" => Some("agent_conversation.continue_turn"),
        "agent_conversation.enqueue_turn" => Some("agent_conversation.enqueue_turn"),
        "agent_conversation.cancel_queued_turn" => Some("agent_conversation.cancel_queued_turn"),
        "agent_conversation.steer_turn" => Some("agent_conversation.steer_turn"),
        "agent_spawn.apply" => Some("agent_spawn.apply"),
        "agent_spawn.preview" => Some("agent_spawn.preview.v2"),
        "agent_spawn.list" => Some("agent_spawn.list"),
        "agent_spawn.status" => Some("agent_spawn.status"),
        "agent_runtime.inspect" => Some("agent_runtime.inspect"),
        "agent_runtime.native_rehost.reconcile" => Some("agent_runtime.native_rehost.reconcile"),
        "agent_runtime.native_resume.publish" => Some("agent_runtime.native_resume.publish"),
        "agent_runtime.projection.inspect" => Some("agent_runtime.projection.inspect"),
        "agent_runtime.repair" => Some("agent_runtime.repair"),
        "agent_runtime.repair_intent.inspect.v1" => {
            Some("agent_runtime.repair_intent.inspect.v1")
        }
        "agent_runtime.stop" => Some("agent_runtime.stop"),
        "agent_runtime.remove" => Some("agent_runtime.remove"),
        "agent_runtime.transition" => Some("agent_runtime.transition"),
        "agent_checkpoint.binding.ensure" => Some("agent_checkpoint.binding.ensure"),
        "client_view.authority.read" => Some("client_view.authority.read"),
        "client_view.generation.advance" => Some("client_view.generation.advance"),
        "client_view.read" => Some("client_view.read"),
        "client_view.write" => Some("client_view.write"),
        "claude_conversation.open" => Some("claude_conversation.open"),
        "claude_conversation.stop" => Some("claude_conversation.stop"),
        "dispatch.stop.apply" => Some("dispatch.stop.apply"),
        "dispatch.stop.preview" => Some("dispatch.stop.preview"),
        "dispatch.stop.status" => Some("dispatch.stop.status"),
        "orchestration.invoke" => Some("orchestration.invoke"),
        "projects.list" => Some("projects.list"),
        "projects.register" => Some("projects.register"),
        "projects.show" => Some("projects.show"),
        "provider_catalog.read" => Some("provider_catalog.read"),
        "provider_launch_defaults.get" => Some("provider_launch_defaults.get"),
        "provider_launch_defaults.put" => Some("provider_launch_defaults.put"),
        "provider_credential_profile.register" => Some("provider_credential_profile.register"),
        "schedule.list" => Some("schedule.list"),
        "schedule.show" => Some("schedule.show"),
        "schedule.put" => Some("schedule.put"),
        "schedule.delete" => Some("schedule.delete"),
        "schedule.run_once" => Some("schedule.run_once"),
        "schedule.occurrences" => Some("schedule.occurrences"),
        "schedule.inspect" => Some("schedule.inspect"),
        "workflow.delegate_once" => Some("workflow.delegate_once"),
        "workflow.delegate_once.complete" => Some("workflow.delegate_once.complete"),
        "workflow.delegate_once.show" => Some("workflow.delegate_once.show"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::operation_capability;

    #[test]
    fn browser_resources_negotiate_the_existing_domain_capability() {
        assert_eq!(operation_capability("browser.resource"), Some("browser.resource.v1"));
        assert_eq!(operation_capability("browser.force"), None);
    }

    #[test]
    fn schedule_operations_negotiate_exact_capabilities() {
        for operation in [
            "schedule.list", "schedule.show", "schedule.put", "schedule.delete",
            "schedule.run_once", "schedule.occurrences", "schedule.inspect",
        ] {
            assert_eq!(operation_capability(operation), Some(operation));
        }
        assert_eq!(operation_capability("schedule.force"), None);
    }
}
