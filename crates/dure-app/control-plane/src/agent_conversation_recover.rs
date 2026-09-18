use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentInteractionBindingV1, AgentRuntimeBindingAuthorityV1,
};
use serde::Deserialize;

use crate::ServiceState;
use crate::agent_conversation_api::AgentConversationApiErrorV1;
use crate::agent_runtime_projection::AgentRuntimeObservedV1;
use crate::structured_provider_runtime::{
    StructuredProviderRuntimeErrorKindV1, StructuredProviderRuntimeErrorV1,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentConversationRecoverBodyV1 {
    schema_version: u16,
    expected_binding: AgentInteractionBindingV1,
}

pub(super) async fn recover(
    state: &ServiceState,
    body: AgentConversationRecoverBodyV1,
) -> Result<AgentInteractionBindingV1, AgentConversationApiErrorV1> {
    if body.schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1
        || body.expected_binding.validate().is_err()
    {
        return Err(AgentConversationApiErrorV1::RequestInvalid);
    }

    let expected = body.expected_binding;
    let _guard = state.agent_operations.acquire(&expected.agent_id).await;
    let (selection, current) = stable_structured_authority(state, &expected.agent_id).await?;
    if current != expected {
        return Err(AgentConversationApiErrorV1::Conflict);
    }
    let runtime = state
        .structured_runtimes
        .resolve(&selection.provider_id)
        .ok_or(AgentConversationApiErrorV1::RuntimeUnavailable)?;

    runtime
        .attach_existing(&selection, &expected)
        .await
        .map_err(recovery_runtime_error)?;
    let (current_selection, current_binding) =
        stable_structured_authority(state, &expected.agent_id).await?;
    if current_selection != selection {
        return Err(AgentConversationApiErrorV1::Conflict);
    }
    Ok(current_binding)
}

async fn stable_structured_authority(
    state: &ServiceState,
    agent_id: &dure_app::AgentIdV1,
) -> Result<
    (dure_app::AgentRuntimeSelectionV1, AgentInteractionBindingV1),
    AgentConversationApiErrorV1,
> {
    match crate::agent_runtime_projection::read_locked(state, agent_id)
        .await
        .map_err(|_| AgentConversationApiErrorV1::StoreFailed)?
    {
        AgentRuntimeObservedV1::Unmanaged => Err(AgentConversationApiErrorV1::NotFound),
        AgentRuntimeObservedV1::Stable {
            selection,
            authority,
        } => match *authority {
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
                Ok((*selection, binding))
            }
            AgentRuntimeBindingAuthorityV1::NativeCli { .. } => {
                Err(AgentConversationApiErrorV1::Conflict)
            }
        },
        AgentRuntimeObservedV1::Closed(_) | AgentRuntimeObservedV1::Transitioning { .. } => {
            Err(AgentConversationApiErrorV1::Conflict)
        }
    }
}

fn recovery_runtime_error(error: StructuredProviderRuntimeErrorV1) -> AgentConversationApiErrorV1 {
    match error.kind {
        StructuredProviderRuntimeErrorKindV1::RequestInvalid => {
            AgentConversationApiErrorV1::RequestInvalid
        }
        StructuredProviderRuntimeErrorKindV1::CredentialStale
        | StructuredProviderRuntimeErrorKindV1::SourceBusy
        | StructuredProviderRuntimeErrorKindV1::RuntimeConflict => {
            AgentConversationApiErrorV1::Conflict
        }
        StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable
        | StructuredProviderRuntimeErrorKindV1::CredentialUnavailable
        | StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired => {
            AgentConversationApiErrorV1::RuntimeUnavailable
        }
        StructuredProviderRuntimeErrorKindV1::LaunchFailed
        | StructuredProviderRuntimeErrorKindV1::StopFailed => {
            let detail = error.detail.unwrap_or_else(|| error.code.clone());
            AgentConversationApiErrorV1::ProviderFailed(
                crate::agent_conversation::AgentProviderCommandErrorV1::new(error.code, detail),
            )
        }
    }
}
