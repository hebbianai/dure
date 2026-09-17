use super::*;
use dure_app::{AgentRuntimeTransitionWakeRequestV1, authorize_agent_runtime_transition_wake_v1};

/// Binding writers consume the same journal authority as the recovery driver.
pub(crate) async fn ensure_target_activation_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    let transition = active_transition_on(connection, agent_id).await?;
    if transition
        .as_ref()
        .is_some_and(|record| record.target_is_deferred())
    {
        return Err(identity_conflict(
            "agent runtime transition",
            agent_id.as_str(),
            "a deferred replacement requires an explicit wake before binding publication",
        ));
    }
    Ok(transition)
}

pub(super) async fn authorize_wake(
    pool: &SqlitePool,
    request: &AgentRuntimeTransitionWakeRequestV1,
) -> Result<AgentRuntimeTransitionEffectAuthorizationV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("wake_agent_runtime_transition", error))?;
    begin_immediate(&mut connection, "wake_agent_runtime_transition").await?;
    let result = async {
        let current = transition_on(&mut connection, &request.operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent runtime transition",
                id: request.operation_id.as_str().into(),
            })?;
        let outcome = authorize_agent_runtime_transition_wake_v1(&current, request)?;
        if let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(next) = &outcome {
            ensure_transition_source_on(&mut connection, &current).await?;
            if selection_on(&mut connection, &current.intent.source.agent_id)
                .await?
                .as_ref()
                != Some(&current.intent.source)
            {
                return Err(identity_conflict(
                    "agent runtime selection",
                    current.intent.source.agent_id.as_str(),
                    "the deferred source selection changed before wake",
                ));
            }
            require_current_runtime_authority_on(
                &mut connection,
                &current.intent.source.agent_id,
                &current.intent.source_authority,
            )
            .await?;
            update_transition(&mut connection, &current, next).await?;
        }
        Ok(outcome)
    }
    .await;
    finish_transaction(&mut connection, "wake_agent_runtime_transition", result).await
}
