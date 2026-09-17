use dure_app::{
    AgentCheckpointBindingAuthorityV1, AgentIdV1, AgentInteractionProfileV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1, AgentRuntimeTransitionRecordV1,
    AgentRuntimeTransitionStateV1, AgentRuntimeTransitionStore, ProviderIdV1,
};

use crate::agent_runtime_projection::AgentRuntimeObservedV1;

use super::{BackendDispatchError, ServiceState, conflict, failure::Stage};

pub(super) struct NativeSourceProjection {
    pub(super) selection: AgentRuntimeSelectionV1,
    pub(super) authority: AgentCheckpointBindingAuthorityV1,
    pub(super) repair_record: Option<AgentRuntimeTransitionRecordV1>,
    pub(super) source_stopped: bool,
    pub(super) updated_at_ms: i64,
}

/// The caller holds the Agent operation lock through publication.
pub(super) async fn read(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    provider_id: &ProviderIdV1,
) -> Result<NativeSourceProjection, BackendDispatchError> {
    resolve(
        state,
        provider_id,
        crate::agent_runtime_projection::read_locked(state, agent_id)
            .await
            .map_err(|error| Stage::SourceObservation.unavailable(error))?,
    )
    .await
}

async fn resolve(
    state: &ServiceState,
    provider_id: &ProviderIdV1,
    observed: AgentRuntimeObservedV1,
) -> Result<NativeSourceProjection, BackendDispatchError> {
    let (selection, source_authority, repair_record, source_stopped, updated_at_ms) = match observed
    {
        AgentRuntimeObservedV1::Transitioning {
            transition,
            source_close,
        } if transition.state == AgentRuntimeTransitionStateV1::RepairRequired
            || transition.is_dormant() =>
        {
            let transition = *transition;
            let source_stopped = source_close.is_some() || transition.is_dormant();
            let selection = transition.intent.source.clone();
            let source_authority = transition.intent.source_authority.clone();
            let updated_at_ms = transition.updated_at_ms;
            (
                selection,
                source_authority,
                Some(transition),
                source_stopped,
                updated_at_ms,
            )
        }
        observed => {
            let source = observed
                .into_explicit_successor_source()
                .map_err(|_| conflict())?;
            let source_stopped = source.boundary.is_stopped();
            let stopped_transition = source.boundary.stopped_transition().cloned();
            let repair_record = match stopped_transition {
                Some(stopped) => {
                    let transition = state
                        .store
                        .agent_runtime_transition(&stopped.operation_id)
                        .await
                        .map_err(|error| Stage::SourceObservation.store_error(error))?
                        .ok_or_else(conflict)?;
                    if transition.state != AgentRuntimeTransitionStateV1::RepairRequired
                        || transition.journal_revision != stopped.journal_revision
                        || transition.intent.source != source.selection
                        || transition.intent.source_authority != source.authority
                    {
                        return Err(conflict());
                    }
                    Some(transition)
                }
                None => None,
            };
            let boundary_updated_at_ms = source
                .boundary
                .updated_at_ms(source.selection.updated_at_ms);
            let updated_at_ms = repair_record
                .as_ref()
                .map_or(boundary_updated_at_ms, |transition| {
                    boundary_updated_at_ms.max(transition.updated_at_ms)
                });
            (
                source.selection,
                source.authority,
                repair_record,
                source_stopped,
                updated_at_ms,
            )
        }
    };
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = source_authority else {
        return Err(conflict());
    };
    if selection.interaction_profile != AgentInteractionProfileV1::NativeCli
        || selection.provider_id != *provider_id
    {
        return Err(conflict());
    }
    Ok(NativeSourceProjection {
        selection,
        authority,
        repair_record,
        source_stopped,
        updated_at_ms,
    })
}
