use dure_app::{
    AgentClientMessageIdV1, AgentContinueTurnRequestV1, AgentIdV1, AgentInteractionProfileV1,
    AgentNativeRecoveryContinuationV1, AgentNativeRecoveryRecordV1, AgentNativeTurnFailureV1,
    AgentRecoveryAttemptV1, AgentRecoveryRecordV1, AgentRecoveryStopV1, AgentRecoveryStore,
    AgentStartTurnIntentV1, AgentTurnEffectReceiptV1, AgentTurnFailureReasonV1, AgentTurnIdV1,
    DomainStoreErrorV1, DomainStoreFuture, WorkflowPromptDeliveryEvidenceV1,
    agent_runtime_transition_identity,
};
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, SqliteConnection};

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

fn decode(source: &str) -> Result<AgentRecoveryAttemptV1, DomainStoreErrorV1> {
    serde_json::from_str(source).map_err(|error| serialization("agent recovery", error))
}

/// An attempt that still owns work: unstopped, and a conversation attempt
/// before its turn is admitted or a native attempt before its prompt is
/// delivered. Native rows always carry a continuation, so the conversation
/// half is exactly the predicate older backends use and never selects them.
const UNFINISHED: &str = "json_extract(record_json, '$.stopped') IS NULL \
    AND (json_extract(record_json, '$.continuation') IS NULL \
    OR (json_extract(record_json, '$.nativeFailure') IS NOT NULL \
    AND json_extract(record_json, '$.continuation.state') != 'delivered'))";

async fn read_on(
    connection: &mut SqliteConnection,
    attempt_id: &str,
) -> Result<Option<AgentRecoveryAttemptV1>, DomainStoreErrorV1> {
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
    record: &AgentRecoveryAttemptV1,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        "INSERT INTO agent_recoveries (attempt_id, agent_id, record_json) VALUES (?1, ?2, ?3) \
        ON CONFLICT(attempt_id) DO UPDATE SET record_json = excluded.record_json",
    )
    .bind(record.attempt_id())
    .bind(record.agent_id().as_str())
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
    native: Option<&AgentNativeTurnFailureV1>,
) -> Result<Option<AgentRecoveryAttemptV1>, DomainStoreErrorV1> {
    // Resume the saved intent even if runtime replacement is incomplete. The
    // runtime journal, rather than a new failure observation, owns that effect.
    if let Some(source) = sqlx::query_scalar::<_, String>(AssertSqlSafe(format!(
        "SELECT record_json FROM agent_recoveries WHERE agent_id = ?1 AND {UNFINISHED} LIMIT 1"
    )))
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_pending_agent_recovery", error))?
    {
        return decode(&source).map(Some);
    }
    // A native terminal's failure is the Host's, not a timeline row: any
    // conversation attempt the Agent kept from an earlier Chat is history.
    match native {
        Some(native) => prepare_native_on(connection, agent_id, observed_at_ms, native).await,
        None => Ok(
            prepare_conversation_on(connection, agent_id, observed_at_ms)
                .await?
                .map(|record| AgentRecoveryAttemptV1::Conversation(Box::new(record))),
        ),
    }
}

async fn prepare_native_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
    observed_at_ms: i64,
    native: &AgentNativeTurnFailureV1,
) -> Result<Option<AgentRecoveryAttemptV1>, DomainStoreErrorV1> {
    if !matches!(
        native.reason,
        AgentTurnFailureReasonV1::UsageLimit | AgentTurnFailureReasonV1::RateLimit
    ) {
        return Ok(None);
    }
    // The Host's failure episode survives account replacement and restarts,
    // so a repeated observation cannot create a second attempt.
    let identity = encode(&(
        "native",
        agent_id.as_str(),
        &native.terminal_epoch,
        &native.attention_id,
    ))?;
    let attempt_id = format!("recovery-{:x}", Sha256::digest(identity.as_bytes()));
    if let Some(record) = read_on(connection, &attempt_id).await? {
        return Ok(Some(record));
    }
    let Some(selection) =
        crate::agent_runtime_transition::selection_on(connection, agent_id).await?
    else {
        return Ok(None);
    };
    if selection.interaction_profile != AgentInteractionProfileV1::NativeCli {
        return Ok(None);
    }
    let Some(policy) =
        crate::provider_recovery::read_on(connection, &selection.provider_id).await?
    else {
        return Ok(None);
    };
    if !policy.enabled
        || policy
            .activated_at_ms
            .is_none_or(|at| native.observed_at_ms < at)
        || !crate::agent_runtime_close::is_open_on(connection, agent_id).await?
        || crate::agent_runtime_transition::active_transition_on(connection, agent_id)
            .await?
            .is_some()
        || crate::checkpoint_bindings::authority_on(connection, agent_id)
            .await?
            .is_none_or(|authority| authority.terminal_epoch != native.terminal_epoch)
    {
        return Ok(None);
    }
    crate::provider_recovery_usage::report_limit_on(
        connection,
        &selection.provider_id,
        &selection.execution_profile,
        native.observed_at_ms,
    )
    .await?;
    let target = crate::provider_recovery_usage::select_on(
        connection,
        &policy.accounts,
        &selection.execution_profile,
        observed_at_ms,
    )
    .await?;
    let record = AgentRecoveryAttemptV1::Native(Box::new(AgentNativeRecoveryRecordV1 {
        schema_version: 1,
        attempt_id,
        agent_id: agent_id.clone(),
        provider_id: selection.provider_id,
        source_execution_profile: selection.execution_profile,
        source_selection_revision: selection.revision,
        native_failure: native.clone(),
        policy_revision: policy.revision,
        stopped: target.is_none().then_some(AgentRecoveryStopV1::Exhausted),
        target,
        continuation: AgentNativeRecoveryContinuationV1::NotStarted,
        created_at_ms: observed_at_ms,
    }));
    save_on(connection, &record).await?;
    Ok(Some(record))
}

async fn prepare_conversation_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
    observed_at_ms: i64,
) -> Result<Option<AgentRecoveryRecordV1>, DomainStoreErrorV1> {
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
        return Ok(record.into_conversation());
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
    let record = AgentRecoveryAttemptV1::Conversation(Box::new(record));
    save_on(connection, &record).await?;
    Ok(record.into_conversation())
}

async fn prepare_turn_on(
    connection: &mut SqliteConnection,
    attempt_id: &str,
    observed_at_ms: i64,
) -> Result<Option<AgentTurnEffectReceiptV1>, DomainStoreErrorV1> {
    let Some(mut record) = read_on(connection, attempt_id)
        .await?
        .and_then(AgentRecoveryAttemptV1::into_conversation)
    else {
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
            save_on(
                connection,
                &AgentRecoveryAttemptV1::Conversation(Box::new(record)),
            )
            .await?;
            return Ok(Some(receipt));
        }
    }
    record.stopped = Some(AgentRecoveryStopV1::Superseded);
    save_on(
        connection,
        &AgentRecoveryAttemptV1::Conversation(Box::new(record)),
    )
    .await?;
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
    let Some(record) = source
        .map(|source| decode(&source))
        .transpose()?
        .and_then(AgentRecoveryAttemptV1::into_conversation)
    else {
        return Ok(None);
    };
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
        native: Option<&'a AgentNativeTurnFailureV1>,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryAttemptV1>> {
        Box::pin(async move {
            let mut transaction = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("prepare_agent_recovery", error))?;
            let result = prepare_on(&mut transaction, agent_id, observed_at_ms, native).await?;
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
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryAttemptV1>> {
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
            let rows = sqlx::query_scalar::<_, String>(AssertSqlSafe(format!("SELECT DISTINCT sessions.agent_id FROM agent_interaction_sessions AS sessions \
                JOIN provider_recovery_policies AS policies ON sessions.provider_id = policies.provider_id \
                WHERE json_extract(policies.record_json, '$.enabled') = 1 \
                UNION SELECT agent_id FROM agent_recoveries WHERE {UNFINISHED}")))
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
    ) -> DomainStoreFuture<'a, AgentRecoveryAttemptV1> {
        Box::pin(async move {
            let mut transaction = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("stop_agent_recovery", error))?;
            let mut record = read_on(&mut transaction, attempt_id)
                .await?
                .ok_or_else(|| not_found(attempt_id))?;
            let (stopped, owned_elsewhere) = match &mut record {
                AgentRecoveryAttemptV1::Conversation(record) => {
                    (&mut record.stopped, record.continuation.is_some())
                }
                AgentRecoveryAttemptV1::Native(record) => (
                    &mut record.stopped,
                    matches!(
                        record.continuation,
                        AgentNativeRecoveryContinuationV1::Delivered { .. }
                    ),
                ),
            };
            if stopped.is_none() && !owned_elsewhere {
                *stopped = Some(reason.clone());
                save_on(&mut transaction, &record).await?;
            }
            transaction
                .commit()
                .await
                .map_err(|error| map_sqlx("stop_agent_recovery", error))?;
            Ok(record)
        })
    }

    fn claim_native_agent_recovery_continuation<'a>(
        &'a self,
        attempt_id: &'a str,
        delivery_idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, AgentNativeRecoveryRecordV1> {
        Box::pin(async move {
            update_native_continuation(&self.pool, attempt_id, |record| {
                (record.stopped.is_none()
                    && record.continuation == AgentNativeRecoveryContinuationV1::NotStarted)
                    .then(|| AgentNativeRecoveryContinuationV1::Claimed {
                        delivery_idempotency_key: delivery_idempotency_key.into(),
                    })
            })
            .await
        })
    }

    fn settle_native_agent_recovery_continuation<'a>(
        &'a self,
        attempt_id: &'a str,
        evidence: Option<&'a WorkflowPromptDeliveryEvidenceV1>,
    ) -> DomainStoreFuture<'a, AgentNativeRecoveryRecordV1> {
        Box::pin(async move {
            update_native_continuation(&self.pool, attempt_id, |record| {
                matches!(
                    record.continuation,
                    AgentNativeRecoveryContinuationV1::Claimed { .. }
                )
                .then(|| match evidence {
                    Some(evidence) => AgentNativeRecoveryContinuationV1::Delivered {
                        evidence: evidence.clone(),
                    },
                    None => AgentNativeRecoveryContinuationV1::NotStarted,
                })
            })
            .await
        })
    }
}

fn not_found(attempt_id: &str) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::NotFound {
        entity: "agent_recovery",
        id: attempt_id.into(),
    }
}

/// Moves a native attempt's continuation in one immediate transaction when
/// `next` allows it from the stored state; otherwise returns it unchanged.
async fn update_native_continuation(
    pool: &sqlx::SqlitePool,
    attempt_id: &str,
    next: impl FnOnce(&AgentNativeRecoveryRecordV1) -> Option<AgentNativeRecoveryContinuationV1>,
) -> Result<AgentNativeRecoveryRecordV1, DomainStoreErrorV1> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("update_agent_recovery_continuation", error))?;
    let Some(AgentRecoveryAttemptV1::Native(mut record)) =
        read_on(&mut transaction, attempt_id).await?
    else {
        return Err(not_found(attempt_id));
    };
    if let Some(continuation) = next(&record) {
        record.continuation = continuation;
        let attempt = AgentRecoveryAttemptV1::Native(record);
        save_on(&mut transaction, &attempt).await?;
        let AgentRecoveryAttemptV1::Native(saved) = attempt else {
            unreachable!("a native attempt stays native");
        };
        record = saved;
    }
    transaction
        .commit()
        .await
        .map_err(|error| map_sqlx("update_agent_recovery_continuation", error))?;
    Ok(*record)
}

/// One Agent the native recovery scanner probes or wakes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeRecoveryCandidateV1 {
    pub agent_id: AgentIdV1,
    /// The Agent has a native attempt that still owns work.
    pub unfinished_attempt: bool,
}

impl SqliteDomainStore {
    /// Candidate enumeration for native account recovery, in pages: native
    /// terminal Agents whose provider has an enabled recovery policy, and
    /// Agents with an unfinished native attempt. Selection proves nothing
    /// about a failure; the Host observation and the owner decide.
    pub async fn agent_native_recovery_candidates(
        &self,
        after: Option<&AgentIdV1>,
        limit: u32,
    ) -> Result<Vec<NativeRecoveryCandidateV1>, DomainStoreErrorV1> {
        let rows = sqlx::query_as::<_, (String, bool)>(AssertSqlSafe(format!(
            "SELECT agent_id, MAX(unfinished) FROM (\
             SELECT selections.agent_id AS agent_id, 0 AS unfinished \
             FROM agent_runtime_selections AS selections \
             JOIN provider_recovery_policies AS policies \
             ON selections.provider_id = policies.provider_id \
             WHERE selections.interaction_profile = 'native_cli' \
             AND json_extract(policies.record_json, '$.enabled') = 1 \
             UNION ALL SELECT agent_id, 1 FROM agent_recoveries \
             WHERE json_extract(record_json, '$.nativeFailure') IS NOT NULL AND {UNFINISHED}) \
             WHERE ?1 IS NULL OR agent_id > ?1 GROUP BY agent_id ORDER BY agent_id LIMIT ?2"
        )))
        .bind(after.map(AgentIdV1::as_str))
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| map_sqlx("read_native_recovery_candidates", error))?;
        rows.into_iter()
            .map(|(agent_id, unfinished_attempt)| {
                Ok(NativeRecoveryCandidateV1 {
                    agent_id: AgentIdV1::new(agent_id)
                        .map_err(|error| corrupt_identifier("native recovery candidate", error))?,
                    unfinished_attempt,
                })
            })
            .collect()
    }
}
