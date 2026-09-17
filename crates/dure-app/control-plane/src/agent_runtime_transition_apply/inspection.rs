use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AgentRuntimeInspectObservationV1 {
    Unmanaged {
        schema_version: u16,
        agent_id: AgentIdV1,
    },
    Closed {
        schema_version: u16,
        agent_id: AgentIdV1,
        operation_id: OperationIdV1,
        stage: dure_app::AgentRuntimeCloseStateV1,
        source: AgentRuntimeSourceSnapshotV1,
    },
    Transitioning {
        schema_version: u16,
        agent_id: AgentIdV1,
        operation_id: OperationIdV1,
        stage: AgentRuntimeTransitionStateV1,
        journal_revision: i64,
        target_interaction_profile: AgentInteractionProfileV1,
        target_execution_profile: AgentExecutionProfileV1,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_failure: Option<AgentRuntimeTargetFailureV1>,
        #[serde(skip_serializing_if = "Option::is_none")]
        deferred_target: Option<dure_app::AgentRuntimeDeferredTargetV1>,
    },
    Stable {
        schema_version: u16,
        receipt: Box<AgentRuntimeTransitionApplyReceiptV1>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AgentRuntimeProjectionInspectObservationV1 {
    Unmanaged {
        schema_version: u16,
        agent_id: AgentIdV1,
    },
    Closed {
        schema_version: u16,
        agent_id: AgentIdV1,
        projection_context:
            Box<crate::agent_runtime_projection_context::AgentRuntimeProjectionContextV1>,
        operation_id: OperationIdV1,
        stage: dure_app::AgentRuntimeCloseStateV1,
        source: AgentRuntimeSourceSnapshotV1,
    },
    Transitioning {
        schema_version: u16,
        agent_id: AgentIdV1,
        projection_context:
            Box<crate::agent_runtime_projection_context::AgentRuntimeProjectionContextV1>,
        operation_id: OperationIdV1,
        stage: AgentRuntimeTransitionStateV1,
        journal_revision: i64,
        target_interaction_profile: AgentInteractionProfileV1,
        target_execution_profile: AgentExecutionProfileV1,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_failure: Option<AgentRuntimeTargetFailureV1>,
        #[serde(skip_serializing_if = "Option::is_none")]
        deferred_target: Option<dure_app::AgentRuntimeDeferredTargetV1>,
    },
    Stable {
        schema_version: u16,
        projection_context:
            Box<crate::agent_runtime_projection_context::AgentRuntimeProjectionContextV1>,
        receipt: Box<AgentRuntimeTransitionApplyReceiptV1>,
    },
}

/// Returns the committed runtime authority without probing or starting either
/// provider surface. Pane routing uses this snapshot to converge local
/// presentation after a response loss or desktop restart.
pub(crate) async fn inspect(
    state: &ServiceState,
    body: AgentRuntimeInspectBodyV1,
) -> Result<AgentRuntimeInspectObservationV1, String> {
    if body.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
        return Err("agent_runtime_inspect_request_invalid".into());
    }
    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    inspect_locked(state, body.agent_id).await
}

async fn inspect_locked(
    state: &ServiceState,
    agent_id: AgentIdV1,
) -> Result<AgentRuntimeInspectObservationV1, String> {
    match crate::agent_runtime_projection::read_locked(state, &agent_id).await? {
        crate::agent_runtime_projection::AgentRuntimeObservedV1::Unmanaged => {
            Ok(AgentRuntimeInspectObservationV1::Unmanaged {
                schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
                agent_id,
            })
        }
        crate::agent_runtime_projection::AgentRuntimeObservedV1::Closed(close) => {
            Ok(AgentRuntimeInspectObservationV1::Closed {
                schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
                agent_id,
                operation_id: close.intent.operation_id.clone(),
                stage: close.state,
                source: AgentRuntimeSourceSnapshotV1::from(&close.intent.source),
            })
        }
        crate::agent_runtime_projection::AgentRuntimeObservedV1::Transitioning {
            transition,
            ..
        } => Ok(AgentRuntimeInspectObservationV1::Transitioning {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id,
            operation_id: transition.intent.operation_id,
            stage: transition.state,
            journal_revision: transition.journal_revision,
            target_interaction_profile: transition.intent.target_interaction_profile,
            target_execution_profile: transition.intent.target_execution_profile,
            target_failure: transition.target_failure,
            deferred_target: transition.deferred_target,
        }),
        crate::agent_runtime_projection::AgentRuntimeObservedV1::Stable {
            selection,
            authority,
        } => Ok(AgentRuntimeInspectObservationV1::Stable {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            receipt: Box::new(stable_runtime_receipt(state, &selection, &authority).await?),
        }),
    }
}

pub(crate) async fn inspect_projection(
    state: &ServiceState,
    body: AgentRuntimeInspectBodyV1,
) -> Result<AgentRuntimeProjectionInspectObservationV1, String> {
    if body.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1 {
        return Err("agent_runtime_projection_inspect_request_invalid".into());
    }
    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    inspect_projection_locked(state, body.agent_id).await
}

pub(super) async fn inspect_projection_locked(
    state: &ServiceState,
    agent_id: AgentIdV1,
) -> Result<AgentRuntimeProjectionInspectObservationV1, String> {
    match inspect_locked(state, agent_id).await? {
        AgentRuntimeInspectObservationV1::Unmanaged {
            schema_version,
            agent_id,
        } => Ok(AgentRuntimeProjectionInspectObservationV1::Unmanaged {
            schema_version,
            agent_id,
        }),
        AgentRuntimeInspectObservationV1::Closed {
            schema_version,
            agent_id,
            operation_id,
            stage,
            source,
        } => Ok(AgentRuntimeProjectionInspectObservationV1::Closed {
            schema_version,
            projection_context: Box::new(
                crate::agent_runtime_projection_context::read_agent(state, &agent_id).await?,
            ),
            agent_id,
            operation_id,
            stage,
            source,
        }),
        AgentRuntimeInspectObservationV1::Transitioning {
            schema_version,
            agent_id,
            operation_id,
            stage,
            journal_revision,
            target_interaction_profile,
            target_execution_profile,
            target_failure,
            deferred_target,
        } => {
            let projection_context = Box::new(
                crate::agent_runtime_projection_context::read_agent(state, &agent_id).await?,
            );
            Ok(AgentRuntimeProjectionInspectObservationV1::Transitioning {
                schema_version,
                agent_id,
                projection_context,
                operation_id,
                stage,
                journal_revision,
                target_interaction_profile,
                target_execution_profile,
                target_failure,
                deferred_target,
            })
        }
        AgentRuntimeInspectObservationV1::Stable {
            schema_version,
            receipt,
        } => Ok(AgentRuntimeProjectionInspectObservationV1::Stable {
            schema_version,
            projection_context: Box::new(
                crate::agent_runtime_projection_context::read(
                    state,
                    &receipt.agent_id,
                    &receipt.provider_id,
                )
                .await?,
            ),
            receipt,
        }),
    }
}
