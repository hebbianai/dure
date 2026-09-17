use hmux_host::local_protocol::{
    ManagedProviderStopConversationFence, ProviderConversationIdentityProjection,
};

pub(crate) fn matches_provider_conversation(
    host_provider_id: &str,
    expected: &ManagedProviderStopConversationFence,
    actual: Option<&ProviderConversationIdentityProjection>,
) -> bool {
    if expected.provider_id != host_provider_id {
        return false;
    }
    match (expected.conversation_id.as_deref(), actual) {
        (None, None) => true,
        (Some(conversation_id), Some(actual)) => {
            actual.provider_id == expected.provider_id && actual.conversation_id == conversation_id
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_absence_remains_scoped_to_the_host_provider() {
        let matching = ManagedProviderStopConversationFence {
            provider_id: "codex".into(),
            conversation_id: None,
        };
        let mismatched = ManagedProviderStopConversationFence {
            provider_id: "claude".into(),
            conversation_id: None,
        };

        assert!(matches_provider_conversation("codex", &matching, None));
        assert!(!matches_provider_conversation("codex", &mismatched, None));
    }
}
