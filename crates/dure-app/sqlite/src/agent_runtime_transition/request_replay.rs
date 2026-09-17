use super::*;
use dure_app::{AgentRuntimeRequestOutcomeV1, AgentRuntimeRequestReceiptV1};

pub(crate) const CREATE_REQUEST_RECEIPTS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_runtime_transition_requests (
    idempotency_key TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    outcome_json TEXT NOT NULL
)
"#;

pub(crate) const MIGRATE_REQUEST_RECEIPTS: &[&str] = &[
    CREATE_REQUEST_RECEIPTS,
    r#"
    INSERT INTO agent_runtime_transition_requests
        (idempotency_key, agent_id, fingerprint, outcome_json)
    SELECT request.key, transition.agent_id, request.value,
           json_object('kind', 'transition', 'operationId', transition.operation_id)
    FROM agent_runtime_transitions AS transition,
         json_each(transition.record_json, '$.resumeRequests') AS request
    "#,
    r#"
    UPDATE agent_runtime_transitions
    SET record_json = json_remove(record_json, '$.resumeRequests')
    WHERE json_type(record_json, '$.resumeRequests') IS NOT NULL
    "#,
];

pub(crate) async fn receipt(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<AgentRuntimeRequestReceiptV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_runtime_request", error))?;
    receipt_on(&mut connection, key).await
}

async fn receipt_on(
    connection: &mut SqliteConnection,
    key: &str,
) -> Result<Option<AgentRuntimeRequestReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        "SELECT fingerprint, outcome_json FROM agent_runtime_transition_requests WHERE idempotency_key = ?1",
    )
    .bind(key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_request", error))?;
    row.map(|row| {
        let json: String = row
            .try_get("outcome_json")
            .map_err(|error| corrupt_row("agent_runtime_request", error))?;
        Ok(AgentRuntimeRequestReceiptV1 {
            fingerprint: row
                .try_get("fingerprint")
                .map_err(|error| corrupt_row("agent_runtime_request", error))?,
            outcome: serde_json::from_str(&json)
                .map_err(|error| serialization("agent_runtime_request", error))?,
        })
    })
    .transpose()
}

async fn insert(
    connection: &mut SqliteConnection,
    key: &str,
    agent_id: &AgentIdV1,
    receipt: &AgentRuntimeRequestReceiptV1,
) -> Result<(), DomainStoreErrorV1> {
    let json = serde_json::to_string(&receipt.outcome)
        .map_err(|error| serialization("agent_runtime_request", error))?;
    sqlx::query(
        "INSERT INTO agent_runtime_transition_requests (idempotency_key, agent_id, fingerprint, outcome_json) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(key)
    .bind(agent_id.as_str())
    .bind(&receipt.fingerprint)
    .bind(json)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("record_agent_runtime_request", error))?;
    Ok(())
}

fn conflict() -> DomainStoreErrorV1 {
    DomainStoreErrorV1::IdempotencyConflict {
        reason: "runtime request is already bound to another outcome".into(),
    }
}

/// Record observation-only success in the same transaction order as admission.
/// This never advances selection, acquires stop authority, or wakes recovery.
pub(crate) async fn unchanged(
    pool: &SqlitePool,
    key: &str,
    fingerprint: &str,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentRuntimeBindingAuthorityV1,
) -> Result<AgentRuntimeRequestReceiptV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("record_agent_runtime_unchanged_request", error))?;
    begin_immediate(&mut connection, "record_agent_runtime_unchanged_request").await?;
    let result = async {
        if let Some(existing) = receipt_on(&mut connection, key).await? {
            if existing.fingerprint != fingerprint
                || !matches!(
                    existing.outcome,
                    AgentRuntimeRequestOutcomeV1::Unchanged { .. }
                )
            {
                return Err(conflict());
            }
            return Ok(existing);
        }
        if transition_by_key_on(&mut connection, key).await?.is_some() {
            return Err(conflict());
        }
        authority.validate_for_selection(selection)?;
        if selection_on(&mut connection, &selection.agent_id)
            .await?
            .as_ref()
            != Some(selection)
            || active_transition_on(&mut connection, &selection.agent_id)
                .await?
                .is_some()
            || effective_close_for_agent_on(&mut connection, &selection.agent_id)
                .await?
                .is_some()
        {
            return Err(identity_conflict(
                "agent runtime selection",
                selection.agent_id.as_str(),
                "the unchanged request no longer observes an active stable selection",
            ));
        }
        require_current_runtime_authority_on(&mut connection, &selection.agent_id, authority)
            .await?;
        let receipt = AgentRuntimeRequestReceiptV1 {
            fingerprint: fingerprint.into(),
            outcome: AgentRuntimeRequestOutcomeV1::Unchanged {
                selection: Box::new(selection.clone()),
                authority: Box::new(authority.clone()),
            },
        };
        insert(&mut connection, key, &selection.agent_id, &receipt).await?;
        Ok(receipt)
    }
    .await;
    finish_transaction(
        &mut connection,
        "record_agent_runtime_unchanged_request",
        result,
    )
    .await
}

/// Bind a new request to an admitted intent once. Request replay observes the
/// journal; it does not authorize another drive or change the journal revision.
pub(crate) async fn resume(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
    request_key: &str,
    request_fingerprint: &str,
) -> Result<AgentRuntimeTransitionEffectAuthorizationV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("resume_agent_runtime_transition", error))?;
    begin_immediate(&mut connection, "resume_agent_runtime_transition").await?;
    let result = async {
        if let Some(receipt) = receipt_on(&mut connection, request_key).await? {
            if receipt.fingerprint != request_fingerprint
                || receipt.outcome
                    != (AgentRuntimeRequestOutcomeV1::Transition {
                        operation_id: operation_id.clone(),
                    })
            {
                return Err(conflict());
            }
            let current = transition_on(&mut connection, operation_id)
                .await?
                .ok_or_else(|| DomainStoreErrorV1::NotFound {
                    entity: "agent runtime transition",
                    id: operation_id.as_str().into(),
                })?;
            return Ok(AgentRuntimeTransitionEffectAuthorizationV1::Replayed(
                current,
            ));
        }
        if transition_by_key_on(&mut connection, request_key)
            .await?
            .is_some()
        {
            return Err(conflict());
        }
        let current = transition_on(&mut connection, operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent runtime transition",
                id: operation_id.as_str().into(),
            })?;
        ensure_transition_source_on(&mut connection, &current).await?;
        if current.state != AgentRuntimeTransitionStateV1::Admitted {
            return Err(identity_conflict(
                "agent runtime transition",
                operation_id.as_str(),
                "only an admitted intent may accept a resume request",
            ));
        }
        insert(
            &mut connection,
            request_key,
            &current.intent.source.agent_id,
            &AgentRuntimeRequestReceiptV1 {
                fingerprint: request_fingerprint.into(),
                outcome: AgentRuntimeRequestOutcomeV1::Transition {
                    operation_id: operation_id.clone(),
                },
            },
        )
        .await?;
        Ok(AgentRuntimeTransitionEffectAuthorizationV1::Authorized(
            current,
        ))
    }
    .await;
    finish_transaction(&mut connection, "resume_agent_runtime_transition", result).await
}

pub(super) async fn by_key(
    connection: &mut SqliteConnection,
    request_key: &str,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    match receipt_on(connection, request_key)
        .await?
        .map(|receipt| receipt.outcome)
    {
        Some(AgentRuntimeRequestOutcomeV1::Transition { operation_id }) => {
            transition_on(connection, &operation_id).await
        }
        Some(AgentRuntimeRequestOutcomeV1::Unchanged { .. }) => Err(conflict()),
        None => Ok(None),
    }
}
