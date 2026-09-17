use crate::ClientError;
use hmux_runtime_contract::ManagedStopConversationFence;
use hmux_session_protocol::{
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY, OperationReceiptReason,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
};

/// The Host-facing stop authority selected for one already fenced broker
/// request. The broker request and durable intent stay at v5; only an exact
/// legacy Host generation may receive the older frame shape after its
/// immutable conversation projection proves the omitted fence.
#[derive(Debug)]
pub(super) enum HostStopConversationAuthority {
    NotRequested,
    HostFenced,
    LegacyProjected {
        provider_id: String,
        conversation_id: String,
    },
}

impl HostStopConversationAuthority {
    pub(super) fn select(
        host_capabilities: &[String],
        expected: Option<&ManagedStopConversationFence>,
    ) -> Result<Self, ClientError> {
        let Some(expected) = expected else {
            return Ok(Self::NotRequested);
        };
        if supports(
            host_capabilities,
            MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
        ) {
            return Ok(Self::HostFenced);
        }
        let conversation_id = expected
            .conversation_id()
            .ok_or(ClientError::MissingCapability {
                capability: MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
            })?;
        if !supports(host_capabilities, PROVIDER_CONVERSATION_IDENTITY_CAPABILITY) {
            return Err(ClientError::MissingCapability {
                capability: PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            });
        }
        Ok(Self::LegacyProjected {
            provider_id: expected.provider_id().to_string(),
            conversation_id: conversation_id.to_string(),
        })
    }

    pub(super) fn requests_host_conversation_fence(&self) -> bool {
        matches!(self, Self::HostFenced)
    }

    pub(super) fn requests_identity_projection(&self) -> bool {
        matches!(self, Self::LegacyProjected { .. })
    }

    pub(super) fn validate_selected_capabilities(
        &self,
        supports_capability: impl Fn(&str) -> bool,
    ) -> Result<(), ClientError> {
        let required = match self {
            Self::NotRequested => return Ok(()),
            Self::HostFenced => MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY,
            Self::LegacyProjected { .. } => PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
        };
        supports_capability(required)
            .then_some(())
            .ok_or(ClientError::MissingCapability {
                capability: required,
            })
    }

    pub(super) fn validate_legacy_projection(
        &self,
        actual: Option<(&str, &str)>,
    ) -> Result<(), ClientError> {
        let Self::LegacyProjected {
            provider_id,
            conversation_id,
        } = self
        else {
            return Ok(());
        };
        if actual == Some((provider_id.as_str(), conversation_id.as_str())) {
            return Ok(());
        }
        Err(ClientError::managed_stop_refused(
            Some(OperationReceiptReason::AgentRuntimeChanged),
            "the legacy Hmux Host conversation projection does not match the exact stop authority",
        ))
    }
}

fn supports(capabilities: &[String], required: &str) -> bool {
    capabilities.iter().any(|capability| capability == required)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_session_protocol::PROVIDER_CONVERSATION_IDENTITY_CAPABILITY;

    fn expected(conversation_id: Option<&str>) -> ManagedStopConversationFence {
        ManagedStopConversationFence::new("codex", conversation_id.map(ToString::to_string))
            .unwrap()
    }

    #[test]
    fn old_host_accepts_only_an_exact_present_conversation_projection() {
        let capabilities = vec![PROVIDER_CONVERSATION_IDENTITY_CAPABILITY.to_string()];
        let authority =
            HostStopConversationAuthority::select(&capabilities, Some(&expected(Some("c-1"))))
                .unwrap();

        authority
            .validate_legacy_projection(Some(("codex", "c-1")))
            .unwrap();
        assert!(
            authority
                .validate_legacy_projection(Some(("codex", "c-2")))
                .unwrap_err()
                .is_definitive_managed_stop_refusal()
        );
        assert!(
            authority
                .validate_legacy_projection(None)
                .unwrap_err()
                .is_definitive_managed_stop_refusal()
        );
    }

    #[test]
    fn exact_absence_never_downgrades_to_a_legacy_host() {
        let capabilities = vec![PROVIDER_CONVERSATION_IDENTITY_CAPABILITY.to_string()];
        let error = HostStopConversationAuthority::select(&capabilities, Some(&expected(None)))
            .unwrap_err();

        assert!(matches!(
            error,
            ClientError::MissingCapability {
                capability: MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY
            }
        ));
    }
}
