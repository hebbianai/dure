/// Whether an operation only observes durable agent state and can therefore
/// complete across replacement of the process serving that state.
#[must_use]
pub fn is_durable_agent_observation(operation: &str) -> bool {
    matches!(
        operation,
        "agent_conversation.inspect"
            | "agent_conversation.read"
            | "agent_conversation.subscribe"
            | "agent_goal.get"
            | "agent_runtime.inspect"
            | "agent_runtime.projection.inspect"
            | "agent_runtime.repair_intent.inspect.v1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_durable_observations_without_admitting_mutations() {
        for operation in [
            "agent_conversation.inspect",
            "agent_conversation.read",
            "agent_conversation.subscribe",
            "agent_goal.get",
            "agent_runtime.inspect",
            "agent_runtime.projection.inspect",
            "agent_runtime.repair_intent.inspect.v1",
        ] {
            assert!(is_durable_agent_observation(operation), "{operation}");
        }
        for operation in [
            "agent_conversation.recover",
            "agent_conversation.start_turn",
            "agent_conversation.continue_turn",
            "agent_goal.put",
            "agent_runtime.transition",
            "provider_credential_profile.register",
        ] {
            assert!(!is_durable_agent_observation(operation), "{operation}");
        }
    }
}
