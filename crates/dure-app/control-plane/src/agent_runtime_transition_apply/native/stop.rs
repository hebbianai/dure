use dure_app::AgentCheckpointBindingAuthorityV1;
use hmux_client::{ManagedStopConversationFence, ManagedStopQuiescenceFence, ManagedStopRequest};

use super::{ExactStopFailure, ServiceState, stop_managed_request};

/// Replacement pins its conversation; explicit close pins only the generation.
pub(super) async fn stop_exact(
    state: &ServiceState,
    authority: &AgentCheckpointBindingAuthorityV1,
    conversation: Option<ManagedStopConversationFence>,
    workspace: &std::path::Path,
    stop_id: String,
    quiescence: Option<ManagedStopQuiescenceFence>,
) -> Result<(), ExactStopFailure> {
    let channel_epoch = authority
        .channel_epoch
        .parse::<u64>()
        .map_err(|_| ExactStopFailure::RequestInvalid)?;
    let mut request = ManagedStopRequest::new(
        stop_id,
        &authority.binding.session_id,
        &authority.runtime_workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &authority.runner_principal,
            &authority.runner_instance,
            channel_epoch,
            &authority.host_instance_id,
            &authority.terminal_epoch,
        )
    })
    .map_err(|_| ExactStopFailure::RequestInvalid)?;
    if let Some(conversation) = conversation {
        request = request
            .with_expected_conversation(conversation)
            .map_err(|_| ExactStopFailure::RequestInvalid)?;
    }
    if let Some(quiescence) = quiescence {
        request = request
            .with_expected_quiescence(quiescence)
            .map_err(|_| ExactStopFailure::RequestInvalid)?;
    }
    stop_managed_request(state, workspace, request).await
}
