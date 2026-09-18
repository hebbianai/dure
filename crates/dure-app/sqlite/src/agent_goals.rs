use dure_app::{
    AgentGoalPutRequestV1, AgentGoalRecordV1, AgentGoalStatusV1, AgentGoalStore,
    AgentGoalTurnRequestV1, AgentIdV1, AgentTurnEffectReceiptV1, DomainStoreErrorV1,
    DomainStoreFuture,
};
use sqlx::{Row, SqliteConnection};

use crate::SqliteDomainStore;
use crate::agent_timeline::{
    automatic_turn_ready_on, binding_for_agent_on, record_goal_turn_intent_on,
    timeline_cursor_on,
};
use crate::error::{corrupt_row, map_sqlx, serialization};

pub(crate) const CREATE_GOALS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_goals (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    record_json TEXT NOT NULL,
    status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.status')) VIRTUAL
)
"#;
pub(crate) const ACTIVE_GOALS: &str =
    "CREATE INDEX IF NOT EXISTS agent_goals_active ON agent_goals(status, agent_id)";
pub(crate) const CREATE_MUTATIONS: &str = r#"
CREATE TABLE IF NOT EXISTS agent_goal_mutations (
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (agent_id, idempotency_key)
)
"#;

fn encode<T: serde::Serialize>(value: &T) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(value).map_err(|error| serialization("agent goal", error))
}

fn decode(source: &str) -> Result<AgentGoalRecordV1, DomainStoreErrorV1> {
    serde_json::from_str(source).map_err(|error| serialization("agent goal record", error))
}

fn conflict(agent_id: &AgentIdV1, reason: &str) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::IdentityConflict {
        entity: "agent_goal",
        id: agent_id.to_string(),
        reason: reason.into(),
    }
}

pub(crate) async fn read_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentGoalRecordV1>, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, String>("SELECT record_json FROM agent_goals WHERE agent_id = ?1")
        .bind(agent_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_agent_goal", error))?
        .map(|source| decode(&source))
        .transpose()
}

async fn save_on(
    connection: &mut SqliteConnection,
    record: &AgentGoalRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        "INSERT INTO agent_goals (agent_id, record_json) VALUES (?1, ?2) \
        ON CONFLICT(agent_id) DO UPDATE SET record_json = excluded.record_json",
    )
    .bind(record.agent_id.as_str())
    .bind(encode(record)?)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("write_agent_goal", error))?;
    Ok(())
}

async fn put_on(
    connection: &mut SqliteConnection,
    request: &AgentGoalPutRequestV1,
    observed_at_ms: i64,
) -> Result<AgentGoalRecordV1, DomainStoreErrorV1> {
    let source = encode(request)?;
    if let Some(row) = sqlx::query(
        "SELECT request_json, record_json FROM agent_goal_mutations \
        WHERE agent_id = ?1 AND idempotency_key = ?2",
    )
    .bind(request.agent_id.as_str())
    .bind(&request.idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_goal_mutation", error))?
    {
        let previous: String = row
            .try_get("request_json")
            .map_err(|error| corrupt_row("agent_goal_mutations", error))?;
        if previous != source {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: "goal request key has different input".into(),
            });
        }
        return decode(
            &row.try_get::<String, _>("record_json")
                .map_err(|error| corrupt_row("agent_goal_mutations", error))?,
        );
    }
    let current = read_on(connection, &request.agent_id).await?;
    if current.as_ref().map_or(0, |goal| goal.revision) != request.expected_revision {
        return Err(conflict(&request.agent_id, "goal revision changed"));
    }
    let binding = binding_for_agent_on(connection, &request.agent_id)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "agent_interaction",
            id: request.agent_id.to_string(),
        })?;
    let record = AgentGoalRecordV1 {
        schema_version: request.schema_version,
        agent_id: request.agent_id.clone(),
        revision: next_revision(request.expected_revision)?,
        objective: request.objective.clone(),
        status: request.status,
        detail: request.detail.clone(),
        activation_cursor: timeline_cursor_on(connection, &binding).await?,
        created_at_ms: current
            .as_ref()
            .map_or(observed_at_ms, |goal| goal.created_at_ms),
        updated_at_ms: current.as_ref().map_or(observed_at_ms, |goal| {
            observed_at_ms.max(goal.updated_at_ms)
        }),
    };
    save_on(connection, &record).await?;
    sqlx::query("INSERT INTO agent_goal_mutations (agent_id, idempotency_key, request_json, record_json) VALUES (?1, ?2, ?3, ?4)")
        .bind(request.agent_id.as_str()).bind(&request.idempotency_key).bind(source).bind(encode(&record)?)
        .execute(&mut *connection).await.map_err(|error| map_sqlx("record_agent_goal_mutation", error))?;
    Ok(record)
}

fn next_revision(revision: u64) -> Result<u64, DomainStoreErrorV1> {
    revision
        .checked_add(1)
        .filter(|next| *next <= i64::MAX as u64)
        .ok_or_else(|| DomainStoreErrorV1::InvalidRecord {
            field: "revision",
            reason: "goal revision exhausted".into(),
        })
}

async fn settle_on(
    connection: &mut SqliteConnection,
    mut goal: AgentGoalRecordV1,
    status: AgentGoalStatusV1,
    detail: &str,
    observed_at_ms: i64,
) -> Result<AgentGoalRecordV1, DomainStoreErrorV1> {
    goal.revision = next_revision(goal.revision)?;
    goal.status = status;
    goal.detail = Some(detail.into());
    goal.updated_at_ms = observed_at_ms.max(goal.updated_at_ms);
    save_on(connection, &goal).await?;
    Ok(goal)
}

async fn prepare_on(
    connection: &mut SqliteConnection,
    request: &AgentGoalTurnRequestV1,
) -> Result<Option<AgentTurnEffectReceiptV1>, DomainStoreErrorV1> {
    let Some(goal) = read_on(connection, &request.agent_id).await? else {
        return Ok(None);
    };
    if goal.status != AgentGoalStatusV1::Active || goal.revision != request.goal_revision {
        return Ok(None);
    }
    let binding = binding_for_agent_on(connection, &request.agent_id)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "agent_interaction",
            id: request.agent_id.to_string(),
        })?;
    if binding.interaction_session_id != request.intent.interaction_session_id {
        return Err(conflict(
            &request.agent_id,
            "goal continuation belongs to another conversation",
        ));
    }
    if timeline_cursor_on(connection, &binding).await? != request.expected_cursor {
        return Ok(None);
    }
    if goal.activation_cursor.epoch != binding.timeline_epoch {
        settle_on(
            connection,
            goal,
            AgentGoalStatusV1::Paused,
            "conversation_changed",
            request.intent.requested_at_ms,
        )
        .await?;
        return Ok(None);
    }
    // A later ready/success event cannot hide a failure that has not been
    // followed by an explicit goal resume or an accepted recovery of that
    // exact failed input. This also covers a missed broadcast.
    let failure = sqlx::query_scalar::<_, String>("SELECT CASE json_extract(body_json, '$.type') \
        WHEN 'tool' THEN 'tool_' || json_extract(body_json, '$.state') \
        ELSE json_extract(body_json, '$.state') END FROM agent_timeline_rows AS failure \
        WHERE interaction_session_id = ?1 AND timeline_epoch = ?2 AND sequence > ?3 \
        AND ((json_extract(body_json, '$.type') = 'lifecycle' \
        AND json_extract(body_json, '$.state') IN ('turn_failed', 'turn_canceled', 'session_failed', 'session_exited')) \
        OR (json_extract(body_json, '$.type') = 'tool' \
        AND json_extract(body_json, '$.state') IN ('failed', 'canceled'))) \
        AND NOT EXISTS (SELECT 1 FROM agent_recoveries AS recovery \
            JOIN agent_turn_effects AS effect \
              ON effect.interaction_session_id = failure.interaction_session_id \
             AND effect.client_message_id = json_extract(recovery.record_json, '$.continuation.intent.clientMessageId') \
            WHERE json_extract(recovery.record_json, '$.source.interactionSessionId') = failure.interaction_session_id \
              AND json_extract(recovery.record_json, '$.failure.itemId') = failure.item_id \
              AND effect.state = 'accepted') \
        ORDER BY sequence DESC LIMIT 1")
        .bind(binding.interaction_session_id.as_str()).bind(binding.timeline_epoch.as_str())
        .bind(goal.activation_cursor.sequence).fetch_optional(&mut *connection).await
        .map_err(|error| map_sqlx("read_goal_terminal_boundary", error))?;
    if let Some(reason) = failure {
        let status = if matches!(reason.as_str(), "turn_canceled" | "tool_canceled") {
            AgentGoalStatusV1::Paused
        } else {
            AgentGoalStatusV1::Failed
        };
        settle_on(
            connection,
            goal,
            status,
            &reason,
            request.intent.requested_at_ms,
        )
        .await?;
        return Ok(None);
    }
    if !automatic_turn_ready_on(connection, &binding).await? {
        return Ok(None);
    }
    record_goal_turn_intent_on(connection, &request.intent, &goal.objective, goal.revision)
        .await
        .map(Some)
}

impl AgentGoalStore for SqliteDomainStore {
    fn agent_goal<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentGoalRecordV1>> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| map_sqlx("read_agent_goal", error))?;
            read_on(&mut connection, agent_id).await
        })
    }

    fn put_agent_goal<'a>(
        &'a self,
        request: &'a AgentGoalPutRequestV1,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, AgentGoalRecordV1> {
        Box::pin(async move {
            request.validate()?;
            if observed_at_ms < 0 {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "observedAtMs",
                    reason: "must be nonnegative".into(),
                });
            }
            let mut connection = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("put_agent_goal", error))?;
            let result = put_on(&mut connection, request, observed_at_ms).await?;
            connection
                .commit()
                .await
                .map_err(|error| map_sqlx("put_agent_goal", error))?;
            Ok(result)
        })
    }

    fn active_agent_goals(&self) -> DomainStoreFuture<'_, Vec<AgentGoalRecordV1>> {
        Box::pin(async move {
            sqlx::query_scalar::<_, String>(
                "SELECT record_json FROM agent_goals WHERE status = 'active' ORDER BY agent_id",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(|error| map_sqlx("read_active_agent_goals", error))?
            .iter()
            .map(|source| decode(source))
            .collect()
        })
    }

    fn prepare_agent_goal_turn<'a>(
        &'a self,
        request: &'a AgentGoalTurnRequestV1,
    ) -> DomainStoreFuture<'a, Option<AgentTurnEffectReceiptV1>> {
        Box::pin(async move {
            request.intent.validate()?;
            request.expected_cursor.validate()?;
            let mut connection = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("prepare_agent_goal_turn", error))?;
            let result = prepare_on(&mut connection, request).await?;
            connection
                .commit()
                .await
                .map_err(|error| map_sqlx("prepare_agent_goal_turn", error))?;
            Ok(result)
        })
    }

    fn fail_agent_goal<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
        expected_revision: u64,
        detail: &'a str,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentGoalRecordV1>> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("fail_agent_goal", error))?;
            let result = async {
                let Some(goal) = read_on(&mut connection, agent_id).await? else {
                    return Ok(None);
                };
                if goal.revision != expected_revision || goal.status != AgentGoalStatusV1::Active {
                    return Ok(None);
                }
                settle_on(
                    &mut connection,
                    goal,
                    AgentGoalStatusV1::Failed,
                    detail,
                    observed_at_ms,
                )
                .await
                .map(Some)
            }
            .await?;
            connection
                .commit()
                .await
                .map_err(|error| map_sqlx("fail_agent_goal", error))?;
            Ok(result)
        })
    }
}
