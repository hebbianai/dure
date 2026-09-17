use super::*;

pub(crate) async fn admit(
    pool: &SqlitePool,
    intent: &AgentRuntimeTransitionIntentV1,
    deferred: bool,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("admit_agent_runtime_transition", error))?;
    begin_immediate(&mut connection, "admit_agent_runtime_transition").await?;
    let result = async {
        let by_operation = transition_on(&mut connection, &intent.operation_id).await?;
        let by_key = transition_by_key_on(&mut connection, &intent.idempotency_key).await?;
        if by_operation.is_some() || by_key.is_some() {
            let record = replay_admission(intent, by_operation, by_key)?;
            if record.deferred_target.is_some() != deferred {
                return Err(identity_conflict(
                    "agent runtime transition",
                    intent.operation_id.as_str(),
                    "request changed the admitted target activation policy",
                ));
            }
            return Ok(record);
        }

        require_agent_provider(&mut connection, &intent.source).await?;
        let selected = selection_on(&mut connection, &intent.source.agent_id).await?;
        if selected.as_ref() != Some(&intent.source) {
            return Err(identity_conflict(
                "agent runtime selection",
                intent.source.agent_id.as_str(),
                "the admitted source is not the active selection",
            ));
        }
        require_current_runtime_authority_on(
            &mut connection,
            &intent.source.agent_id,
            &intent.source_authority,
        )
        .await?;
        if let Some(active) = active_transition_on(&mut connection, &intent.source.agent_id).await?
        {
            return Err(identity_conflict(
                "agent runtime transition",
                intent.source.agent_id.as_str(),
                format!("operation {} is already active", active.intent.operation_id),
            ));
        }
        let admitted = match effective_close_for_agent_on(&mut connection, &intent.source.agent_id)
            .await?
        {
            Some(close) => {
                if deferred {
                    return Err(identity_conflict(
                        "agent runtime transition",
                        intent.operation_id.as_str(),
                        "a closed source cannot be admitted for hibernation",
                    ));
                }
                ensure_runtime_successor_source_on(
                    &mut connection,
                    &intent.source,
                    &intent.source_authority,
                    &intent.operation_id,
                    intent.requested_at_ms,
                )
                .await?;
                AgentRuntimeTransitionRecordV1::after_stopped_source(
                    intent.clone(),
                    close.intent.operation_id,
                )?
            }
            None if deferred => AgentRuntimeTransitionRecordV1::admitted_deferred(intent.clone())?,
            None => AgentRuntimeTransitionRecordV1::admitted(intent.clone())?,
        };
        insert_transition(&mut connection, &admitted).await?;
        Ok(admitted)
    }
    .await;
    finish_transaction(&mut connection, "admit_agent_runtime_transition", result).await
}
