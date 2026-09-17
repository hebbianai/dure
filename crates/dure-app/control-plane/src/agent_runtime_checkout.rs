use dure_app::{
    AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1, AgentRuntimeTransitionStore,
    DomainStoreErrorV1, SessionCheckoutAdmissionV1, SessionCheckoutOwnerV1,
    SessionCheckoutRecordV1, WorkflowSessionGenerationV1,
};
use dure_session_runtime::CheckoutSessionRuntime;

use crate::{BackendDispatchError, BackendFailureDispositionV1, ServiceState};

/// A new transition retains the exact active source before stopping it.
pub(super) async fn ensure(
    state: &ServiceState,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentRuntimeBindingAuthorityV1,
) -> Result<Option<SessionCheckoutRecordV1>, BackendDispatchError> {
    let Some(checkout) = resolve(state, selection, authority).await? else {
        return Ok(None);
    };
    if matches!(
        checkout.binding.identity.owner,
        SessionCheckoutOwnerV1::Agent { .. }
    ) {
        return Ok(Some(checkout));
    }
    state
        .store
        .adopt_agent_runtime_checkout(selection, authority, &checkout.binding)
        .await
        .map_err(store_error)
}

/// Resolve only this selection's exact runtime ancestry without transferring
/// ownership. New transitions and removal admit it under their own lifecycle
/// authority; cwd and unrelated Agent history never grant ownership.
pub(super) async fn resolve(
    state: &ServiceState,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentRuntimeBindingAuthorityV1,
) -> Result<Option<SessionCheckoutRecordV1>, BackendDispatchError> {
    if let Some(checkout) = state
        .store
        .agent_runtime_checkout(&selection.agent_id)
        .await
        .map_err(store_error)?
    {
        return Ok(Some(checkout));
    }
    let runtime = CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        state.hmux_identity.runtime_executable_path.clone(),
        state.hmux_identity.discovery_root.clone(),
    )
    .map_err(origin_error)?;
    let mut visited = std::collections::BTreeSet::new();
    let mut source = selection.clone();
    let mut source_authority = authority.clone();
    loop {
        let transition = match &source_authority {
            AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: native_authority,
            } => {
                let mut session = WorkflowSessionGenerationV1::from_checkpoint_authority(
                    native_authority,
                    &source.provider_id,
                );
                loop {
                    if !visited.insert((
                        session.workspace_id.clone(),
                        session.session_id.clone(),
                        session.host_instance_id.clone(),
                        session.terminal_epoch.clone(),
                    )) {
                        return Err(lineage_conflict());
                    }
                    let Some((origin, checkout)) = runtime
                        .managed_checkout_origin(session)
                        .await
                        .map_err(origin_error)?
                    else {
                        return Ok(None);
                    };
                    if let Some(checkout) = checkout {
                        // A completed old close has already ended membership. It
                        // must not be reopened or replaced by a guessed new claim.
                        if checkout.admission == SessionCheckoutAdmissionV1::Closed {
                            return Ok(None);
                        }
                        return Ok(Some(checkout));
                    }
                    if let Some(transition) = state
                        .store
                        .agent_runtime_transition_for_native_origin(&source.agent_id, &origin)
                        .await
                        .map_err(store_error)?
                    {
                        break Some(transition);
                    }
                    let Some(predecessor) = runtime
                        .managed_rehost_predecessor(origin)
                        .await
                        .map_err(origin_error)?
                    else {
                        break None;
                    };
                    session = predecessor;
                }
            }
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. } => {
                let Some(operation) = &source.selected_by_operation_id else {
                    return Ok(None);
                };
                let transition = state
                    .store
                    .agent_runtime_transition(operation)
                    .await
                    .map_err(store_error)?
                    .ok_or_else(lineage_conflict)?;
                if transition
                    .intent
                    .target_selection_at(source.updated_at_ms)
                    .map_err(store_error)?
                    != source
                {
                    return Err(lineage_conflict());
                }
                Some(transition)
            }
        };
        let Some(transition) = transition else {
            // Canonical spawn can own its separate registration without a
            // SessionCheckout claim. Absence is not permission to create one.
            return Ok(None);
        };
        if transition.intent.source.agent_id != selection.agent_id
            || transition.intent.source.provider_id != selection.provider_id
            || transition.intent.source.revision >= source.revision
        {
            return Err(lineage_conflict());
        }
        source = transition.intent.source;
        source_authority = transition.intent.source_authority;
    }
}

fn lineage_conflict() -> BackendDispatchError {
    BackendDispatchError::from("agent_runtime_checkout_lineage_conflict")
        .with_disposition(BackendFailureDispositionV1::StaleGeneration)
}

fn origin_error(error: impl std::fmt::Display) -> BackendDispatchError {
    BackendDispatchError::from(format!(
        "agent_runtime_checkout_origin_unavailable: {error}"
    ))
    .with_disposition(BackendFailureDispositionV1::RetrySame)
}

fn store_error(error: DomainStoreErrorV1) -> BackendDispatchError {
    let disposition = match error {
        DomainStoreErrorV1::InvalidRecord { .. } => BackendFailureDispositionV1::Terminal,
        DomainStoreErrorV1::IdentityConflict { .. }
        | DomainStoreErrorV1::IdempotencyConflict { .. }
        | DomainStoreErrorV1::RevisionConflict { .. } => {
            BackendFailureDispositionV1::StaleGeneration
        }
        _ => BackendFailureDispositionV1::RetrySame,
    };
    BackendDispatchError::from(format!("agent_runtime_checkout_store_failed: {error}"))
        .with_disposition(disposition)
}
