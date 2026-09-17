use super::{WindowsServerState, lock};
use hmux_host::local_protocol::{
    ManagedProviderStop, OperationReceiptReason, ScreenSnapshotProfile,
};
use std::sync::atomic::Ordering;

/// Admits one Host-local stop only after the selected Windows generation proves
/// every authority the negotiated frame carries. A refusal leaves the Host
/// Ready; once `stopping` changes, later outcomes converge through Host exit.
pub(super) fn admit(
    state: &WindowsServerState,
    managed_stop: bool,
    managed_quiescent_stop: bool,
    managed_conversation_stop: bool,
    request: &ManagedProviderStop,
) -> Result<(), OperationReceiptReason> {
    if !managed_stop {
        return Err(OperationReceiptReason::AuthorizationDenied);
    }
    if request.expected_quiescence.is_some() && !managed_quiescent_stop {
        return Err(OperationReceiptReason::AgentRuntimeChanged);
    }
    if request.expected_conversation.is_some() && !managed_conversation_stop {
        return Err(OperationReceiptReason::AgentRuntimeChanged);
    }

    // Controller input and stop admission share this Host lock. Input that
    // wins publishes its runtime mutation before the fences are compared;
    // stop that wins changes `stopping` before any later PTY write can begin.
    let host = lock(&state.host).map_err(|_| OperationReceiptReason::ResourceLimit)?;
    if let Some(expected) = request.expected_quiescence.as_ref() {
        if !host
            .matches_agent_runtime_quiescence(&state.fence, expected)
            .map_err(|_| OperationReceiptReason::AgentRuntimeChanged)?
        {
            return Err(OperationReceiptReason::AgentRuntimeChanged);
        }
    }
    if let Some(expected) = request.expected_conversation.as_ref() {
        let snapshot = host
            .current_snapshot(ScreenSnapshotProfile::ViewportOnly)
            .map_err(|_| OperationReceiptReason::AgentRuntimeChanged)?;
        let actual = snapshot.provider_conversation_identity.as_deref();
        if !super::managed_stop_fence::matches_provider_conversation(
            &state.common.provider_id,
            expected,
            actual,
        ) {
            return Err(OperationReceiptReason::AgentRuntimeChanged);
        }
    }
    state
        .stopping
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| OperationReceiptReason::HostExiting)?;
    #[cfg(feature = "terminal-state-stream")]
    state.agent_prompt_admission.notify();
    drop(host);
    state
        .termination_tx
        .try_send(())
        .map_err(|_| OperationReceiptReason::HostExiting)
}
