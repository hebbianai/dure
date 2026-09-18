use dure_app::{
    AgentClientMessageIdV1, AgentContinueTurnRequestV1, AgentIdV1, AgentInteractionProfileV1,
    AgentRecoveryRecordV1, AgentRecoveryStopV1, AgentRecoveryStore, AgentStartTurnIntentV1,
    AgentTurnEffectReceiptV1, AgentTurnFailureReasonV1, AgentTurnIdV1, DomainStoreErrorV1,
    DomainStoreFuture, agent_runtime_transition_identity,
};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

use crate::SqliteDomainStore;
use crate::agent_timeline::{
    active_turn_for_session, binding_for_agent_on, latest_failure_on, pending_for_runtime,
    prepare_continuation_on, prepare_continuation_with_goal_on, timeline_cursor_on,
};
use crate::error::{corrupt_identifier, map_sqlx, serialization};

pub(crate) const CREATE_RECOVERIES: &str = r#"
CREATE TABLE IF NOT EXISTS agent_recoveries (
    attempt_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    record_json TEXT NOT NULL
)
"#;
pub(crate) const RECOVERY_BY_AGENT: &str =
    "CREATE INDEX IF NOT EXISTS agent_recoveries_agent ON agent_recoveries(agent_id)";

fn encode<T: serde::Serialize>(value: &T) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(value).map_err(|error| serialization("agent recovery", error))
}

fn decode(source: &str) -> Result<AgentRecoveryRecordV1, DomainStoreErrorV1> {
    serde_json::from_str(source).map_err(|error| serialization("agent recovery", error))
}

async fn read_on(
    connection: &mut SqliteConnection,
    attempt_id: &str,
) -> Result<Option<AgentRecoveryRecordV1>, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM agent_recoveries WHERE attempt_id = ?1",
    )
    .bind(attempt_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_recovery", error))?
    .map(|source| decode(&source))
    .transpose()
}

async fn save_on(
    connection: &mut SqliteConnection,
    record: &AgentRecoveryRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        "INSERT INTO agent_recoveries (attempt_id, agent_id, record_json) VALUES (?1, ?2, ?3) \
        ON CONFLICT(attempt_id) DO UPDATE SET record_json = excluded.record_json",
    )
    .bind(&record.attempt_id)
    .bind(record.source.agent_id.as_str())
    .bind(encode(record)?)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("save_agent_recovery", error))?;
    Ok(())
}

async fn prepare_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
    observed_at_ms: i64,
) -> Result<Option<AgentRecoveryRecordV1>, DomainStoreErrorV1> {
    // Resume the saved intent even if runtime replacement is incomplete. The
    // runtime journal, rather than a new failure observation, owns that effect.
    if let Some(source) = sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM agent_recoveries \
        WHERE agent_id = ?1 AND json_extract(record_json, '$.stopped') IS NULL \
        AND json_extract(record_json, '$.continuation') IS NULL LIMIT 1",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_pending_agent_recovery", error))?
    {
        return decode(&source).map(Some);
    }
    let Some(source) = binding_for_agent_on(connection, agent_id).await? else {
        return Ok(None);
    };
    let Some(failure) = latest_failure_on(connection, &source).await? else {
        return Ok(None);
    };
    if !matches!(
        failure.reason,
        AgentTurnFailureReasonV1::UsageLimit | AgentTurnFailureReasonV1::RateLimit
    ) {
        return Ok(None);
    }
    // Canonical timeline identity survives account replacement. A repeated
    // notification or backend restart cannot create a second attempt.
    let identity = encode(&(
        &source.interaction_session_id,
        &source.timeline_epoch,
        &failure.item_id,
    ))?;
    let attempt_id = format!("recovery-{:x}", Sha256::digest(identity.as_bytes()));
    if let Some(record) = read_on(connection, &attempt_id).await? {
        return Ok(Some(record));
    }
    let Some(policy) = crate::provider_recovery::read_on(connection, &source.provider_id).await?
    else {
        return Ok(None);
    };
    if !policy.enabled
        || policy
            .activated_at_ms
            .is_none_or(|at| failure.created_at_ms < at)
        || !source.history_complete
        || active_turn_for_session(connection, &source)
            .await?
            .is_some()
        || !pending_for_runtime(connection, &source.interaction_session_id, &source.runtime)
            .await?
            .is_empty()
        || !crate::agent_runtime_close::is_open_on(connection, agent_id).await?
        || crate::agent_runtime_transition::active_transition_on(connection, agent_id)
            .await?
            .is_some()
    {
        return Ok(None);
    }
    let Some(selection) =
        crate::agent_runtime_transition::selection_on(connection, agent_id).await?
    else {
        return Ok(None);
    };
    if selection.interaction_profile != AgentInteractionProfileV1::StructuredProtocol
        || selection.provider_id != source.provider_id
        || selection.execution_profile != source.execution_profile
    {
        return Ok(None);
    }
    let input = match &failure.user_input {
        Some(input) => Some(input.clone()),
        // Goal continuations deliberately have no human-message row. Retain
        // their original admitted input from the same turn-effect journal.
        None => sqlx::query_scalar::<_, String>("SELECT json_extract(effects.intent_json, '$.input') FROM agent_timeline_rows AS failed \
            JOIN agent_turn_effects AS effects ON effects.interaction_session_id = failed.interaction_session_id \
            AND (effects.client_message_id = failed.client_message_id OR effects.turn_id = failed.turn_id) \
            WHERE failed.interaction_session_id = ?1 AND failed.item_id = ?2 \
            ORDER BY effects.timeline_sequence DESC LIMIT 1")
            .bind(source.interaction_session_id.as_str()).bind(failure.item_id.as_str())
            .fetch_optional(&mut *connection).await.map_err(|error| map_sqlx("read_recovery_input", error))?,
    };
    let Some(input) = input else { return Ok(None) };
    let is_goal_continuation = failure.user_input.is_none() && sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM agent_timeline_rows AS failed \
        JOIN agent_timeline_rows AS original ON original.interaction_session_id = failed.interaction_session_id \
        AND (original.client_message_id = failed.client_message_id OR original.turn_id = failed.turn_id) \
        WHERE failed.interaction_session_id = ?1 AND failed.item_id = ?2 \
        AND json_extract(original.body_json, '$.type') = 'goal_continuation')")
        .bind(source.interaction_session_id.as_str()).bind(failure.item_id.as_str())
        .fetch_one(&mut *connection).await.map_err(|error| map_sqlx("read_recovery_input_origin", error))?;
    crate::provider_recovery_usage::report_limit_on(
        connection,
        &source.provider_id,
        &source.execution_profile,
        failure.created_at_ms,
    )
    .await?;
    let target = crate::provider_recovery_usage::select_on(
        connection,
        &policy.accounts,
        &source.execution_profile,
        observed_at_ms,
    )
    .await?;
    let goal = crate::agent_goals::read_on(connection, agent_id).await?;
    if is_goal_continuation
        && goal
            .as_ref()
            .is_none_or(|goal| goal.status != dure_app::AgentGoalStatusV1::Active)
    {
        return Ok(None);
    }
    let goal_revision = goal.map(|goal| goal.revision);
    let record = AgentRecoveryRecordV1 {
        schema_version: 1,
        attempt_id,
        source,
        source_selection_revision: selection.revision,
        failure,
        input,
        is_goal_continuation,
        goal_revision,
        policy_revision: policy.revision,
        stopped: target.is_none().then_some(AgentRecoveryStopV1::Exhausted),
        target,
        continuation: None,
        created_at_ms: observed_at_ms,
    };
    save_on(connection, &record).await?;
    Ok(Some(record))
}

async fn prepare_turn_on(
    connection: &mut SqliteConnection,
    attempt_id: &str,
    observed_at_ms: i64,
) -> Result<Option<AgentTurnEffectReceiptV1>, DomainStoreErrorV1> {
    let Some(mut record) = read_on(connection, attempt_id).await? else {
        return Ok(None);
    };
    if let Some(request) = &record.continuation {
        return prepare_continuation_on(connection, request).await;
    }
    if record.stopped.is_some() {
        return Ok(None);
    }
    let binding = binding_for_agent_on(connection, &record.source.agent_id).await?;
    let selection =
        crate::agent_runtime_transition::selection_on(connection, &record.source.agent_id).await?;
    let policy = crate::provider_recovery::read_on(connection, &record.source.provider_id).await?;
    let goal = crate::agent_goals::read_on(connection, &record.source.agent_id).await?;
    let goal_revision = goal.as_ref().map(|goal| goal.revision);
    let (operation_id, _) = agent_runtime_transition_identity(&record.attempt_id)
        .map_err(|error| corrupt_identifier("recovery operation identity", error))?;
    let still_authorized = record.target.as_ref().is_some_and(|target| {
        policy.as_ref().is_some_and(|policy| {
            policy.enabled
                && policy
                    .activated_at_ms
                    .is_some_and(|at| at <= record.failure.created_at_ms)
                && policy
                    .accounts
                    .iter()
                    .any(|account| account.profile == target.profile)
        }) && selection.as_ref().is_some_and(|selection| {
            selection.selected_by_operation_id.as_ref() == Some(&operation_id)
                && Some(selection.revision) == record.source_selection_revision.checked_add(1)
                && selection.execution_profile == target.execution_profile()
        }) && binding.as_ref().is_some_and(|binding| {
            binding.interaction_session_id == record.source.interaction_session_id
                && binding.timeline_epoch == record.source.timeline_epoch
                && binding.execution_profile == target.execution_profile()
        })
    }) && goal_revision == record.goal_revision
        && (!record.is_goal_continuation
            || goal
                .as_ref()
                .is_some_and(|goal| goal.status == dure_app::AgentGoalStatusV1::Active));
    if still_authorized
        && let Some(binding) = binding
        && latest_failure_on(connection, &binding).await?.as_ref() == Some(&record.failure)
    {
        let request = AgentContinueTurnRequestV1 {
            expected_cursor: timeline_cursor_on(connection, &binding).await?,
            intent: AgentStartTurnIntentV1 {
                schema_version: 1,
                interaction_session_id: binding.interaction_session_id,
                runtime: binding.runtime,
                turn_id: AgentTurnIdV1::new(attempt_id)
                    .map_err(|error| corrupt_identifier("recovery turn", error))?,
                client_message_id: AgentClientMessageIdV1::new(attempt_id)
                    .map_err(|error| corrupt_identifier("recovery input", error))?,
                input: record.input.clone(),
                requested_at_ms: observed_at_ms,
            },
        };
        let original_goal = if record.is_goal_continuation {
            goal.as_ref()
        } else {
            None
        };
        if let Some(receipt) =
            prepare_continuation_with_goal_on(connection, &request, original_goal).await?
        {
            record.continuation = Some(request);
            save_on(connection, &record).await?;
            return Ok(Some(receipt));
        }
    }
    record.stopped = Some(AgentRecoveryStopV1::Superseded);
    save_on(connection, &record).await?;
    Ok(None)
}

pub(crate) async fn latest_on(
    connection: &mut SqliteConnection,
    binding: &dure_app::AgentInteractionBindingV1,
) -> Result<Option<dure_app::AgentRecoveryObservationV1>, DomainStoreErrorV1> {
    let source = sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM agent_recoveries WHERE agent_id = ?1 \
        AND json_extract(record_json, '$.source.interactionSessionId') = ?2 \
        AND json_extract(record_json, '$.source.timelineEpoch') = ?3 \
        ORDER BY json_extract(record_json, '$.createdAtMs') DESC, rowid DESC LIMIT 1",
    )
    .bind(binding.agent_id.as_str())
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_recovery", error))?;
    let Some(source) = source else {
        return Ok(None);
    };
    let record = decode(&source)?;
    let turn_state = match &record.continuation {
        Some(request) => crate::agent_timeline::turn_effect_on(
            connection,
            &request.intent.interaction_session_id,
            &request.intent.client_message_id,
        )
        .await?
        .map(|receipt| receipt.state),
        None => None,
    };
    let Some(boundary) =
        crate::agent_timeline::latest_turn_boundary_on(connection, binding).await?
    else {
        return Ok(None);
    };
    let continuation_owns_boundary = record.continuation.as_ref().is_some_and(|request| {
        let item = &boundary.item;
        (item.turn_id.is_some() || item.client_message_id.is_some())
            && item
                .turn_id
                .as_ref()
                .is_none_or(|id| id == &request.intent.turn_id)
            && item
                .client_message_id
                .as_ref()
                .is_none_or(|id| id == &request.intent.client_message_id)
    });
    // The retained receipt stays visible through a rejected or uncertain resend.
    // A later human/goal turn replaces it using the same canonical boundary as
    // latest_failure, so clients never need a second stale-outcome heuristic.
    if boundary.item.item_id != record.failure.item_id && !continuation_owns_boundary {
        return Ok(None);
    }
    if continuation_owns_boundary
        && turn_state == Some(dure_app::AgentTurnEffectStateV1::Accepted)
        && matches!(
            boundary.item.body,
            dure_app::AgentTimelineItemBodyV1::Lifecycle {
                state: dure_app::AgentTimelineLifecycleStateV1::TurnFailed,
                ..
            }
        )
    {
        // Delivery of the retained input cannot mask its later provider failure.
        return Ok(None);
    }
    Ok(Some(dure_app::AgentRecoveryObservationV1 {
        attempt_id: record.attempt_id,
        failure_item_id: record.failure.item_id,
        target: record.target,
        stopped: record.stopped,
        turn_state,
        created_at_ms: record.created_at_ms,
    }))
}

impl AgentRecoveryStore for SqliteDomainStore {
    fn latest_agent_recovery<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<dure_app::AgentRecoveryObservationV1>> {
        Box::pin(async move {
            let mut transaction = self
                .pool
                .begin()
                .await
                .map_err(|error| map_sqlx("read_agent_recovery", error))?;
            let Some(binding) = binding_for_agent_on(&mut transaction, agent_id).await? else {
                return Ok(None);
            };
            let observation = latest_on(&mut transaction, &binding).await?;
            transaction
                .commit()
                .await
                .map_err(|error| map_sqlx("read_agent_recovery", error))?;
            Ok(observation)
        })
    }

    fn prepare_agent_recovery<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryRecordV1>> {
        Box::pin(async move {
            let mut transaction = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("prepare_agent_recovery", error))?;
            let result = prepare_on(&mut transaction, agent_id, observed_at_ms).await?;
            transaction
                .commit()
                .await
                .map_err(|error| map_sqlx("prepare_agent_recovery", error))?;
            Ok(result)
        })
    }

    fn agent_recovery<'a>(
        &'a self,
        attempt_id: &'a str,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryRecordV1>> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| map_sqlx("read_agent_recovery", error))?;
            read_on(&mut connection, attempt_id).await
        })
    }

    fn agents_with_recovery(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>> {
        Box::pin(async move {
            let rows = sqlx::query_scalar::<_, String>("SELECT DISTINCT sessions.agent_id FROM agent_interaction_sessions AS sessions \
                JOIN provider_recovery_policies AS policies ON sessions.provider_id = policies.provider_id \
                WHERE json_extract(policies.record_json, '$.enabled') = 1 \
                UNION SELECT agent_id FROM agent_recoveries WHERE json_extract(record_json, '$.stopped') IS NULL \
                AND json_extract(record_json, '$.continuation') IS NULL")
                .fetch_all(&self.pool).await.map_err(|error| map_sqlx("agents_with_recovery", error))?;
            rows.into_iter()
                .map(|id| {
                    AgentIdV1::new(id).map_err(|error| corrupt_identifier("recovery agent", error))
                })
                .collect()
        })
    }

    fn prepare_agent_recovery_turn<'a>(
        &'a self,
        attempt_id: &'a str,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentTurnEffectReceiptV1>> {
        Box::pin(async move {
            let mut transaction = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("prepare_agent_recovery_turn", error))?;
            let result = prepare_turn_on(&mut transaction, attempt_id, observed_at_ms).await?;
            transaction
                .commit()
                .await
                .map_err(|error| map_sqlx("prepare_agent_recovery_turn", error))?;
            Ok(result)
        })
    }

    fn stop_agent_recovery<'a>(
        &'a self,
        attempt_id: &'a str,
        reason: &'a AgentRecoveryStopV1,
    ) -> DomainStoreFuture<'a, AgentRecoveryRecordV1> {
        Box::pin(async move {
            let mut transaction = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("stop_agent_recovery", error))?;
            let mut record = read_on(&mut transaction, attempt_id)
                .await?
                .ok_or_else(|| DomainStoreErrorV1::NotFound {
                    entity: "agent_recovery",
                    id: attempt_id.into(),
                })?;
            if record.stopped.is_none() && record.continuation.is_none() {
                record.stopped = Some(reason.clone());
                save_on(&mut transaction, &record).await?;
            }
            transaction
                .commit()
                .await
                .map_err(|error| map_sqlx("stop_agent_recovery", error))?;
            Ok(record)
        })
    }
}
