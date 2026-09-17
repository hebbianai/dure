use dure_app::{
    AgentIdV1, AgentInteractionProfileV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeCloseRecordV1, AgentRuntimeCloseStateV1, AgentRuntimeCloseStoppedTransitionV1,
    AgentRuntimeCloseStore, AgentRuntimeLaunchSelectionV1, AgentRuntimeSelectionV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStore, AgentTimelineStore, DomainStore,
};
use serde::Serialize;

use crate::ServiceState;

pub(super) enum AgentRuntimeObservedV1 {
    Unmanaged,
    Closed(Box<AgentRuntimeCloseRecordV1>),
    Transitioning {
        transition: Box<AgentRuntimeTransitionRecordV1>,
        source_close: Option<Box<AgentRuntimeCloseRecordV1>>,
    },
    Stable {
        selection: Box<AgentRuntimeSelectionV1>,
        authority: Box<AgentRuntimeBindingAuthorityV1>,
    },
}

pub(super) enum AgentRuntimeSourceBoundaryV1 {
    Active,
    Stopped {
        stopped_at_ms: i64,
        stopped_transition: Option<AgentRuntimeCloseStoppedTransitionV1>,
    },
}

impl AgentRuntimeSourceBoundaryV1 {
    pub(super) fn is_stopped(&self) -> bool {
        matches!(self, Self::Stopped { .. })
    }

    pub(super) fn updated_at_ms(&self, active_at_ms: i64) -> i64 {
        match self {
            Self::Active => active_at_ms,
            Self::Stopped { stopped_at_ms, .. } => *stopped_at_ms,
        }
    }

    pub(super) fn stopped_transition(&self) -> Option<&AgentRuntimeCloseStoppedTransitionV1> {
        match self {
            Self::Active => None,
            Self::Stopped {
                stopped_transition, ..
            } => stopped_transition.as_ref(),
        }
    }
}

pub(super) struct AgentRuntimeSuccessorSourceV1 {
    pub(super) selection: AgentRuntimeSelectionV1,
    pub(super) authority: AgentRuntimeBindingAuthorityV1,
    pub(super) boundary: AgentRuntimeSourceBoundaryV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentRuntimeSourceSnapshotV1 {
    selection_revision: i64,
    interaction_profile: AgentInteractionProfileV1,
    launch_selection: AgentRuntimeLaunchSelectionV1,
}

impl From<&AgentRuntimeSelectionV1> for AgentRuntimeSourceSnapshotV1 {
    fn from(source: &AgentRuntimeSelectionV1) -> Self {
        Self {
            selection_revision: source.revision,
            interaction_profile: source.interaction_profile,
            launch_selection: AgentRuntimeLaunchSelectionV1 {
                model: source.model.clone(),
                effort: source.effort.clone(),
                permission_mode: Some(source.permission_mode.clone()),
            },
        }
    }
}

impl AgentRuntimeObservedV1 {
    /// Converts only a stable runtime or an exact terminal stop into the source
    /// of a user-requested successor. Admission still owns destructive fences.
    pub(super) fn into_explicit_successor_source(
        self,
    ) -> Result<AgentRuntimeSuccessorSourceV1, Self> {
        match self {
            Self::Stable {
                selection,
                authority,
            } => Ok(AgentRuntimeSuccessorSourceV1 {
                selection: *selection,
                authority: *authority,
                boundary: AgentRuntimeSourceBoundaryV1::Active,
            }),
            Self::Closed(close) if close.state == AgentRuntimeCloseStateV1::Stopped => {
                let close = *close;
                Ok(AgentRuntimeSuccessorSourceV1 {
                    selection: close.intent.source,
                    authority: close.intent.source_authority,
                    boundary: AgentRuntimeSourceBoundaryV1::Stopped {
                        stopped_at_ms: close.updated_at_ms,
                        stopped_transition: close.intent.stopped_transition,
                    },
                })
            }
            observed => Err(observed),
        }
    }
}

/// Reads the newest durable runtime state for an Agent. A transition that
/// explicitly follows a stopped close carries that close as its source
/// boundary; otherwise the close remains the latest state.
pub(super) async fn read_locked(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<AgentRuntimeObservedV1, String> {
    let close = state
        .store
        .effective_agent_runtime_close(agent_id)
        .await
        .map_err(|_| "agent_runtime_observation_store_failed".to_string())?;
    let transition = state
        .store
        .active_agent_runtime_transition(agent_id)
        .await
        .map_err(|_| "agent_runtime_observation_store_failed".to_string())?;
    match (close, transition) {
        (Some(close), Some(transition)) => {
            if !state
                .store
                .agent_runtime_transition_follows_close(
                    &transition.intent.operation_id,
                    &close.intent.operation_id,
                )
                .await
                .map_err(|_| "agent_runtime_observation_store_failed".to_string())?
            {
                return Ok(AgentRuntimeObservedV1::Closed(Box::new(close)));
            }
            return Ok(AgentRuntimeObservedV1::Transitioning {
                transition: Box::new(transition),
                source_close: Some(Box::new(close)),
            });
        }
        (Some(close), _) => return Ok(AgentRuntimeObservedV1::Closed(Box::new(close))),
        (None, Some(transition)) => {
            return Ok(AgentRuntimeObservedV1::Transitioning {
                transition: Box::new(transition),
                source_close: None,
            });
        }
        (None, None) => {}
    }
    let Some(selection) = state
        .store
        .agent_runtime_selection(agent_id)
        .await
        .map_err(|_| "agent_runtime_observation_store_failed".to_string())?
    else {
        return Ok(AgentRuntimeObservedV1::Unmanaged);
    };
    let authority = match selection.interaction_profile {
        dure_app::AgentInteractionProfileV1::NativeCli => {
            let authority = state
                .store
                .agent_checkpoint_binding_authority(agent_id)
                .await
                .map_err(|_| "agent_runtime_observation_store_failed".to_string())?
                .ok_or_else(|| "agent_runtime_observation_authority_unavailable".to_string())?;
            AgentRuntimeBindingAuthorityV1::NativeCli { authority }
        }
        dure_app::AgentInteractionProfileV1::StructuredProtocol => {
            let binding = state
                .store
                .agent_interaction_for_agent(agent_id)
                .await
                .map_err(|_| "agent_runtime_observation_store_failed".to_string())?
                .ok_or_else(|| "agent_runtime_observation_authority_unavailable".to_string())?;
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding }
        }
    };
    authority
        .validate_for_selection(&selection)
        .map_err(|_| "agent_runtime_observation_authority_stale".to_string())?;
    Ok(AgentRuntimeObservedV1::Stable {
        selection: Box::new(selection),
        authority: Box::new(authority),
    })
}
