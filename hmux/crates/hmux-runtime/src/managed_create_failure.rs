use hmux_client::recovery_journal::managed_create_ledger::{
    ManagedCreateAdmissionError, ManagedCreateCompletedGenerationEvidence,
};
use hmux_client::recovery_journal::request_fingerprint;
use hmux_runtime_contract::{
    ManagedCreateReceipt, ManagedCreateRequest, ManagedStopConversationFence, ManagedStopRequest,
};
use std::fmt;

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[cfg(debug_assertions)]
const TEST_HOST_OMIT_CAPABILITIES_ENV: &str = "HMUX_RUNTIME_TEST_HOST_OMIT_CAPABILITIES";

#[derive(Debug)]
pub(crate) struct UnsupportedManagedCreateContract {
    required_capability: &'static str,
}

impl fmt::Display for UnsupportedManagedCreateContract {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "the Hmux runtime cannot create a Host with required capability {}",
            self.required_capability
        )
    }
}

impl std::error::Error for UnsupportedManagedCreateContract {}

/// Hmux-owned proof that one completed create receipt still names the exact
/// discovered generation and that generation has authoritatively exited.
/// Kept internal to the destructive advance broker: ordinary create remains a
/// non-mutating retry, while advance can resume one deterministic stop saga.
#[derive(Clone, Debug)]
pub(crate) struct ManagedCreateExactExited {
    source: ManagedCreateCompletedGenerationEvidence,
    stop_request: ManagedStopRequest,
}

impl ManagedCreateExactExited {
    pub(crate) fn from_source(
        source: ManagedCreateCompletedGenerationEvidence,
    ) -> Result<Self, DynError> {
        let stop_request = exact_stop_request(&source)?;
        Ok(Self {
            source,
            stop_request,
        })
    }

    pub(crate) fn receipt(&self) -> &ManagedCreateReceipt {
        self.source.receipt()
    }

    pub(crate) fn stop_request(&self) -> &ManagedStopRequest {
        &self.stop_request
    }
}

impl fmt::Display for ManagedCreateExactExited {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the exact completed managed-create generation has exited")
    }
}

impl std::error::Error for ManagedCreateExactExited {}

pub(crate) fn ensure_required_capabilities(
    request: &ManagedCreateRequest,
    host_capabilities: &[String],
) -> Result<(), UnsupportedManagedCreateContract> {
    for required_capability in request.required_host_capabilities() {
        if !host_capabilities
            .iter()
            .any(|capability| capability == required_capability)
        {
            return Err(UnsupportedManagedCreateContract {
                required_capability,
            });
        }
    }
    Ok(())
}

pub(crate) fn ready_satisfies_required_capabilities(
    request: &ManagedCreateRequest,
    host_capabilities: &[String],
) -> bool {
    request
        .required_host_capabilities()
        .all(|required| host_capabilities.iter().any(|capability| capability == required))
}

/// Applies the isolated old-Host fixture seam to the exact capability manifest
/// that both admission and the spawned Host observe. Release builds always
/// preserve the supplied manifest.
pub(crate) fn effective_host_capabilities(capabilities: Vec<String>) -> Vec<String> {
    #[cfg(debug_assertions)]
    let capabilities = {
        let omitted = std::env::var(TEST_HOST_OMIT_CAPABILITIES_ENV).unwrap_or_default();
        capabilities
            .into_iter()
            .filter(|capability| !omitted.split(',').any(|value| value == capability))
            .collect()
    };
    capabilities
}

pub(crate) fn admission_code(
    error: &(dyn std::error::Error + Send + Sync + 'static),
) -> Option<&'static str> {
    if error.is::<UnsupportedManagedCreateContract>() {
        return Some(hmux_runtime_contract::MANAGED_CREATE_REQUEST_INVALID_CODE);
    }
    error
        .downcast_ref::<ManagedCreateAdmissionError>()
        .and_then(ManagedCreateAdmissionError::code)
}

pub(crate) fn failure_code(
    error: &(dyn std::error::Error + Send + Sync + 'static),
) -> Option<&'static str> {
    admission_code(error).or_else(|| {
        error
            .downcast_ref::<super::HostSpawnFailure>()
            .map(super::HostSpawnFailure::code)
    })
}

pub(crate) fn canonical_source_changed(
    error: &(dyn std::error::Error + Send + Sync + 'static),
) -> bool {
    error
        .downcast_ref::<ManagedCreateAdmissionError>()
        .is_some_and(ManagedCreateAdmissionError::canonical_source_changed)
}

pub(crate) fn successor_lineage_conflict(
    error: &(dyn std::error::Error + Send + Sync + 'static),
) -> bool {
    error
        .downcast_ref::<ManagedCreateAdmissionError>()
        .is_some_and(ManagedCreateAdmissionError::successor_lineage_conflict)
}

/// Builds the one deterministic, fully fenced stop identity for a completed
/// source. The conversation fence is always the immutable ledger value; no
/// replacement request participates in source retirement.
pub(crate) fn exact_stop_request(
    source: &ManagedCreateCompletedGenerationEvidence,
) -> Result<ManagedStopRequest, DynError> {
    let receipt = source.receipt();
    let fence = receipt
        .generation_fence()
        .ok_or("managed create journal receipt has no generation fence")?;
    let serialized = serde_json::to_string(receipt)?;
    let stop_id = format!(
        "managed_create_advance_stop_{}",
        request_fingerprint(&[&serialized])
    );
    let request = ManagedStopRequest::new(
        stop_id,
        receipt.session_id(),
        receipt.workspace_id(),
    )?
    .with_expected_fence(
        fence.runner_principal(),
        fence.runner_instance(),
        fence.channel_epoch(),
        fence.host_instance_id(),
        fence.terminal_epoch(),
    )?;
    Ok(with_persisted_conversation_fence(
        request,
        source.conversation_identity(),
    )?)
}

/// Adds an exact conversation fence only when create-time evidence recorded
/// one. Absence in the create ledger means the provider had not published an
/// identity yet; generation authority remains sufficient for exact cleanup.
pub(crate) fn with_persisted_conversation_fence(
    request: ManagedStopRequest,
    conversation: Option<&hmux_runtime_contract::ProviderConversationIdentitySeed>,
) -> Result<ManagedStopRequest, hmux_runtime_contract::RuntimeContractError> {
    let Some(conversation) = conversation else {
        return Ok(request);
    };
    request.with_expected_conversation(ManagedStopConversationFence::new(
        conversation.provider_id(),
        Some(conversation.conversation_id().to_string()),
    )?)
}

pub(crate) fn exact_exited_generation<'a>(
    error: &'a (dyn std::error::Error + Send + Sync + 'static),
) -> Option<&'a ManagedCreateExactExited> {
    error.downcast_ref::<ManagedCreateExactExited>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_exact_admission_has_the_cross_platform_broker_code() {
        assert_eq!(
            admission_code(&ManagedCreateAdmissionError::GenerationRetiredExact),
            Some("hmux_managed_create_retired_exact")
        );
        assert_eq!(
            admission_code(&std::io::Error::other("launch failed")),
            None
        );
        assert_eq!(
            admission_code(&ManagedCreateAdmissionError::CanonicalRequestDigestConflict),
            Some(hmux_runtime_contract::MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE)
        );
        assert_eq!(
            admission_code(&ManagedCreateAdmissionError::SuccessorRequestDigestConflict),
            Some(hmux_runtime_contract::MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE)
        );
    }

    #[test]
    fn lifecycle_requirement_is_a_definite_pre_launch_refusal() {
        let request = ManagedCreateRequest::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            hmux_runtime_contract::PermissionMode::Default,
            "/tmp",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_runtime_contract::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
        )
        .unwrap();

        let error = ensure_required_capabilities(&request, &[]).unwrap_err();
        assert_eq!(
            admission_code(&error),
            Some(hmux_runtime_contract::MANAGED_CREATE_REQUEST_INVALID_CODE)
        );
    }

    #[test]
    fn mixed_provider_state_mutation_requires_both_capabilities_before_launch() {
        let request = ManagedCreateRequest::new(
            "create-removal",
            "session-removal",
            "workspace-removal",
            "codex",
            hmux_runtime_contract::PermissionMode::Default,
            "/tmp",
            vec!["codex".into()],
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(
            hmux_runtime_contract::ProviderStateEnvironment::from_mutations(
                std::collections::BTreeMap::from([(
                    "CODEX_HOME".into(),
                    "/tmp/codex-profile".into(),
                )]),
                std::collections::BTreeSet::from(["OPENAI_API_KEY".into()]),
            )
            .unwrap(),
        )
        .unwrap();

        let error = ensure_required_capabilities(&request, &[]).unwrap_err();
        assert_eq!(
            admission_code(&error),
            Some(hmux_runtime_contract::MANAGED_CREATE_REQUEST_INVALID_CODE)
        );
        for incomplete in [
            vec![hmux_runtime_contract::PROVIDER_STATE_ENVIRONMENT_CAPABILITY.into()],
            vec![hmux_runtime_contract::PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY.into()],
        ] {
            assert!(ensure_required_capabilities(&request, &incomplete).is_err());
        }
        assert!(ensure_required_capabilities(
            &request,
            &[
                hmux_runtime_contract::PROVIDER_STATE_ENVIRONMENT_CAPABILITY.into(),
                hmux_runtime_contract::PROVIDER_STATE_ENVIRONMENT_REMOVAL_CAPABILITY.into(),
            ]
        )
        .is_ok());
    }
}
