use super::*;

pub(super) async fn verify_exact_orchestration_session(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
) -> Result<(), BackendDispatchError> {
    session.validate().map_err(orchestration_store_error)?;
    let stop_fence = HmuxStopFence {
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch: session.channel_epoch.clone(),
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
    };
    let hmux = match query_hmux_with_lifecycle(
        &state.hmux_identity,
        &session.session_id,
        &session.workspace_id,
        &stop_fence,
        false,
    )
    .await
    {
        Ok(hmux) => hmux,
        Err(HmuxSessionInspectionFailure::DescriptorUnavailable)
            if exact_generation_exited(state, session, &stop_fence).await =>
        {
            return Err(stale_generation("hmux_session_exited"));
        }
        Err(failure) => return Err(observation_error(failure)),
    };
    if hmux.provider_id != session.provider_id.as_str() {
        return Err(stale_generation("hmux_provider_mismatch"));
    }
    Ok(())
}

/// Hmux retains an exact tombstone for a retired generation. After a restart
/// or account switch, a process still carrying that generation (for example a
/// background fork of the predecessor) can never observe it as ready again, so
/// its context lookup is stale rather than a transient observation failure.
/// Only that exact exited tombstone qualifies; a missing or unreadable record
/// stays retryable.
async fn exact_generation_exited(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
    stop_fence: &HmuxStopFence,
) -> bool {
    query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &session.session_id,
        &session.workspace_id,
        stop_fence,
    )
    .await
    .is_ok_and(|observed| {
        observed.is_exited_exact() && observed.provider_id == session.provider_id.as_str()
    })
}

fn stale_generation(reason: &str) -> BackendDispatchError {
    let message = if reason == "hmux_session_exited" {
        "The managed Session generation has exited. A process from that generation cannot use orchestration; continue in the Agent's current Session."
    } else {
        "The managed Session does not match the requested generation or provider. Resolve the current Session before retrying."
    };
    BackendDispatchError {
        code: "orchestration_generation_conflict".into(),
        message: message.into(),
        details: Some(json!({"reasonCode": reason})),
        disposition: BackendFailureDispositionV1::StaleGeneration,
    }
}

fn observation_error(failure: HmuxSessionInspectionFailure) -> BackendDispatchError {
    // A failed observation cannot authorize enrollment, nor prove that the
    // caller's Session is stale. Retain the exact fence and Dispatch on retry.
    if matches!(
        failure,
        HmuxSessionInspectionFailure::AuthorityStale
            | HmuxSessionInspectionFailure::DescriptorMismatch
    ) {
        return stale_generation(failure.code());
    }
    let message = match failure {
        HmuxSessionInspectionFailure::RuntimeIdentityChanged => {
            "The backend's Hmux runtime changed after startup. Restart the Dure app that owns this backend, reconnect the tools, and retry the same context lookup."
        }
        HmuxSessionInspectionFailure::DescriptorTimeout
        | HmuxSessionInspectionFailure::DescriptorUnavailable => {
            "The backend could not observe the managed Session. Retry the same lookup after connectivity recovers; do not reset the Dispatch or create another Run."
        }
        _ => {
            "The backend could not validate the Session observation. Run dure diagnostics --json and include the reason code in feedback if it persists; retain the current Dispatch."
        }
    };
    BackendDispatchError {
        code: "orchestration_session_unavailable".into(),
        message: message.into(),
        details: Some(json!({"reasonCode": failure.code()})),
        disposition: BackendFailureDispositionV1::RetrySame,
    }
}
