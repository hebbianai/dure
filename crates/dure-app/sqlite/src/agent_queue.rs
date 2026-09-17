use dure_app::{
    AgentCancelQueuedTurnV1, AgentClientMessageIdV1, AgentIdV1, AgentInputReceiptV1,
    AgentInteractionBindingV1, AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1,
    AgentQueuedInputPageV1, AgentQueuedInputV1, AgentQueuedTurnRecordV1, AgentQueuedTurnStateV1,
    AgentQueuedTurnStore, AgentStartTurnIntentV1, AgentTimelineItemBodyV1,
    AgentTimelineItemDraftV1, AgentTimelineItemIdV1, AgentTurnEffectReceiptV1, DomainStoreErrorV1,
    DomainStoreFuture,
};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};

use crate::SqliteDomainStore;
use crate::agent_timeline::{
    active_turn_for_session, append_item_on, binding_on, pending_for_runtime,
    record_turn_intent_on, required_binding, timeline_cursor_on, turn_effect_on,
    validate_current_runtime,
};
use crate::error::{corrupt_identifier, map_sqlx, serialization};

pub(crate) const CREATE_QUEUE: &str = r#"
CREATE TABLE IF NOT EXISTS agent_queued_turns (
    interaction_session_id TEXT NOT NULL
        REFERENCES agent_interaction_sessions(interaction_session_id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    queued_sequence INTEGER NOT NULL CHECK (queued_sequence > 0),
    record_json TEXT NOT NULL,
    state TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.state')) VIRTUAL,
    PRIMARY KEY (interaction_session_id, client_message_id)
)
"#;
pub(crate) const QUEUED_ORDER: &str = "CREATE INDEX IF NOT EXISTS agent_queued_turns_pending \
    ON agent_queued_turns(interaction_session_id, state, queued_sequence)";

fn encode(record: &AgentQueuedTurnRecordV1) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(record).map_err(|error| serialization("queued agent input", error))
}

fn decode(source: &str) -> Result<AgentQueuedTurnRecordV1, DomainStoreErrorV1> {
    serde_json::from_str(source).map_err(|error| serialization("queued agent input", error))
}

fn conflict(id: &AgentClientMessageIdV1, reason: &str) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::IdentityConflict {
        entity: "agent_queued_turn",
        id: id.to_string(),
        reason: reason.into(),
    }
}

async fn receipt_on(
    connection: &mut SqliteConnection,
    session: &AgentInteractionSessionIdV1,
    message: &AgentClientMessageIdV1,
) -> Result<Option<AgentQueuedTurnRecordV1>, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM agent_queued_turns WHERE interaction_session_id = ?1 AND client_message_id = ?2",
    )
    .bind(session.as_str()).bind(message.as_str())
    .fetch_optional(&mut *connection).await.map_err(|error| map_sqlx("read_queued_turn", error))?
    .map(|source| decode(&source)).transpose()
}

pub(crate) async fn pending_on(
    connection: &mut SqliteConnection,
    session: &AgentInteractionSessionIdV1,
    after_sequence: i64,
) -> Result<AgentQueuedInputPageV1, DomainStoreErrorV1> {
    if after_sequence < 0 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "afterSequence",
            reason: "must be non-negative".into(),
        });
    }
    let rows = sqlx::query(
        "SELECT client_message_id, queued_sequence, substr(json_extract(record_json, '$.intent.input'), 1, 512) AS preview \
         FROM agent_queued_turns WHERE interaction_session_id = ?1 AND state = 'queued' AND queued_sequence > ?2 \
         ORDER BY queued_sequence LIMIT 65",
    )
    .bind(session.as_str()).bind(after_sequence).fetch_all(&mut *connection).await
    .map_err(|error| map_sqlx("read_queued_turns", error))?;
    let has_more = rows.len() > 64;
    let inputs = rows
        .into_iter()
        .take(64)
        .map(|row| {
            let id: String = row
                .try_get("client_message_id")
                .map_err(|error| map_sqlx("read_queued_turns", error))?;
            Ok(AgentQueuedInputV1 {
                client_message_id: AgentClientMessageIdV1::new(id)
                    .map_err(|error| corrupt_identifier("queued input", error))?,
                sequence: row
                    .try_get("queued_sequence")
                    .map_err(|error| map_sqlx("read_queued_turns", error))?,
                preview: row
                    .try_get("preview")
                    .map_err(|error| map_sqlx("read_queued_turns", error))?,
            })
        })
        .collect::<Result<Vec<_>, DomainStoreErrorV1>>()?;
    let next_after = has_more.then(|| inputs.last().expect("full queue page").sequence);
    Ok(AgentQueuedInputPageV1 {
        interaction_session_id: session.clone(),
        inputs,
        next_after,
    })
}

pub(crate) async fn has_pending_on(
    connection: &mut SqliteConnection,
    session: &AgentInteractionSessionIdV1,
) -> Result<bool, DomainStoreErrorV1> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_queued_turns WHERE interaction_session_id = ?1 AND state = 'queued')",
    ).bind(session.as_str()).fetch_one(&mut *connection).await
        .map_err(|error| map_sqlx("read_queued_turns", error))
}

pub(crate) async fn ensure_not_queued_on(
    connection: &mut SqliteConnection,
    intent: &AgentStartTurnIntentV1,
) -> Result<(), DomainStoreErrorV1> {
    if receipt_on(
        connection,
        &intent.interaction_session_id,
        &intent.client_message_id,
    )
    .await?
    .is_some_and(|record| record.state != AgentQueuedTurnStateV1::Dispatched)
    {
        return Err(conflict(
            &intent.client_message_id,
            "queued input must be claimed before execution",
        ));
    }
    Ok(())
}

async fn record_state_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
    intent: &AgentStartTurnIntentV1,
    state: AgentQueuedTurnStateV1,
    at_ms: i64,
) -> Result<AgentQueuedTurnRecordV1, DomainStoreErrorV1> {
    let token = match state {
        AgentQueuedTurnStateV1::Queued => "queued",
        AgentQueuedTurnStateV1::Dispatched => "dispatched",
        AgentQueuedTurnStateV1::Canceled => "canceled",
    };
    let identity = format!(
        "{}:{}",
        intent.interaction_session_id, intent.client_message_id
    );
    append_item_on(
        connection,
        binding,
        &AgentTimelineItemDraftV1 {
            item_id: AgentTimelineItemIdV1::new(format!(
                "input-{token}-{:x}",
                Sha256::digest(identity)
            ))
            .map_err(|error| corrupt_identifier("queued input identity", error))?,
            turn_id: Some(intent.turn_id.clone()),
            client_message_id: Some(intent.client_message_id.clone()),
            provider_message_id: None,
            body: AgentTimelineItemBodyV1::QueuedInput { state },
            created_at_ms: at_ms,
        },
    )
    .await?;
    let receipt = AgentQueuedTurnRecordV1 {
        intent: intent.clone(),
        state,
        timeline_cursor: timeline_cursor_on(connection, binding).await?,
    };
    sqlx::query(
        "INSERT INTO agent_queued_turns (interaction_session_id, client_message_id, queued_sequence, record_json) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(interaction_session_id, client_message_id) DO UPDATE SET record_json = excluded.record_json",
    ).bind(intent.interaction_session_id.as_str()).bind(intent.client_message_id.as_str())
        .bind(receipt.timeline_cursor.sequence).bind(encode(&receipt)?)
        .execute(&mut *connection).await.map_err(|error| map_sqlx("record_queued_turn", error))?;
    Ok(receipt)
}

impl AgentQueuedTurnStore for SqliteDomainStore {
    fn inspect_agent_input<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
        message: &'a AgentClientMessageIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentInputReceiptV1>> {
        Box::pin(async move {
            let mut tx = self
                .pool
                .begin()
                .await
                .map_err(|error| map_sqlx("inspect_agent_input", error))?;
            required_binding(&mut tx, session).await?;
            let receipt = if let Some(receipt) = receipt_on(&mut tx, session, message).await? {
                Some(AgentInputReceiptV1::Queued { receipt })
            } else {
                turn_effect_on(&mut tx, session, message)
                    .await?
                    .map(|receipt| AgentInputReceiptV1::Turn { receipt })
            };
            tx.commit()
                .await
                .map_err(|error| map_sqlx("inspect_agent_input", error))?;
            Ok(receipt)
        })
    }

    fn enqueue_agent_turn<'a>(
        &'a self,
        intent: &'a AgentStartTurnIntentV1,
    ) -> DomainStoreFuture<'a, AgentQueuedTurnRecordV1> {
        Box::pin(async move {
            intent.validate()?;
            let mut tx = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("enqueue_agent_turn", error))?;
            if let Some(receipt) = receipt_on(
                &mut tx,
                &intent.interaction_session_id,
                &intent.client_message_id,
            )
            .await?
            {
                if receipt.intent != *intent {
                    return Err(DomainStoreErrorV1::IdempotencyConflict {
                        reason: "queued input key has different input".into(),
                    });
                }
                return Ok(receipt);
            }
            let binding =
                validate_current_runtime(&mut tx, &intent.interaction_session_id, &intent.runtime)
                    .await?;
            crate::agent_runtime_close::ensure_open_on(&mut tx, &binding.agent_id).await?;
            let already_started: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_turn_effects WHERE interaction_session_id = ?1 AND client_message_id = ?2)")
                .bind(intent.interaction_session_id.as_str()).bind(intent.client_message_id.as_str())
                .fetch_one(&mut *tx).await.map_err(|error| map_sqlx("enqueue_agent_turn", error))?;
            if already_started {
                return Err(conflict(
                    &intent.client_message_id,
                    "this input already has a turn effect",
                ));
            }
            let receipt = record_state_on(
                &mut tx,
                &binding,
                intent,
                AgentQueuedTurnStateV1::Queued,
                intent.requested_at_ms,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|error| map_sqlx("enqueue_agent_turn", error))?;
            Ok(receipt)
        })
    }

    fn cancel_queued_agent_turn<'a>(
        &'a self,
        request: &'a AgentCancelQueuedTurnV1,
        at_ms: i64,
    ) -> DomainStoreFuture<'a, AgentQueuedTurnRecordV1> {
        Box::pin(async move {
            if request.schema_version != 1 || at_ms < 0 {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "request",
                    reason: "unsupported schema or invalid timestamp".into(),
                });
            }
            let mut tx = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("cancel_queued_turn", error))?;
            let receipt = receipt_on(
                &mut tx,
                &request.interaction_session_id,
                &request.client_message_id,
            )
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent_queued_turn",
                id: request.client_message_id.to_string(),
            })?;
            match receipt.state {
                AgentQueuedTurnStateV1::Canceled => return Ok(receipt),
                AgentQueuedTurnStateV1::Dispatched => {
                    return Err(conflict(
                        &request.client_message_id,
                        "the input has already been dispatched",
                    ));
                }
                AgentQueuedTurnStateV1::Queued => {}
            }
            let binding = binding_on(&mut tx, &request.interaction_session_id)
                .await?
                .ok_or_else(|| DomainStoreErrorV1::NotFound {
                    entity: "agent_interaction",
                    id: request.interaction_session_id.to_string(),
                })?;
            let result = record_state_on(
                &mut tx,
                &binding,
                &receipt.intent,
                AgentQueuedTurnStateV1::Canceled,
                at_ms,
            )
            .await?;
            tx.commit()
                .await
                .map_err(|error| map_sqlx("cancel_queued_turn", error))?;
            Ok(result)
        })
    }

    fn read_queued_agent_turns<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
        after_sequence: i64,
    ) -> DomainStoreFuture<'a, AgentQueuedInputPageV1> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .begin()
                .await
                .map_err(|error| map_sqlx("read_queued_turns", error))?;
            required_binding(&mut connection, session).await?;
            let page = pending_on(&mut connection, session, after_sequence).await?;
            connection
                .commit()
                .await
                .map_err(|error| map_sqlx("read_queued_turns", error))?;
            Ok(page)
        })
    }

    fn agents_with_queued_turns(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>> {
        Box::pin(async move {
            sqlx::query_scalar::<_, String>("SELECT DISTINCT session.agent_id FROM agent_queued_turns AS queued JOIN agent_interaction_sessions AS session USING (interaction_session_id) WHERE queued.state = 'queued' ORDER BY session.agent_id")
                .fetch_all(&self.pool).await.map_err(|error| map_sqlx("read_queued_agents", error))?
                .into_iter().map(|id| AgentIdV1::new(id).map_err(|error| corrupt_identifier("queued agent", error))).collect()
        })
    }

    fn has_queued_agent_turns<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
    ) -> DomainStoreFuture<'a, bool> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| map_sqlx("read_queued_turns", error))?;
            has_pending_on(&mut connection, session).await
        })
    }

    fn prepare_queued_agent_turn<'a>(
        &'a self,
        session: &'a AgentInteractionSessionIdV1,
        runtime: &'a AgentProviderRuntimeFenceV1,
        dispatched_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentTurnEffectReceiptV1>> {
        Box::pin(async move {
            let mut tx = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("prepare_queued_turn", error))?;
            let binding = validate_current_runtime(&mut tx, session, runtime).await?;
            if active_turn_for_session(&mut tx, &binding).await?.is_some()
                || !pending_for_runtime(&mut tx, session, runtime)
                    .await?
                    .is_empty()
            {
                return Ok(None);
            }
            let source: Option<String> = sqlx::query_scalar("SELECT record_json FROM agent_queued_turns WHERE interaction_session_id = ?1 AND state = 'queued' ORDER BY queued_sequence LIMIT 1")
                .bind(session.as_str()).fetch_optional(&mut *tx).await.map_err(|error| map_sqlx("claim_queued_turn", error))?;
            let Some(source) = source else {
                return Ok(None);
            };
            let queued = decode(&source)?;
            record_state_on(
                &mut tx,
                &binding,
                &queued.intent,
                AgentQueuedTurnStateV1::Dispatched,
                dispatched_at_ms,
            )
            .await?;
            let intent = AgentStartTurnIntentV1 {
                runtime: binding.runtime,
                requested_at_ms: dispatched_at_ms,
                ..queued.intent
            };
            let prepared = record_turn_intent_on(&mut tx, &intent).await?;
            tx.commit()
                .await
                .map_err(|error| map_sqlx("prepare_queued_turn", error))?;
            Ok(Some(prepared))
        })
    }
}
