use dure_app::{
    AgentClientMessageIdV1, AgentCompletePendingAnswerV1, AgentCompleteTurnEffectV1,
    AgentContinueTurnRequestV1,
    AgentHistoryHydrationAuthorityV1, AgentHistoryHydrationDispositionV1,
    AgentHistorySnapshotReceiptV1, AgentHistorySnapshotV1, AgentInteractionBindingV1,
    AgentInteractionRequestIdV1, AgentInteractionSessionIdV1, AgentPendingAnswerIntentV1,
    AgentPendingAnswerReceiptV1, AgentPendingAnswerStateV1, AgentPendingRequestDraftV1,
    AgentPendingRequestKindV1, AgentPendingRequestV1, AgentPendingSnapshotV1,
    AgentProviderCursorV1, AgentProviderEventCommitV1, AgentProviderGapV1,
    AgentProviderMessageIdV1, AgentProviderRuntimeFenceV1, AgentRuntimeReplacementV1,
    AgentStartTurnIntentV1, AgentTimelineActiveTurnV1, AgentTimelineCommitReceiptV1,
    AgentTimelineCursorV1, AgentTimelineEpochV1, AgentTimelineFailureV1,
    AgentTimelineItemBodyV1, AgentTimelineItemDraftV1,
    AgentTimelineItemIdV1, AgentTimelineLifecycleStateV1, AgentTimelineLiveTextV1,
    AgentTimelineMessageRoleV1, AgentTimelineMutationV1, AgentTimelinePageV1,
    AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1, AgentTimelineReadV1,
    AgentTimelineRowV1, AgentTimelineStreamIdV1, AgentTimelineTextFragmentV1,
    AgentTimelineTextKindV1, AgentTurnEffectReceiptV1, AgentTurnEffectStateV1, AgentTurnIdV1,
    DomainStoreErrorV1, MAX_AGENT_PENDING_REQUESTS_V1, MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1,
    MAX_AGENT_TIMELINE_TEXT_BYTES_V1, ProviderIdV1,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::agent_runtime_close::{ensure_open_on, ensure_runtime_binding_write_on};
use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, serialization, storage};

pub(crate) async fn create(
    pool: &SqlitePool,
    binding: &AgentInteractionBindingV1,
) -> Result<AgentInteractionBindingV1, DomainStoreErrorV1> {
    binding.validate()?;
    if binding.binding_revision != 1 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "bindingRevision",
            reason: "a new interaction must start at revision 1".into(),
        });
    }
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("create_agent_interaction", error))?;
    let result = create_on(&mut connection, binding).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("create_agent_interaction", error))?;
    Ok(result)
}

async fn create_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<AgentInteractionBindingV1, DomainStoreErrorV1> {
    ensure_runtime_binding_write_on(connection, &binding.agent_id).await?;
    if let Some(existing) = binding_on(connection, &binding.interaction_session_id).await? {
        if same_interaction_binding(&existing, binding) {
            return Ok(existing);
        }
        return Err(identity_conflict(
            "agent_interaction",
            binding.interaction_session_id.as_str(),
            "interaction session ID was replayed with different immutable input",
        ));
    }
    let provider_id =
        sqlx::query_scalar::<_, String>("SELECT provider_id FROM agents WHERE agent_id = ?1")
            .bind(binding.agent_id.as_str())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| map_sqlx("create_agent_interaction", error))?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent",
                id: binding.agent_id.to_string(),
            })?;
    if provider_id != binding.provider_id.as_str() {
        return Err(identity_conflict(
            "agent_interaction_provider",
            binding.interaction_session_id.as_str(),
            "provider must match the durable Agent record",
        ));
    }
    let execution_profile_json = encode("agent_execution_profile", &binding.execution_profile)?;
    sqlx::query(
        r#"
        INSERT INTO agent_interaction_sessions (
            interaction_session_id, schema_version, agent_id, provider_id,
            execution_profile_json, provider_conversation_ref, runtime_generation,
            provider_epoch, timeline_epoch, binding_revision, history_complete,
            created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(i64::from(binding.schema_version))
    .bind(binding.agent_id.as_str())
    .bind(binding.provider_id.as_str())
    .bind(execution_profile_json)
    .bind(&binding.provider_conversation_ref)
    .bind(&binding.runtime.runtime_generation)
    .bind(&binding.runtime.provider_epoch)
    .bind(binding.timeline_epoch.as_str())
    .bind(binding.binding_revision)
    .bind(binding.history_complete)
    .bind(binding.created_at_ms)
    .bind(binding.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("create_agent_interaction", error))?;
    insert_provider_stream(
        connection,
        &binding.interaction_session_id,
        &binding.runtime,
    )
    .await?;
    Ok(binding.clone())
}

pub(crate) async fn binding(
    pool: &SqlitePool,
    interaction_session_id: &AgentInteractionSessionIdV1,
) -> Result<Option<AgentInteractionBindingV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .begin_with("BEGIN DEFERRED")
        .await
        .map_err(|error| map_sqlx("read_agent_interaction", error))?;
    let result = binding_on(&mut connection, interaction_session_id).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("read_agent_interaction", error))?;
    Ok(result)
}

pub(crate) async fn binding_for_agent(
    pool: &SqlitePool,
    agent_id: &dure_app::AgentIdV1,
) -> Result<Option<AgentInteractionBindingV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_interaction_for_agent", error))?;
    binding_for_agent_on(&mut connection, agent_id).await
}

pub(crate) async fn binding_for_agent_on(
    connection: &mut SqliteConnection,
    agent_id: &dure_app::AgentIdV1,
) -> Result<Option<AgentInteractionBindingV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT schema_version, interaction_session_id, agent_id, provider_id,
               execution_profile_json, provider_conversation_ref, runtime_generation,
               provider_epoch, timeline_epoch, binding_revision, history_complete,
               created_at_ms, updated_at_ms
        FROM agent_interaction_sessions
        WHERE agent_id = ?1
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_interaction_for_agent", error))?;
    row.map(binding_from_row).transpose()
}

/// Runtime replacement is the durable proof that every still-open turn can
/// never receive its terminal row: exactly one provider serves the session, so
/// replacing it orphans whatever it left running. Converge those turns here,
/// inside the replacement transaction, instead of letting projections carry an
/// immortal "running" turn (a pane once counted a dead Bash tool for 32+
/// minutes and its interrupt had no live provider to land on).
async fn converge_open_turns_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
    replaced_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    let open_turns = sqlx::query(
        r#"
        SELECT started.turn_id, started.client_message_id
        FROM agent_timeline_rows AS started
        WHERE started.interaction_session_id = ?1
          AND started.timeline_epoch = ?2
          AND started.client_message_id IS NOT NULL
          AND json_extract(started.body_json, '$.type') = 'lifecycle'
          AND json_extract(started.body_json, '$.state') = 'turn_started'
          AND NOT EXISTS (
            SELECT 1 FROM agent_timeline_rows AS terminal
            WHERE terminal.interaction_session_id = started.interaction_session_id
              AND terminal.timeline_epoch = started.timeline_epoch
              AND terminal.client_message_id = started.client_message_id
              AND json_extract(terminal.body_json, '$.state')
                  IN ('turn_completed', 'turn_failed', 'turn_canceled')
          )
        ORDER BY started.sequence
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    for row in open_turns {
        let turn_id: Option<String> = row.get("turn_id");
        let client_message_id: String = row.get("client_message_id");
        let client_message_id = AgentClientMessageIdV1::new(client_message_id)
            .map_err(|error| storage("turn_convergence_identity", error.to_string()))?;
        let draft = AgentTimelineItemDraftV1 {
            item_id: stable_item_id(
                "turn-converged",
                &(
                    binding.interaction_session_id.clone(),
                    client_message_id.clone(),
                ),
            )?,
            turn_id: turn_id
                .map(AgentTurnIdV1::new)
                .transpose()
                .map_err(|error| storage("turn_convergence_identity", error.to_string()))?,
            client_message_id: Some(client_message_id),
            provider_message_id: None,
            body: AgentTimelineItemBodyV1::Lifecycle {
                state: AgentTimelineLifecycleStateV1::TurnFailed,
                detail: Some(
                    dure_app::AgentTurnFailureReasonV1::RuntimeReplaced
                        .as_token()
                        .into(),
                ),
            },
            created_at_ms: replaced_at_ms,
        };
        append_item_on(connection, binding, &draft).await?;
    }
    Ok(())
}

pub(crate) async fn replace_runtime(
    pool: &SqlitePool,
    replacement: &AgentRuntimeReplacementV1,
) -> Result<AgentInteractionBindingV1, DomainStoreErrorV1> {
    replacement.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    let result = replace_runtime_on(&mut connection, replacement).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    Ok(result)
}

async fn replace_runtime_on(
    connection: &mut SqliteConnection,
    replacement: &AgentRuntimeReplacementV1,
) -> Result<AgentInteractionBindingV1, DomainStoreErrorV1> {
    let current = required_binding(connection, &replacement.interaction_session_id).await?;
    ensure_runtime_binding_write_on(connection, &current.agent_id).await?;
    let replay_revision = replacement
        .expected_binding_revision
        .checked_add(1)
        .ok_or_else(|| storage("binding_revision_exhausted", "binding revision overflow"))?;
    if current.binding_revision == replay_revision
        && current.runtime == replacement.target
        && current.execution_profile == replacement.target_execution_profile
        && current.provider_conversation_ref == replacement.provider_conversation_ref
    {
        let retired_source = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*) FROM agent_provider_streams
            WHERE interaction_session_id = ?1
              AND runtime_generation = ?2
              AND provider_epoch = ?3
              AND retired_at_ms IS NOT NULL
            "#,
        )
        .bind(replacement.interaction_session_id.as_str())
        .bind(&replacement.source.runtime_generation)
        .bind(&replacement.source.provider_epoch)
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
        if retired_source == 1 {
            return Ok(current);
        }
    }
    if current.binding_revision != replacement.expected_binding_revision
        || current.runtime != replacement.source
        || current.execution_profile != replacement.source_execution_profile
    {
        return Err(identity_conflict(
            "agent_interaction_runtime",
            replacement.interaction_session_id.as_str(),
            "source runtime and binding revision must match the current binding",
        ));
    }
    let prior_target = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*) FROM agent_provider_streams
        WHERE interaction_session_id = ?1 AND runtime_generation = ?2
        "#,
    )
    .bind(replacement.interaction_session_id.as_str())
    .bind(&replacement.target.runtime_generation)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    if prior_target != 0 {
        return Err(identity_conflict(
            "agent_interaction_runtime",
            replacement.interaction_session_id.as_str(),
            "target runtime generation has already been used",
        ));
    }
    let next_revision = replay_revision;
    sqlx::query(
        r#"
        UPDATE agent_provider_streams SET retired_at_ms = ?4
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND retired_at_ms IS NULL
        "#,
    )
    .bind(replacement.interaction_session_id.as_str())
    .bind(&replacement.source.runtime_generation)
    .bind(&replacement.source.provider_epoch)
    .bind(replacement.replaced_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    sqlx::query(
        r#"
        UPDATE agent_pending_requests
        SET state = 'stale', updated_at_ms = MAX(updated_at_ms, ?4)
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND state = 'pending'
        "#,
    )
    .bind(replacement.interaction_session_id.as_str())
    .bind(&replacement.source.runtime_generation)
    .bind(&replacement.source.provider_epoch)
    .bind(replacement.replaced_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    mark_prepared_pending_answers_uncertain_on(
        connection,
        &replacement.interaction_session_id,
        &replacement.source,
        None,
        replacement.replaced_at_ms,
        "replace_agent_interaction_runtime",
    )
    .await?;
    converge_open_turns_on(connection, &current, replacement.replaced_at_ms).await?;
    sqlx::query(
        r#"
        UPDATE agent_turn_effects
        SET state = 'uncertain', updated_at_ms = MAX(updated_at_ms, ?4)
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND state = 'prepared'
        "#,
    )
    .bind(replacement.interaction_session_id.as_str())
    .bind(&replacement.source.runtime_generation)
    .bind(&replacement.source.provider_epoch)
    .bind(replacement.replaced_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    sqlx::query("DELETE FROM agent_timeline_live_text WHERE interaction_session_id = ?1")
        .bind(replacement.interaction_session_id.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    let target_execution_profile = encode(
        "agent_execution_profile",
        &replacement.target_execution_profile,
    )?;
    sqlx::query(
        r#"
        UPDATE agent_interaction_sessions SET
            provider_conversation_ref = ?2,
            runtime_generation = ?3,
            provider_epoch = ?4,
            binding_revision = ?5,
            updated_at_ms = ?6,
            execution_profile_json = ?7
        WHERE interaction_session_id = ?1
        "#,
    )
    .bind(replacement.interaction_session_id.as_str())
    .bind(&replacement.provider_conversation_ref)
    .bind(&replacement.target.runtime_generation)
    .bind(&replacement.target.provider_epoch)
    .bind(next_revision)
    .bind(replacement.replaced_at_ms)
    .bind(target_execution_profile)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("replace_agent_interaction_runtime", error))?;
    insert_provider_stream(
        connection,
        &replacement.interaction_session_id,
        &replacement.target,
    )
    .await?;
    required_binding(connection, &replacement.interaction_session_id).await
}

pub(crate) async fn provider_cursor(
    pool: &SqlitePool,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
) -> Result<AgentProviderCursorV1, DomainStoreErrorV1> {
    runtime.validate()?;
    let mut connection = pool
        .begin_with("BEGIN DEFERRED")
        .await
        .map_err(|error| map_sqlx("read_agent_provider_cursor", error))?;
    let result = async {
        validate_current_runtime(&mut connection, interaction_session_id, runtime).await?;
        provider_cursor_on(&mut connection, interaction_session_id, runtime).await
    }
    .await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("read_agent_provider_cursor", error))?;
    Ok(result)
}

async fn insert_provider_stream(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        r#"
        INSERT INTO agent_provider_streams (
            interaction_session_id, runtime_generation, provider_epoch,
            committed_through_sequence, pending_snapshot_through_sequence, retired_at_ms
        ) VALUES (?1, ?2, ?3, 0, 0, NULL)
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(&runtime.runtime_generation)
    .bind(&runtime.provider_epoch)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("create_agent_provider_stream", error))?;
    Ok(())
}

pub(crate) async fn binding_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
) -> Result<Option<AgentInteractionBindingV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT schema_version, interaction_session_id, agent_id, provider_id,
               execution_profile_json, provider_conversation_ref, runtime_generation,
               provider_epoch, timeline_epoch, binding_revision, history_complete,
               created_at_ms, updated_at_ms
        FROM agent_interaction_sessions
        WHERE interaction_session_id = ?1
        "#,
    )
    .bind(interaction_session_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_interaction", error))?;
    row.map(binding_from_row).transpose()
}

pub(crate) async fn required_binding(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
) -> Result<AgentInteractionBindingV1, DomainStoreErrorV1> {
    binding_on(connection, interaction_session_id)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "agent_interaction",
            id: interaction_session_id.to_string(),
        })
}

fn binding_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<AgentInteractionBindingV1, DomainStoreErrorV1> {
    let execution_profile_json: String = row
        .try_get("execution_profile_json")
        .map_err(|error| corrupt_row("agent_interaction_sessions", error))?;
    let record = AgentInteractionBindingV1 {
        schema_version: stored_schema(&row, "agent_interaction_sessions")?,
        interaction_session_id: parse_id(
            "agent_interaction_sessions.interaction_session_id",
            row.try_get("interaction_session_id")
                .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
            AgentInteractionSessionIdV1::new,
        )?,
        agent_id: parse_id(
            "agent_interaction_sessions.agent_id",
            row.try_get("agent_id")
                .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
            dure_app::AgentIdV1::new,
        )?,
        provider_id: parse_id(
            "agent_interaction_sessions.provider_id",
            row.try_get("provider_id")
                .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
            ProviderIdV1::new,
        )?,
        execution_profile: decode("agent_execution_profile", &execution_profile_json)?,
        provider_conversation_ref: row
            .try_get("provider_conversation_ref")
            .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: row
                .try_get("runtime_generation")
                .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
            provider_epoch: row
                .try_get("provider_epoch")
                .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
        },
        timeline_epoch: parse_id(
            "agent_interaction_sessions.timeline_epoch",
            row.try_get("timeline_epoch")
                .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
            AgentTimelineEpochV1::new,
        )?,
        binding_revision: row
            .try_get("binding_revision")
            .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
        history_complete: row
            .try_get("history_complete")
            .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("agent_interaction_sessions", error))?,
    };
    record
        .validate()
        .map_err(|error| storage("corrupt_agent_interaction", error.to_string()))?;
    Ok(record)
}

pub(crate) async fn validate_current_runtime(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
) -> Result<AgentInteractionBindingV1, DomainStoreErrorV1> {
    let binding = required_binding(connection, interaction_session_id).await?;
    if binding.runtime != *runtime {
        return Err(identity_conflict(
            "agent_interaction_runtime",
            interaction_session_id.as_str(),
            "runtime generation and provider epoch are stale",
        ));
    }
    Ok(binding)
}

async fn provider_cursor_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
) -> Result<AgentProviderCursorV1, DomainStoreErrorV1> {
    let committed_through_sequence = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT committed_through_sequence FROM agent_provider_streams
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND retired_at_ms IS NULL
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(&runtime.runtime_generation)
    .bind(&runtime.provider_epoch)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_provider_cursor", error))?
    .ok_or_else(|| {
        identity_conflict(
            "agent_provider_stream",
            interaction_session_id.as_str(),
            "current runtime has no active provider stream",
        )
    })?;
    Ok(AgentProviderCursorV1 {
        runtime: runtime.clone(),
        committed_through_sequence,
    })
}

fn identity_conflict(
    entity: &'static str,
    id: &str,
    reason: impl Into<String>,
) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::IdentityConflict {
        entity,
        id: id.into(),
        reason: reason.into(),
    }
}

fn stored_schema(
    row: &sqlx::sqlite::SqliteRow,
    table: &'static str,
) -> Result<u16, DomainStoreErrorV1> {
    u16::try_from(
        row.try_get::<i64, _>("schema_version")
            .map_err(|error| corrupt_row(table, error))?,
    )
    .map_err(|_| {
        storage(
            "corrupt_schema_version",
            format!("{table} schema is outside u16"),
        )
    })
}

fn parse_id<T, E>(
    field: &'static str,
    value: String,
    constructor: impl FnOnce(String) -> Result<T, E>,
) -> Result<T, DomainStoreErrorV1>
where
    E: std::fmt::Display,
{
    constructor(value).map_err(|error| corrupt_identifier(field, error))
}

fn encode<T: Serialize>(entity: &'static str, value: &T) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(value).map_err(|error| serialization(entity, error))
}

fn decode<T: serde::de::DeserializeOwned>(
    entity: &'static str,
    source: &str,
) -> Result<T, DomainStoreErrorV1> {
    serde_json::from_str(source).map_err(|error| serialization(entity, error))
}

fn fingerprint<T: Serialize>(value: &T) -> Result<String, DomainStoreErrorV1> {
    let bytes = serde_json::to_vec(value).map_err(|error| serialization("fingerprint", error))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(crate) async fn apply_provider_event(
    pool: &SqlitePool,
    event: &AgentProviderEventCommitV1,
) -> Result<AgentTimelineCommitReceiptV1, DomainStoreErrorV1> {
    event.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("apply_agent_provider_event", error))?;
    let result = apply_provider_event_on(&mut connection, event).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("apply_agent_provider_event", error))?;
    Ok(result)
}

async fn apply_provider_event_on(
    connection: &mut SqliteConnection,
    event: &AgentProviderEventCommitV1,
) -> Result<AgentTimelineCommitReceiptV1, DomainStoreErrorV1> {
    let binding = validate_current_runtime(
        connection,
        &event.interaction_session_id,
        &event.event.runtime,
    )
    .await?;
    let event_fingerprint = event.source_fingerprint.clone();
    if let Some(row) = sqlx::query(
        r#"
        SELECT event_fingerprint, receipt_json
        FROM agent_timeline_source_receipts
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND provider_sequence = ?4
        "#,
    )
    .bind(event.interaction_session_id.as_str())
    .bind(&event.event.runtime.runtime_generation)
    .bind(&event.event.runtime.provider_epoch)
    .bind(event.event.sequence)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_provider_event_receipt", error))?
    {
        let stored_fingerprint: String = row
            .try_get("event_fingerprint")
            .map_err(|error| corrupt_row("agent_timeline_source_receipts", error))?;
        if stored_fingerprint != event_fingerprint {
            return Err(identity_conflict(
                "agent_provider_event",
                event.interaction_session_id.as_str(),
                "provider event identity was replayed with different normalized mutations",
            ));
        }
        let source: String = row
            .try_get("receipt_json")
            .map_err(|error| corrupt_row("agent_timeline_source_receipts", error))?;
        let mut receipt: AgentTimelineCommitReceiptV1 =
            decode("agent_provider_event_receipt", &source)?;
        receipt.duplicate = true;
        receipt.timeline_changed = false;
        receipt.pending_changed = false;
        receipt.live_text_changed = false;
        return Ok(receipt);
    }

    let provider_cursor = provider_cursor_on(
        connection,
        &event.interaction_session_id,
        &event.event.runtime,
    )
    .await?;
    let expected_sequence = provider_cursor
        .committed_through_sequence
        .checked_add(1)
        .ok_or_else(|| storage("provider_sequence_exhausted", "provider sequence overflow"))?;
    if event.event.sequence != expected_sequence {
        return Err(identity_conflict(
            "agent_provider_event",
            event.interaction_session_id.as_str(),
            format!(
                "expected provider sequence {expected_sequence}, found {}",
                event.event.sequence
            ),
        ));
    }

    let mut timeline_changed = false;
    let mut pending_changed = false;
    let mut live_text_changed = false;
    for mutation in &event.mutations {
        match mutation {
            AgentTimelineMutationV1::EstablishProviderConversation {
                provider_conversation_ref,
                established_at_ms,
            } => {
                timeline_changed |= establish_provider_conversation_on(
                    connection,
                    &binding,
                    provider_conversation_ref,
                    *established_at_ms,
                )
                .await?;
            }
            AgentTimelineMutationV1::Append { item } => {
                timeline_changed |= append_item_on(connection, &binding, item).await?;
            }
            AgentTimelineMutationV1::AppendText { fragment } => {
                live_text_changed |=
                    append_text_on(connection, &event.interaction_session_id, fragment).await?;
            }
            AgentTimelineMutationV1::FinishTextForProviderMessage {
                provider_message_id,
                finished_at_ms,
            } => {
                let (timeline, live) =
                    finish_text_on(connection, &binding, provider_message_id, *finished_at_ms)
                        .await?;
                timeline_changed |= timeline;
                live_text_changed |= live;
            }
            AgentTimelineMutationV1::PutPending { request } => {
                pending_changed |= put_pending_on(
                    connection,
                    &event.interaction_session_id,
                    &event.event.runtime,
                    event.event.sequence,
                    request,
                    event.recorded_at_ms,
                )
                .await?;
            }
            AgentTimelineMutationV1::ResolvePending {
                request_id,
                outcome,
                resolved_at_ms,
            } => {
                pending_changed |= settle_pending_on(
                    connection,
                    &event.interaction_session_id,
                    &event.event.runtime,
                    request_id,
                    "resolved",
                    outcome,
                    *resolved_at_ms,
                )
                .await?;
            }
            AgentTimelineMutationV1::CancelPending {
                request_id,
                reason,
                canceled_at_ms,
            } => {
                pending_changed |= settle_pending_on(
                    connection,
                    &event.interaction_session_id,
                    &event.event.runtime,
                    request_id,
                    "canceled",
                    &serde_json::json!({ "reason": reason }),
                    *canceled_at_ms,
                )
                .await?;
            }
        }
    }

    sqlx::query(
        r#"
        UPDATE agent_provider_streams SET committed_through_sequence = ?4
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND retired_at_ms IS NULL
        "#,
    )
    .bind(event.interaction_session_id.as_str())
    .bind(&event.event.runtime.runtime_generation)
    .bind(&event.event.runtime.provider_epoch)
    .bind(event.event.sequence)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("advance_agent_provider_cursor", error))?;
    let receipt = AgentTimelineCommitReceiptV1 {
        provider_cursor: AgentProviderCursorV1 {
            runtime: event.event.runtime.clone(),
            committed_through_sequence: event.event.sequence,
        },
        timeline_cursor: timeline_cursor_on(connection, &binding).await?,
        duplicate: false,
        timeline_changed,
        pending_changed,
        live_text_changed,
    };
    sqlx::query(
        r#"
        INSERT INTO agent_timeline_source_receipts (
            interaction_session_id, runtime_generation, provider_epoch,
            provider_sequence, event_fingerprint, receipt_json, recorded_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(event.interaction_session_id.as_str())
    .bind(&event.event.runtime.runtime_generation)
    .bind(&event.event.runtime.provider_epoch)
    .bind(event.event.sequence)
    .bind(event_fingerprint)
    .bind(encode("agent_provider_event_receipt", &receipt)?)
    .bind(event.recorded_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("write_agent_provider_event_receipt", error))?;
    Ok(receipt)
}

async fn establish_provider_conversation_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
    provider_conversation_ref: &str,
    established_at_ms: i64,
) -> Result<bool, DomainStoreErrorV1> {
    match binding.provider_conversation_ref.as_deref() {
        Some(current) if current == provider_conversation_ref => return Ok(false),
        Some(_) => {
            return Err(identity_conflict(
                "agent_provider_conversation",
                binding.interaction_session_id.as_str(),
                "provider conversation reference conflicts with the current binding",
            ));
        }
        None => {}
    }
    let next_revision = binding
        .binding_revision
        .checked_add(1)
        .ok_or_else(|| storage("binding_revision_exhausted", "binding revision overflow"))?;
    let updated = sqlx::query(
        r#"
        UPDATE agent_interaction_sessions SET
            provider_conversation_ref = ?2,
            binding_revision = ?3,
            updated_at_ms = MAX(updated_at_ms, ?4)
        WHERE interaction_session_id = ?1
          AND binding_revision = ?5
          AND provider_conversation_ref IS NULL
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(provider_conversation_ref)
    .bind(next_revision)
    .bind(established_at_ms)
    .bind(binding.binding_revision)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("establish_agent_provider_conversation", error))?;
    if updated.rows_affected() != 1 {
        return Err(identity_conflict(
            "agent_provider_conversation",
            binding.interaction_session_id.as_str(),
            "provider conversation binding changed concurrently",
        ));
    }
    Ok(true)
}

pub(crate) async fn record_provider_gap(
    pool: &SqlitePool,
    gap: &AgentProviderGapV1,
) -> Result<AgentTimelineCommitReceiptV1, DomainStoreErrorV1> {
    gap.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("record_agent_provider_gap", error))?;
    let result = record_provider_gap_on(&mut connection, gap).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("record_agent_provider_gap", error))?;
    Ok(result)
}

pub(crate) async fn reconcile_history(
    pool: &SqlitePool,
    snapshot: &AgentHistorySnapshotV1,
) -> Result<AgentHistorySnapshotReceiptV1, DomainStoreErrorV1> {
    snapshot.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("reconcile_agent_history", error))?;
    let result = reconcile_history_on(&mut connection, snapshot).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("reconcile_agent_history", error))?;
    Ok(result)
}

pub(crate) async fn history_hydration_authority(
    pool: &SqlitePool,
    interaction_session_id: &AgentInteractionSessionIdV1,
) -> Result<AgentHistoryHydrationAuthorityV1, DomainStoreErrorV1> {
    let mut connection = pool
        .begin_with("BEGIN DEFERRED")
        .await
        .map_err(|error| map_sqlx("agent_history_hydration_authority", error))?;
    let result = history_hydration_authority_on(&mut connection, interaction_session_id).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("agent_history_hydration_authority", error))?;
    Ok(result)
}

pub(crate) async fn history_hydration_authority_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
) -> Result<AgentHistoryHydrationAuthorityV1, DomainStoreErrorV1> {
    let binding = required_binding(connection, interaction_session_id).await?;
    let disposition = if binding.history_complete {
        AgentHistoryHydrationDispositionV1::Complete
    } else if has_history_boundary(connection, &binding).await? {
        AgentHistoryHydrationDispositionV1::KnownGap
    } else if binding.provider_conversation_ref.is_none() {
        return Err(identity_conflict(
            "agent_history_hydration",
            interaction_session_id.as_str(),
            "an incomplete timeline has no provider conversation authority",
        ));
    } else if has_canonical_history_content(connection, &binding).await? {
        // Live content after an unavailable provider snapshot makes the gap
        // durable. Never attempt to insert older history ahead of it later.
        AgentHistoryHydrationDispositionV1::KnownGap
    } else {
        AgentHistoryHydrationDispositionV1::Seedable
    };
    Ok(AgentHistoryHydrationAuthorityV1 {
        binding,
        disposition,
    })
}

async fn reconcile_history_on(
    connection: &mut SqliteConnection,
    snapshot: &AgentHistorySnapshotV1,
) -> Result<AgentHistorySnapshotReceiptV1, DomainStoreErrorV1> {
    let current = required_binding(connection, &snapshot.binding.interaction_session_id).await?;
    if !current.same_history_authority(&snapshot.binding) {
        return Err(identity_conflict(
            "agent_history_snapshot",
            snapshot.binding.interaction_session_id.as_str(),
            "snapshot binding does not match the current interaction authority",
        ));
    }
    if current.history_complete {
        return Ok(AgentHistorySnapshotReceiptV1 {
            timeline_cursor: timeline_cursor_on(connection, &current).await?,
            binding: current,
            newly_completed: false,
            timeline_changed: false,
        });
    }
    if current != snapshot.binding {
        return Err(identity_conflict(
            "agent_history_snapshot",
            snapshot.binding.interaction_session_id.as_str(),
            "incomplete binding changed after the history snapshot was acquired",
        ));
    }
    if has_canonical_history_content(connection, &current).await? {
        return Err(identity_conflict(
            "agent_history_snapshot",
            snapshot.binding.interaction_session_id.as_str(),
            "an incomplete timeline already contains canonical conversation content",
        ));
    }

    let mut timeline_changed = false;
    for item in &snapshot.items {
        timeline_changed |= append_item_on(connection, &current, item).await?;
    }
    let updated = sqlx::query(
        r#"
        UPDATE agent_interaction_sessions
        SET history_complete = 1, updated_at_ms = MAX(updated_at_ms, ?2)
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?3
          AND provider_epoch = ?4
          AND binding_revision = ?5
          AND history_complete = 0
        "#,
    )
    .bind(current.interaction_session_id.as_str())
    .bind(snapshot.observed_at_ms)
    .bind(&current.runtime.runtime_generation)
    .bind(&current.runtime.provider_epoch)
    .bind(current.binding_revision)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("reconcile_agent_history", error))?;
    if updated.rows_affected() != 1 {
        return Err(identity_conflict(
            "agent_history_snapshot",
            current.interaction_session_id.as_str(),
            "history authority changed before the snapshot committed",
        ));
    }
    let completed = required_binding(connection, &current.interaction_session_id).await?;
    Ok(AgentHistorySnapshotReceiptV1 {
        timeline_cursor: timeline_cursor_on(connection, &completed).await?,
        binding: completed,
        newly_completed: true,
        timeline_changed,
    })
}

async fn has_canonical_history_content(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<bool, DomainStoreErrorV1> {
    let canonical_content = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM agent_timeline_rows
            WHERE interaction_session_id = ?1
              AND timeline_epoch = ?2
              AND CASE
                    WHEN json_valid(body_json) = 0 THEN 1
                    WHEN json_extract(body_json, '$.type') = 'provider_evidence' THEN 0
                    WHEN json_extract(body_json, '$.type') = 'lifecycle'
                         AND json_extract(body_json, '$.state') IN (
                             'session_ready', 'turn_started', 'turn_completed', 'turn_canceled'
                         )
                         AND json_extract(body_json, '$.detail') IS NULL
                        THEN 0
                    WHEN json_extract(body_json, '$.type') = 'lifecycle'
                         AND json_extract(body_json, '$.state') = 'session_exited'
                         AND (
                             json_extract(body_json, '$.detail') IS NULL
                             OR CASE
                                    WHEN json_valid(
                                        json_extract(body_json, '$.detail')
                                    ) = 1
                                    THEN json_type(
                                             json_extract(body_json, '$.detail')
                                         ) = 'object'
                                         AND (
                                             SELECT COUNT(*) FROM json_each(
                                                 json_extract(body_json, '$.detail')
                                             )
                                         ) = 2
                                         AND json_type(
                                             json_extract(body_json, '$.detail'), '$.code'
                                         ) = 'integer'
                                         AND json_extract(
                                             json_extract(body_json, '$.detail'), '$.code'
                                         ) = 0
                                         AND json_type(
                                             json_extract(body_json, '$.detail'), '$.signal'
                                         ) = 'null'
                                    ELSE 0
                                END
                         )
                        THEN 0
                    ELSE 1
                  END = 1
            LIMIT 1
        )
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("reconcile_agent_history", error))?;
    if canonical_content > 0 {
        return Ok(true);
    }

    let pending = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*) FROM agent_pending_requests
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND state = 'pending'
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(&binding.runtime.runtime_generation)
    .bind(&binding.runtime.provider_epoch)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("reconcile_agent_history", error))?;
    if pending > 0 {
        return Ok(true);
    }
    let live_text = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_timeline_live_text WHERE interaction_session_id = ?1",
    )
    .bind(binding.interaction_session_id.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("reconcile_agent_history", error))?;
    Ok(live_text > 0)
}

async fn has_history_boundary(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<bool, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, i64>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM agent_timeline_rows
            WHERE interaction_session_id = ?1
              AND timeline_epoch = ?2
              AND CASE
                    WHEN json_valid(body_json) = 1
                        THEN json_extract(body_json, '$.type') = 'history_boundary'
                    ELSE 0
                  END = 1
            LIMIT 1
        )
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .fetch_one(&mut *connection)
    .await
    .map(|found| found > 0)
    .map_err(|error| map_sqlx("agent_history_hydration_authority", error))
}

async fn record_provider_gap_on(
    connection: &mut SqliteConnection,
    gap: &AgentProviderGapV1,
) -> Result<AgentTimelineCommitReceiptV1, DomainStoreErrorV1> {
    let binding =
        validate_current_runtime(connection, &gap.interaction_session_id, &gap.runtime).await?;
    if let Some(source) = sqlx::query_scalar::<_, String>(
        r#"
        SELECT receipt_json FROM agent_provider_gaps
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND requested_after_sequence = ?4
          AND dropped_through_sequence = ?5
        "#,
    )
    .bind(gap.interaction_session_id.as_str())
    .bind(&gap.runtime.runtime_generation)
    .bind(&gap.runtime.provider_epoch)
    .bind(gap.requested_after_sequence)
    .bind(gap.dropped_through_sequence)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_provider_gap", error))?
    {
        let mut receipt: AgentTimelineCommitReceiptV1 =
            decode("agent_provider_gap_receipt", &source)?;
        receipt.duplicate = true;
        receipt.timeline_changed = false;
        receipt.pending_changed = false;
        receipt.live_text_changed = false;
        return Ok(receipt);
    }
    let current = provider_cursor_on(connection, &gap.interaction_session_id, &gap.runtime).await?;
    if current.committed_through_sequence != gap.requested_after_sequence {
        return Err(identity_conflict(
            "agent_provider_gap",
            gap.interaction_session_id.as_str(),
            format!(
                "gap starts after {}, but the durable provider cursor is {}",
                gap.requested_after_sequence, current.committed_through_sequence
            ),
        ));
    }
    let item = AgentTimelineItemDraftV1 {
        item_id: stable_item_id("gap", gap)?,
        turn_id: None,
        client_message_id: None,
        provider_message_id: None,
        body: AgentTimelineItemBodyV1::HistoryBoundary {
            reason: "provider_replay_gap".into(),
            requested_after_provider_sequence: gap.requested_after_sequence,
            dropped_through_provider_sequence: gap.dropped_through_sequence,
        },
        created_at_ms: gap.observed_at_ms,
    };
    let timeline_changed = append_item_on(connection, &binding, &item).await?;
    sqlx::query(
        r#"
        UPDATE agent_provider_streams SET committed_through_sequence = ?4
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND retired_at_ms IS NULL
        "#,
    )
    .bind(gap.interaction_session_id.as_str())
    .bind(&gap.runtime.runtime_generation)
    .bind(&gap.runtime.provider_epoch)
    .bind(gap.dropped_through_sequence)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("record_agent_provider_gap", error))?;
    sqlx::query(
        r#"
        UPDATE agent_interaction_sessions
        SET history_complete = 0, updated_at_ms = MAX(updated_at_ms, ?2)
        WHERE interaction_session_id = ?1
        "#,
    )
    .bind(gap.interaction_session_id.as_str())
    .bind(gap.observed_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("record_agent_provider_gap", error))?;
    let receipt = AgentTimelineCommitReceiptV1 {
        provider_cursor: AgentProviderCursorV1 {
            runtime: gap.runtime.clone(),
            committed_through_sequence: gap.dropped_through_sequence,
        },
        timeline_cursor: timeline_cursor_on(connection, &binding).await?,
        duplicate: false,
        timeline_changed,
        pending_changed: false,
        live_text_changed: false,
    };
    sqlx::query(
        r#"
        INSERT INTO agent_provider_gaps (
            interaction_session_id, runtime_generation, provider_epoch,
            requested_after_sequence, dropped_through_sequence, receipt_json, observed_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(gap.interaction_session_id.as_str())
    .bind(&gap.runtime.runtime_generation)
    .bind(&gap.runtime.provider_epoch)
    .bind(gap.requested_after_sequence)
    .bind(gap.dropped_through_sequence)
    .bind(encode("agent_provider_gap_receipt", &receipt)?)
    .bind(gap.observed_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("record_agent_provider_gap", error))?;
    Ok(receipt)
}

pub(crate) async fn append_item_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
    item: &AgentTimelineItemDraftV1,
) -> Result<bool, DomainStoreErrorV1> {
    item.validate()?;
    if let Some(row) = sqlx::query(
        r#"
        SELECT timeline_epoch, sequence, item_id, turn_id, client_message_id,
               provider_message_id, body_json, created_at_ms
        FROM agent_timeline_rows
        WHERE interaction_session_id = ?1 AND item_id = ?2
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(item.item_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_timeline_item", error))?
    {
        let existing = timeline_row_from_row(row)?;
        if existing.item == *item && existing.cursor.epoch == binding.timeline_epoch {
            return Ok(false);
        }
        return Err(identity_conflict(
            "agent_timeline_item",
            item.item_id.as_str(),
            "stable item ID was replayed with different content",
        ));
    }
    let sequence = latest_timeline_sequence(connection, binding)
        .await?
        .checked_add(1)
        .ok_or_else(|| storage("timeline_sequence_exhausted", "timeline sequence overflow"))?;
    sqlx::query(
        r#"
        INSERT INTO agent_timeline_rows (
            interaction_session_id, timeline_epoch, sequence, item_id, turn_id,
            client_message_id, provider_message_id, body_json, created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .bind(sequence)
    .bind(item.item_id.as_str())
    .bind(item.turn_id.as_ref().map(AgentTurnIdV1::as_str))
    .bind(
        item.client_message_id
            .as_ref()
            .map(AgentClientMessageIdV1::as_str),
    )
    .bind(
        item.provider_message_id
            .as_ref()
            .map(AgentProviderMessageIdV1::as_str),
    )
    .bind(encode("agent_timeline_item", &item.body)?)
    .bind(item.created_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("append_agent_timeline_item", error))?;
    Ok(true)
}

async fn append_text_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    fragment: &AgentTimelineTextFragmentV1,
) -> Result<bool, DomainStoreErrorV1> {
    fragment.validate()?;
    let existing = sqlx::query(
        r#"
        SELECT stream_id, item_id, kind, text_value, turn_id, client_message_id,
               provider_message_id, updated_at_ms
        FROM agent_timeline_live_text
        WHERE interaction_session_id = ?1 AND stream_id = ?2
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(fragment.stream_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_timeline_live_text", error))?;
    if let Some(row) = existing {
        let current = live_text_from_row(row)?;
        if current.item_id != fragment.item_id
            || current.kind != fragment.kind
            || current.turn_id != fragment.turn_id
            || current.client_message_id != fragment.client_message_id
            || current.provider_message_id != fragment.provider_message_id
        {
            return Err(identity_conflict(
                "agent_timeline_text_stream",
                fragment.stream_id.as_str(),
                "text stream metadata changed after the first fragment",
            ));
        }
        if fragment.fragment.is_empty() {
            return Ok(false);
        }
        let next_len = current
            .text
            .len()
            .checked_add(fragment.fragment.len())
            .ok_or_else(|| storage("timeline_text_exhausted", "live text length overflow"))?;
        if next_len > MAX_AGENT_TIMELINE_TEXT_BYTES_V1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "textFragment.fragment",
                reason: "cumulative live text exceeds the bounded text size".into(),
            });
        }
        sqlx::query(
            r#"
            UPDATE agent_timeline_live_text
            SET text_value = text_value || ?3, updated_at_ms = MAX(updated_at_ms, ?4)
            WHERE interaction_session_id = ?1 AND stream_id = ?2
            "#,
        )
        .bind(interaction_session_id.as_str())
        .bind(fragment.stream_id.as_str())
        .bind(&fragment.fragment)
        .bind(fragment.observed_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("append_agent_timeline_live_text", error))?;
        return Ok(true);
    }
    let live_head_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*) FROM agent_timeline_live_text
        WHERE interaction_session_id = ?1
        "#,
    )
    .bind(interaction_session_id.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("append_agent_timeline_live_text", error))?;
    if live_head_count
        >= i64::try_from(MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1)
            .map_err(|_| storage("timeline_live_text_limit", "live-head limit is outside i64"))?
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "textFragment.streamId",
            reason: "exceeds the per-interaction live text head limit".into(),
        });
    }
    sqlx::query(
        r#"
        INSERT INTO agent_timeline_live_text (
            interaction_session_id, stream_id, item_id, kind, text_value, turn_id,
            client_message_id, provider_message_id, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(fragment.stream_id.as_str())
    .bind(fragment.item_id.as_str())
    .bind(text_kind(&fragment.kind))
    .bind(&fragment.fragment)
    .bind(fragment.turn_id.as_ref().map(AgentTurnIdV1::as_str))
    .bind(
        fragment
            .client_message_id
            .as_ref()
            .map(AgentClientMessageIdV1::as_str),
    )
    .bind(fragment.provider_message_id.as_str())
    .bind(fragment.observed_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("append_agent_timeline_live_text", error))?;
    Ok(true)
}

async fn finish_text_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
    provider_message_id: &AgentProviderMessageIdV1,
    finished_at_ms: i64,
) -> Result<(bool, bool), DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT stream_id, item_id, kind, text_value, turn_id, client_message_id,
               provider_message_id, updated_at_ms
        FROM agent_timeline_live_text
        WHERE interaction_session_id = ?1 AND provider_message_id = ?2
        ORDER BY stream_id
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(provider_message_id.as_str())
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("finish_agent_timeline_live_text", error))?;
    if rows.is_empty() {
        return Ok((false, false));
    }
    let mut timeline_changed = false;
    for row in rows {
        let live = live_text_from_row(row)?;
        let body = match live.kind {
            AgentTimelineTextKindV1::Assistant => AgentTimelineItemBodyV1::Message {
                role: AgentTimelineMessageRoleV1::Assistant,
                markdown: live.text,
            },
            AgentTimelineTextKindV1::Reasoning => {
                AgentTimelineItemBodyV1::Reasoning { text: live.text }
            }
            AgentTimelineTextKindV1::ToolInput => AgentTimelineItemBodyV1::ToolInput {
                json_text: live.text,
            },
        };
        timeline_changed |= append_item_on(
            connection,
            binding,
            &AgentTimelineItemDraftV1 {
                item_id: live.item_id,
                turn_id: live.turn_id,
                client_message_id: live.client_message_id,
                provider_message_id: Some(live.provider_message_id),
                body,
                created_at_ms: finished_at_ms,
            },
        )
        .await?;
    }
    sqlx::query(
        r#"
        DELETE FROM agent_timeline_live_text
        WHERE interaction_session_id = ?1 AND provider_message_id = ?2
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(provider_message_id.as_str())
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("finish_agent_timeline_live_text", error))?;
    Ok((timeline_changed, true))
}

async fn put_pending_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
    origin_provider_sequence: i64,
    request: &AgentPendingRequestDraftV1,
    updated_at_ms: i64,
) -> Result<bool, DomainStoreErrorV1> {
    request.validate()?;
    if let Some((existing, state, _)) =
        pending_with_state_on(connection, interaction_session_id, &request.request_id).await?
    {
        if existing.runtime == *runtime
            && same_pending_request(&existing.request, request)
            && state == "pending"
        {
            return Ok(false);
        }
        return Err(identity_conflict(
            "agent_pending_request",
            request.request_id.as_str(),
            "request ID was replayed with different content or after settlement",
        ));
    }
    let pending_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*) FROM agent_pending_requests
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND state = 'pending'
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(&runtime.runtime_generation)
    .bind(&runtime.provider_epoch)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("put_agent_pending_request", error))?;
    if pending_count
        >= i64::try_from(MAX_AGENT_PENDING_REQUESTS_V1)
            .map_err(|_| storage("pending_request_limit", "pending limit is outside i64"))?
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "pendingRequest.requestId",
            reason: "exceeds the per-runtime pending-request limit".into(),
        });
    }
    sqlx::query(
        r#"
        INSERT INTO agent_pending_requests (
            interaction_session_id, request_id, runtime_generation, provider_epoch,
            kind, turn_id, client_message_id, payload_json, origin_provider_sequence,
            state, outcome_json, created_at_ms, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', NULL, ?10, ?11)
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(request.request_id.as_str())
    .bind(&runtime.runtime_generation)
    .bind(&runtime.provider_epoch)
    .bind(pending_kind(&request.kind))
    .bind(request.turn_id.as_ref().map(AgentTurnIdV1::as_str))
    .bind(request.client_message_id.as_str())
    .bind(encode("agent_pending_request_payload", &request.payload)?)
    .bind(origin_provider_sequence)
    .bind(request.created_at_ms)
    .bind(updated_at_ms.max(request.created_at_ms))
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("put_agent_pending_request", error))?;
    Ok(true)
}

async fn settle_pending_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
    request_id: &AgentInteractionRequestIdV1,
    target_state: &'static str,
    outcome: &Value,
    updated_at_ms: i64,
) -> Result<bool, DomainStoreErrorV1> {
    let Some((request, state, stored_outcome)) =
        pending_with_state_on(connection, interaction_session_id, request_id).await?
    else {
        return Err(identity_conflict(
            "agent_pending_request",
            request_id.as_str(),
            "request is absent or no longer answerable",
        ));
    };
    if request.runtime != *runtime {
        return Err(identity_conflict(
            "agent_pending_request",
            request_id.as_str(),
            "request belongs to a stale provider runtime",
        ));
    }
    if state == target_state && stored_outcome.as_ref() == Some(outcome) {
        return Ok(false);
    }
    if state != "pending" {
        return Err(identity_conflict(
            "agent_pending_request",
            request_id.as_str(),
            "request was already settled differently",
        ));
    }
    sqlx::query(
        r#"
        UPDATE agent_pending_requests
        SET state = ?3, outcome_json = ?4, updated_at_ms = MAX(updated_at_ms, ?5)
        WHERE interaction_session_id = ?1 AND request_id = ?2
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(request_id.as_str())
    .bind(target_state)
    .bind(encode("agent_pending_outcome", outcome)?)
    .bind(updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("settle_agent_pending_request", error))?;
    Ok(true)
}

async fn latest_timeline_sequence(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<i64, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(MAX(sequence), 0) FROM agent_timeline_rows
        WHERE interaction_session_id = ?1 AND timeline_epoch = ?2
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_timeline_cursor", error))
}

pub(crate) async fn timeline_cursor_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<AgentTimelineCursorV1, DomainStoreErrorV1> {
    Ok(AgentTimelineCursorV1 {
        epoch: binding.timeline_epoch.clone(),
        sequence: latest_timeline_sequence(connection, binding).await?,
    })
}

fn stable_item_id<T: Serialize>(
    prefix: &str,
    value: &T,
) -> Result<AgentTimelineItemIdV1, DomainStoreErrorV1> {
    AgentTimelineItemIdV1::new(format!("{prefix}-{}", fingerprint(value)?))
        .map_err(|error| storage("timeline_item_identity", error.to_string()))
}

pub(crate) async fn reconcile_pending_snapshot(
    pool: &SqlitePool,
    snapshot: &AgentPendingSnapshotV1,
) -> Result<AgentTimelineCommitReceiptV1, DomainStoreErrorV1> {
    snapshot.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("reconcile_agent_pending_snapshot", error))?;
    let result = reconcile_pending_snapshot_on(&mut connection, snapshot).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("reconcile_agent_pending_snapshot", error))?;
    Ok(result)
}

async fn reconcile_pending_snapshot_on(
    connection: &mut SqliteConnection,
    snapshot: &AgentPendingSnapshotV1,
) -> Result<AgentTimelineCommitReceiptV1, DomainStoreErrorV1> {
    let binding = validate_current_runtime(
        connection,
        &snapshot.interaction_session_id,
        &snapshot.runtime,
    )
    .await?;
    let stream = sqlx::query(
        r#"
        SELECT committed_through_sequence, pending_snapshot_through_sequence
        FROM agent_provider_streams
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND retired_at_ms IS NULL
        "#,
    )
    .bind(snapshot.interaction_session_id.as_str())
    .bind(&snapshot.runtime.runtime_generation)
    .bind(&snapshot.runtime.provider_epoch)
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| map_sqlx("reconcile_agent_pending_snapshot", error))?;
    let committed_through: i64 = stream
        .try_get("committed_through_sequence")
        .map_err(|error| corrupt_row("agent_provider_streams", error))?;
    let prior_snapshot_through: i64 = stream
        .try_get("pending_snapshot_through_sequence")
        .map_err(|error| corrupt_row("agent_provider_streams", error))?;
    if snapshot.observed_through_sequence > committed_through {
        return Err(identity_conflict(
            "agent_pending_snapshot",
            snapshot.interaction_session_id.as_str(),
            "snapshot cannot precede durable commit of its observed provider events",
        ));
    }
    if snapshot.observed_through_sequence < prior_snapshot_through {
        return Ok(AgentTimelineCommitReceiptV1 {
            provider_cursor: AgentProviderCursorV1 {
                runtime: snapshot.runtime.clone(),
                committed_through_sequence: committed_through,
            },
            timeline_cursor: timeline_cursor_on(connection, &binding).await?,
            duplicate: true,
            timeline_changed: false,
            pending_changed: false,
            live_text_changed: false,
        });
    }

    let mut pending_changed = false;
    let snapshot_ids = snapshot
        .requests
        .iter()
        .map(|request| request.request_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    for request in &snapshot.requests {
        pending_changed |= converge_pending_on(
            connection,
            &snapshot.interaction_session_id,
            &snapshot.runtime,
            snapshot.observed_through_sequence,
            request,
            snapshot.observed_at_ms,
        )
        .await?;
    }
    let current_rows = sqlx::query(
        r#"
        SELECT request_id FROM agent_pending_requests
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND state = 'pending'
          AND origin_provider_sequence <= ?4
        "#,
    )
    .bind(snapshot.interaction_session_id.as_str())
    .bind(&snapshot.runtime.runtime_generation)
    .bind(&snapshot.runtime.provider_epoch)
    .bind(snapshot.observed_through_sequence)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("reconcile_agent_pending_snapshot", error))?;
    for row in current_rows {
        let request_id: String = row
            .try_get("request_id")
            .map_err(|error| corrupt_row("agent_pending_requests", error))?;
        if snapshot_ids.contains(request_id.as_str()) {
            continue;
        }
        sqlx::query(
            r#"
            UPDATE agent_pending_requests
            SET state = 'stale', updated_at_ms = MAX(updated_at_ms, ?3)
            WHERE interaction_session_id = ?1 AND request_id = ?2 AND state = 'pending'
            "#,
        )
        .bind(snapshot.interaction_session_id.as_str())
        .bind(&request_id)
        .bind(snapshot.observed_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("reconcile_agent_pending_snapshot", error))?;
        mark_prepared_pending_answers_uncertain_on(
            connection,
            &snapshot.interaction_session_id,
            &snapshot.runtime,
            Some(request_id.as_str()),
            snapshot.observed_at_ms,
            "reconcile_agent_pending_snapshot",
        )
        .await?;
        pending_changed = true;
    }
    sqlx::query(
        r#"
        UPDATE agent_provider_streams
        SET pending_snapshot_through_sequence = MAX(pending_snapshot_through_sequence, ?4)
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND retired_at_ms IS NULL
        "#,
    )
    .bind(snapshot.interaction_session_id.as_str())
    .bind(&snapshot.runtime.runtime_generation)
    .bind(&snapshot.runtime.provider_epoch)
    .bind(snapshot.observed_through_sequence)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("reconcile_agent_pending_snapshot", error))?;
    Ok(AgentTimelineCommitReceiptV1 {
        provider_cursor: AgentProviderCursorV1 {
            runtime: snapshot.runtime.clone(),
            committed_through_sequence: committed_through,
        },
        timeline_cursor: timeline_cursor_on(connection, &binding).await?,
        duplicate: false,
        timeline_changed: false,
        pending_changed,
        live_text_changed: false,
    })
}

async fn converge_pending_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
    observed_through_sequence: i64,
    request: &AgentPendingRequestDraftV1,
    observed_at_ms: i64,
) -> Result<bool, DomainStoreErrorV1> {
    if let Some((existing, state, _)) =
        pending_with_state_on(connection, interaction_session_id, &request.request_id).await?
    {
        if existing.runtime != *runtime || !same_pending_request(&existing.request, request) {
            return Err(identity_conflict(
                "agent_pending_request",
                request.request_id.as_str(),
                "authoritative snapshot conflicts with the stable request identity",
            ));
        }
        if state == "pending" {
            return Ok(false);
        }
        sqlx::query(
            r#"
            UPDATE agent_pending_requests
            SET state = 'pending', outcome_json = NULL,
                updated_at_ms = MAX(updated_at_ms, ?3)
            WHERE interaction_session_id = ?1 AND request_id = ?2
            "#,
        )
        .bind(interaction_session_id.as_str())
        .bind(request.request_id.as_str())
        .bind(observed_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("converge_agent_pending_request", error))?;
        return Ok(true);
    }
    put_pending_on(
        connection,
        interaction_session_id,
        runtime,
        observed_through_sequence,
        request,
        observed_at_ms,
    )
    .await
}

async fn mark_prepared_pending_answers_uncertain_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
    request_id: Option<&str>,
    updated_at_ms: i64,
    operation: &'static str,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        r#"
        UPDATE agent_pending_answer_effects
        SET state = 'uncertain', updated_at_ms = MAX(updated_at_ms, ?5)
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND (?4 IS NULL OR request_id = ?4)
          AND state = 'prepared'
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(&runtime.runtime_generation)
    .bind(&runtime.provider_epoch)
    .bind(request_id)
    .bind(updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx(operation, error))?;
    Ok(())
}

pub(crate) async fn record_turn_intent(
    pool: &SqlitePool,
    intent: &AgentStartTurnIntentV1,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    intent.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("record_agent_turn_intent", error))?;
    let result = record_turn_intent_on(&mut connection, intent).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("record_agent_turn_intent", error))?;
    Ok(result)
}

pub(crate) async fn prepare_continuation_turn(
    pool: &SqlitePool,
    request: &AgentContinueTurnRequestV1,
) -> Result<Option<AgentTurnEffectReceiptV1>, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("prepare_agent_continuation_turn", error))?;
    let result = prepare_continuation_on(&mut connection, request).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("prepare_agent_continuation_turn", error))?;
    Ok(result)
}

async fn prepare_continuation_on(
    connection: &mut SqliteConnection,
    request: &AgentContinueTurnRequestV1,
) -> Result<Option<AgentTurnEffectReceiptV1>, DomainStoreErrorV1> {
    let intent = &request.intent;
    // A replay observes its original effect even if that effect advanced the
    // conversation. It must never acquire a second execution claim.
    if turn_effect_on(
        connection,
        &intent.interaction_session_id,
        &intent.client_message_id,
    )
    .await?
    .is_some()
    {
        return record_turn_intent_on(connection, intent).await.map(Some);
    }
    let binding =
        validate_current_runtime(connection, &intent.interaction_session_id, &intent.runtime)
            .await?;
    ensure_open_on(connection, &binding.agent_id).await?;
    if timeline_cursor_on(connection, &binding).await? != request.expected_cursor
        || !automatic_turn_ready_on(connection, &binding).await?
    {
        return Ok(None);
    }
    record_turn_intent_on(connection, intent).await.map(Some)
}

pub(crate) async fn automatic_turn_ready_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<bool, DomainStoreErrorV1> {
    Ok(binding.history_complete
        && !crate::agent_queue::has_pending_on(connection, &binding.interaction_session_id).await?
        && active_turn_for_session(connection, binding)
            .await?
            .is_none()
        && pending_for_runtime(
            connection,
            &binding.interaction_session_id,
            &binding.runtime,
        )
        .await?
        .is_empty())
}

pub(crate) async fn record_steer_intent(
    pool: &SqlitePool,
    intent: &AgentStartTurnIntentV1,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    intent.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("record_agent_steer_intent", error))?;
    let result = record_steer_intent_on(&mut connection, intent).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("record_agent_steer_intent", error))?;
    Ok(result)
}

/// A steer joins the RUNNING turn: one durable user row under the active
/// turn's id, no TurnStarted lifecycle row, same idempotent effect tracking.
async fn record_steer_intent_on(
    connection: &mut SqliteConnection,
    intent: &AgentStartTurnIntentV1,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    if let Some(mut receipt) = turn_effect_on(
        connection,
        &intent.interaction_session_id,
        &intent.client_message_id,
    )
    .await?
    {
        if !same_start_turn_intent(&receipt.intent, intent) {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: format!(
                    "client message {:?} was replayed with different steer input",
                    intent.client_message_id
                ),
            });
        }
        receipt.newly_prepared = false;
        if receipt.state == AgentTurnEffectStateV1::Prepared {
            receipt.state = AgentTurnEffectStateV1::Uncertain;
        }
        return Ok(receipt);
    }
    let binding = required_binding(connection, &intent.interaction_session_id).await?;
    ensure_open_on(connection, &binding.agent_id).await?;
    crate::agent_queue::ensure_not_queued_on(connection, intent).await?;
    let binding =
        validate_current_runtime(connection, &intent.interaction_session_id, &intent.runtime)
            .await?;
    if active_turn_for_session(connection, &binding)
        .await?
        .is_none_or(|active| active.turn_id != intent.turn_id)
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent_turn",
            id: intent.turn_id.to_string(),
            reason: "the steering target is no longer the active turn".into(),
        });
    }
    let user = AgentTimelineItemDraftV1 {
        item_id: stable_item_id(
            "user-message",
            &(
                intent.interaction_session_id.clone(),
                intent.client_message_id.clone(),
            ),
        )?,
        turn_id: Some(intent.turn_id.clone()),
        client_message_id: Some(intent.client_message_id.clone()),
        provider_message_id: None,
        body: AgentTimelineItemBodyV1::Message {
            role: AgentTimelineMessageRoleV1::User,
            markdown: intent.input.clone(),
        },
        created_at_ms: intent.requested_at_ms,
    };
    append_item_on(connection, &binding, &user).await?;
    let timeline_cursor = timeline_cursor_on(connection, &binding).await?;
    sqlx::query(
        r#"
        INSERT INTO agent_turn_effects (
            interaction_session_id, client_message_id, runtime_generation,
            provider_epoch, turn_id, intent_json, state, provider_receipt_json,
            timeline_sequence, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', NULL, ?7, ?8)
        "#,
    )
    .bind(intent.interaction_session_id.as_str())
    .bind(intent.client_message_id.as_str())
    .bind(&intent.runtime.runtime_generation)
    .bind(&intent.runtime.provider_epoch)
    .bind(intent.turn_id.as_str())
    .bind(encode("agent_turn_intent", intent)?)
    .bind(timeline_cursor.sequence)
    .bind(intent.requested_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("record_agent_steer_intent", error))?;
    Ok(AgentTurnEffectReceiptV1 {
        intent: intent.clone(),
        state: AgentTurnEffectStateV1::Prepared,
        provider_receipt: None,
        timeline_cursor,
        newly_prepared: true,
        updated_at_ms: intent.requested_at_ms,
    })
}

pub(crate) async fn record_turn_intent_on(
    connection: &mut SqliteConnection,
    intent: &AgentStartTurnIntentV1,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    record_turn_intent_with_body_on(connection, intent, AgentTimelineItemBodyV1::Message {
        role: AgentTimelineMessageRoleV1::User,
        markdown: intent.input.clone(),
    }).await
}

pub(crate) async fn record_goal_turn_intent_on(
    connection: &mut SqliteConnection,
    intent: &AgentStartTurnIntentV1,
    objective: &str,
    goal_revision: u64,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    record_turn_intent_with_body_on(connection, intent, AgentTimelineItemBodyV1::GoalContinuation {
        objective: objective.into(), goal_revision,
    }).await
}

async fn record_turn_intent_with_body_on(
    connection: &mut SqliteConnection,
    intent: &AgentStartTurnIntentV1,
    body: AgentTimelineItemBodyV1,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    if let Some(mut receipt) = turn_effect_on(
        connection,
        &intent.interaction_session_id,
        &intent.client_message_id,
    )
    .await?
    {
        if !same_start_turn_intent(&receipt.intent, intent) {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: format!(
                    "client message {:?} was replayed with different turn input",
                    intent.client_message_id
                ),
            });
        }
        receipt.newly_prepared = false;
        if receipt.state == AgentTurnEffectStateV1::Prepared {
            receipt.state = AgentTurnEffectStateV1::Uncertain;
        }
        return Ok(receipt);
    }
    let binding = required_binding(connection, &intent.interaction_session_id).await?;
    ensure_open_on(connection, &binding.agent_id).await?;
    crate::agent_queue::ensure_not_queued_on(connection, intent).await?;
    let binding =
        validate_current_runtime(connection, &intent.interaction_session_id, &intent.runtime)
            .await?;
    // Admission and the start row share the write transaction. An earlier
    // client snapshot cannot replace work another client already admitted.
    if active_turn_for_session(connection, &binding).await?.is_some() {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "agent_turn",
            id: intent.turn_id.to_string(),
            reason: "another turn is already active in this conversation".into(),
        });
    }
    let started = AgentTimelineItemDraftV1 {
        item_id: stable_item_id(
            "turn-start",
            &(
                intent.interaction_session_id.clone(),
                intent.turn_id.clone(),
            ),
        )?,
        turn_id: Some(intent.turn_id.clone()),
        client_message_id: Some(intent.client_message_id.clone()),
        provider_message_id: None,
        body: AgentTimelineItemBodyV1::Lifecycle {
            state: AgentTimelineLifecycleStateV1::TurnStarted,
            detail: None,
        },
        created_at_ms: intent.requested_at_ms,
    };
    append_item_on(connection, &binding, &started).await?;
    let user = AgentTimelineItemDraftV1 {
        item_id: stable_item_id(
            "user-message",
            &(
                intent.interaction_session_id.clone(),
                intent.client_message_id.clone(),
            ),
        )?,
        turn_id: Some(intent.turn_id.clone()),
        client_message_id: Some(intent.client_message_id.clone()),
        provider_message_id: None,
        body,
        created_at_ms: intent.requested_at_ms,
    };
    append_item_on(connection, &binding, &user).await?;
    let timeline_cursor = timeline_cursor_on(connection, &binding).await?;
    sqlx::query(
        r#"
        INSERT INTO agent_turn_effects (
            interaction_session_id, client_message_id, runtime_generation,
            provider_epoch, turn_id, intent_json, state, provider_receipt_json,
            timeline_sequence, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', NULL, ?7, ?8)
        "#,
    )
    .bind(intent.interaction_session_id.as_str())
    .bind(intent.client_message_id.as_str())
    .bind(&intent.runtime.runtime_generation)
    .bind(&intent.runtime.provider_epoch)
    .bind(intent.turn_id.as_str())
    .bind(encode("agent_turn_intent", intent)?)
    .bind(timeline_cursor.sequence)
    .bind(intent.requested_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("record_agent_turn_intent", error))?;
    Ok(AgentTurnEffectReceiptV1 {
        intent: intent.clone(),
        state: AgentTurnEffectStateV1::Prepared,
        provider_receipt: None,
        timeline_cursor,
        newly_prepared: true,
        updated_at_ms: intent.requested_at_ms,
    })
}

pub(crate) async fn complete_turn_effect(
    pool: &SqlitePool,
    completion: &AgentCompleteTurnEffectV1,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    completion.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("complete_agent_turn_effect", error))?;
    let result = complete_turn_effect_on(&mut connection, completion).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("complete_agent_turn_effect", error))?;
    Ok(result)
}

async fn complete_turn_effect_on(
    connection: &mut SqliteConnection,
    completion: &AgentCompleteTurnEffectV1,
) -> Result<AgentTurnEffectReceiptV1, DomainStoreErrorV1> {
    let binding = validate_current_runtime(
        connection,
        &completion.interaction_session_id,
        &completion.runtime,
    )
    .await?;
    let mut receipt = turn_effect_on(
        connection,
        &completion.interaction_session_id,
        &completion.client_message_id,
    )
    .await?
    .ok_or_else(|| DomainStoreErrorV1::NotFound {
        entity: "agent_turn_effect",
        id: completion.client_message_id.to_string(),
    })?;
    if receipt.intent.runtime != completion.runtime {
        return Err(identity_conflict(
            "agent_turn_effect",
            completion.client_message_id.as_str(),
            "turn belongs to a different provider runtime",
        ));
    }
    if receipt.state != AgentTurnEffectStateV1::Prepared {
        if receipt.state == completion.state
            && receipt.provider_receipt == completion.provider_receipt
        {
            receipt.newly_prepared = false;
            return Ok(receipt);
        }
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "turn effect was already completed differently".into(),
        });
    }
    let timeline_sequence = if completion.state == AgentTurnEffectStateV1::Failed
        && close_rejected_start_turn_on(connection, &binding, &receipt, completion.updated_at_ms)
            .await?
    {
        timeline_cursor_on(connection, &binding).await?.sequence
    } else {
        receipt.timeline_cursor.sequence
    };
    sqlx::query(
        r#"
        UPDATE agent_turn_effects
        SET state = ?3, provider_receipt_json = ?4, timeline_sequence = ?5,
            updated_at_ms = MAX(updated_at_ms, ?6)
        WHERE interaction_session_id = ?1 AND client_message_id = ?2
        "#,
    )
    .bind(completion.interaction_session_id.as_str())
    .bind(completion.client_message_id.as_str())
    .bind(turn_state(&completion.state))
    .bind(optional_json(
        "agent_turn_provider_receipt",
        completion.provider_receipt.as_ref(),
    )?)
    .bind(timeline_sequence)
    .bind(completion.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("complete_agent_turn_effect", error))?;
    turn_effect_on(
        connection,
        &completion.interaction_session_id,
        &completion.client_message_id,
    )
    .await?
    .ok_or_else(|| storage("turn_effect_lost", "completed turn effect disappeared"))
}

async fn close_rejected_start_turn_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
    receipt: &AgentTurnEffectReceiptV1,
    failed_at_ms: i64,
) -> Result<bool, DomainStoreErrorV1> {
    let Some(active_turn) = active_turn_for_session(connection, binding).await? else {
        return Ok(false);
    };
    if active_turn.client_message_id != receipt.intent.client_message_id {
        return Ok(false);
    }
    append_item_on(
        connection,
        binding,
        &AgentTimelineItemDraftV1 {
            item_id: stable_item_id(
                "turn-start-rejected",
                &(
                    binding.interaction_session_id.clone(),
                    active_turn.client_message_id.clone(),
                ),
            )?,
            turn_id: Some(active_turn.turn_id),
            client_message_id: Some(active_turn.client_message_id),
            provider_message_id: None,
            body: AgentTimelineItemBodyV1::Lifecycle {
                state: AgentTimelineLifecycleStateV1::TurnFailed,
                detail: Some(
                    dure_app::AgentTurnFailureReasonV1::ProviderError
                        .as_token()
                        .into(),
                ),
            },
            created_at_ms: failed_at_ms,
        },
    )
    .await
}

pub(crate) async fn prepare_pending_answer(
    pool: &SqlitePool,
    intent: &AgentPendingAnswerIntentV1,
) -> Result<AgentPendingAnswerReceiptV1, DomainStoreErrorV1> {
    intent.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("prepare_agent_pending_answer", error))?;
    let result = prepare_pending_answer_on(&mut connection, intent).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("prepare_agent_pending_answer", error))?;
    Ok(result)
}

async fn prepare_pending_answer_on(
    connection: &mut SqliteConnection,
    intent: &AgentPendingAnswerIntentV1,
) -> Result<AgentPendingAnswerReceiptV1, DomainStoreErrorV1> {
    if let Some(mut receipt) = pending_answer_on(connection, &intent.idempotency_key).await? {
        if !same_pending_answer_intent(&receipt.intent, intent) {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: "pending-answer key was replayed with different input".into(),
            });
        }
        receipt.newly_prepared = false;
        return Ok(receipt);
    }
    let binding = required_binding(connection, &intent.interaction_session_id).await?;
    ensure_open_on(connection, &binding.agent_id).await?;
    validate_current_runtime(connection, &intent.interaction_session_id, &intent.runtime).await?;
    let Some((request, state, _)) = pending_with_state_on(
        connection,
        &intent.interaction_session_id,
        &intent.request_id,
    )
    .await?
    else {
        return Err(identity_conflict(
            "agent_pending_answer",
            intent.request_id.as_str(),
            "pending request does not exist",
        ));
    };
    if state != "pending"
        || request.runtime != intent.runtime
        || request.request.client_message_id != intent.client_message_id
    {
        return Err(identity_conflict(
            "agent_pending_answer",
            intent.request_id.as_str(),
            "pending request identity is stale",
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO agent_pending_answer_effects (
            idempotency_key, interaction_session_id, request_id, runtime_generation,
            provider_epoch, intent_json, request_json, state, provider_receipt_json,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'prepared', NULL, ?8)
        "#,
    )
    .bind(&intent.idempotency_key)
    .bind(intent.interaction_session_id.as_str())
    .bind(intent.request_id.as_str())
    .bind(&intent.runtime.runtime_generation)
    .bind(&intent.runtime.provider_epoch)
    .bind(encode("agent_pending_answer_intent", intent)?)
    .bind(encode("agent_pending_request", &request)?)
    .bind(intent.requested_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("prepare_agent_pending_answer", error))?;
    Ok(AgentPendingAnswerReceiptV1 {
        intent: intent.clone(),
        request,
        state: AgentPendingAnswerStateV1::Prepared,
        provider_receipt: None,
        newly_prepared: true,
        updated_at_ms: intent.requested_at_ms,
    })
}

pub(crate) async fn complete_pending_answer(
    pool: &SqlitePool,
    completion: &AgentCompletePendingAnswerV1,
) -> Result<AgentPendingAnswerReceiptV1, DomainStoreErrorV1> {
    completion.validate()?;
    let mut connection = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| map_sqlx("complete_agent_pending_answer", error))?;
    let result = complete_pending_answer_on(&mut connection, completion).await?;
    connection
        .commit()
        .await
        .map_err(|error| map_sqlx("complete_agent_pending_answer", error))?;
    Ok(result)
}

async fn complete_pending_answer_on(
    connection: &mut SqliteConnection,
    completion: &AgentCompletePendingAnswerV1,
) -> Result<AgentPendingAnswerReceiptV1, DomainStoreErrorV1> {
    let mut receipt = pending_answer_on(connection, &completion.idempotency_key)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "agent_pending_answer",
            id: completion.idempotency_key.clone(),
        })?;
    if receipt.state != AgentPendingAnswerStateV1::Prepared {
        if receipt.state == completion.state
            && receipt.provider_receipt == completion.provider_receipt
        {
            receipt.newly_prepared = false;
            return Ok(receipt);
        }
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "pending answer was already completed differently".into(),
        });
    }
    let binding = validate_current_runtime(
        connection,
        &receipt.intent.interaction_session_id,
        &receipt.intent.runtime,
    )
    .await?;
    sqlx::query(
        r#"
        UPDATE agent_pending_answer_effects
        SET state = ?2, provider_receipt_json = ?3, updated_at_ms = MAX(updated_at_ms, ?4)
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(&completion.idempotency_key)
    .bind(pending_answer_state(&completion.state))
    .bind(optional_json(
        "agent_pending_answer_provider_receipt",
        completion.provider_receipt.as_ref(),
    )?)
    .bind(completion.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("complete_agent_pending_answer", error))?;
    if completion.state == AgentPendingAnswerStateV1::Succeeded {
        append_item_on(
            connection,
            &binding,
            &AgentTimelineItemDraftV1 {
                item_id: stable_item_id(
                    "pending-answer",
                    &(
                        &receipt.intent.interaction_session_id,
                        &completion.idempotency_key,
                    ),
                )?,
                turn_id: receipt.request.request.turn_id.clone(),
                client_message_id: Some(receipt.intent.client_message_id.clone()),
                provider_message_id: None,
                body: AgentTimelineItemBodyV1::PendingAnswer {
                    idempotency_key: completion.idempotency_key.clone(),
                    request: Box::new(receipt.request.clone()),
                    answer: receipt.intent.answer.clone(),
                },
                created_at_ms: completion.updated_at_ms,
            },
        )
        .await?;
        settle_pending_on(
            connection,
            &receipt.intent.interaction_session_id,
            &receipt.intent.runtime,
            &receipt.intent.request_id,
            "resolved",
            completion.provider_receipt.as_ref().unwrap_or(&Value::Null),
            completion.updated_at_ms,
        )
        .await?;
    }
    pending_answer_on(connection, &completion.idempotency_key)
        .await?
        .ok_or_else(|| {
            storage(
                "pending_answer_lost",
                "completed pending answer disappeared",
            )
        })
}

pub(crate) async fn read(
    pool: &SqlitePool,
    request: &AgentTimelineReadRequestV1,
) -> Result<AgentTimelineReadV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut transaction = pool
        .begin_with("BEGIN DEFERRED")
        .await
        .map_err(|error| map_sqlx("read_agent_timeline", error))?;
    let result = read_on(&mut transaction, request).await?;
    transaction
        .commit()
        .await
        .map_err(|error| map_sqlx("read_agent_timeline", error))?;
    Ok(result)
}

async fn read_on(
    connection: &mut SqliteConnection,
    request: &AgentTimelineReadRequestV1,
) -> Result<AgentTimelineReadV1, DomainStoreErrorV1> {
    let binding = required_binding(connection, &request.interaction_session_id).await?;
    if let Some(cursor) = &request.cursor
        && cursor.epoch != binding.timeline_epoch
    {
        return Ok(AgentTimelineReadV1::Reset {
            binding,
            reason: "stale_cursor".into(),
        });
    }
    let fetch_limit = i64::try_from(request.limit + 1)
        .map_err(|_| storage("timeline_page_limit", "page limit is outside SQLite i64"))?;
    let mut rows = match request.direction {
        AgentTimelineReadDirectionV1::After => {
            sqlx::query(
                r#"
                SELECT timeline_epoch, sequence, item_id, turn_id, client_message_id,
                       provider_message_id, body_json, created_at_ms
                FROM agent_timeline_rows
                WHERE interaction_session_id = ?1 AND timeline_epoch = ?2 AND sequence > ?3
                ORDER BY sequence ASC LIMIT ?4
                "#,
            )
            .bind(request.interaction_session_id.as_str())
            .bind(binding.timeline_epoch.as_str())
            .bind(request.cursor.as_ref().expect("validated cursor").sequence)
            .bind(fetch_limit)
            .fetch_all(&mut *connection)
            .await
        }
        AgentTimelineReadDirectionV1::Before => {
            sqlx::query(
                r#"
                SELECT timeline_epoch, sequence, item_id, turn_id, client_message_id,
                       provider_message_id, body_json, created_at_ms
                FROM agent_timeline_rows
                WHERE interaction_session_id = ?1 AND timeline_epoch = ?2 AND sequence < ?3
                ORDER BY sequence DESC LIMIT ?4
                "#,
            )
            .bind(request.interaction_session_id.as_str())
            .bind(binding.timeline_epoch.as_str())
            .bind(request.cursor.as_ref().expect("validated cursor").sequence)
            .bind(fetch_limit)
            .fetch_all(&mut *connection)
            .await
        }
        AgentTimelineReadDirectionV1::Tail => {
            sqlx::query(
                r#"
                SELECT timeline_epoch, sequence, item_id, turn_id, client_message_id,
                       provider_message_id, body_json, created_at_ms
                FROM agent_timeline_rows
                WHERE interaction_session_id = ?1 AND timeline_epoch = ?2
                ORDER BY sequence DESC LIMIT ?3
                "#,
            )
            .bind(request.interaction_session_id.as_str())
            .bind(binding.timeline_epoch.as_str())
            .bind(fetch_limit)
            .fetch_all(&mut *connection)
            .await
        }
    }
    .map_err(|error| map_sqlx("read_agent_timeline", error))?;
    let has_more = rows.len() > request.limit;
    rows.truncate(request.limit);
    let descending = matches!(
        request.direction,
        AgentTimelineReadDirectionV1::Before | AgentTimelineReadDirectionV1::Tail
    );
    if descending {
        rows.reverse();
    }
    let rows = rows
        .into_iter()
        .map(timeline_row_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let latest_cursor = timeline_cursor_on(connection, &binding).await?;
    let final_cursor = match request.direction {
        AgentTimelineReadDirectionV1::After => AgentTimelineCursorV1 {
            epoch: binding.timeline_epoch.clone(),
            sequence: rows.last().map_or_else(
                || request.cursor.as_ref().expect("validated cursor").sequence,
                |row| row.cursor.sequence,
            ),
        },
        AgentTimelineReadDirectionV1::Before => rows
            .first()
            .map(|row| row.cursor.clone())
            .unwrap_or_else(|| request.cursor.as_ref().expect("validated cursor").clone()),
        AgentTimelineReadDirectionV1::Tail => latest_cursor,
    };
    let live_text = live_text_for_session(connection, &binding.interaction_session_id).await?;
    let pending_requests = pending_for_runtime(
        connection,
        &binding.interaction_session_id,
        &binding.runtime,
    )
    .await?;
    let active_turn = active_turn_for_session(connection, &binding).await?;
    let latest_failure = latest_failure_on(connection, &binding).await?;
    let goal = crate::agent_goals::read_on(connection, &binding.agent_id).await?;
    let queued_inputs =
        crate::agent_queue::pending_on(connection, &binding.interaction_session_id, 0).await?;
    Ok(AgentTimelineReadV1::Page {
        page: AgentTimelinePageV1 {
            binding,
            rows,
            live_text,
            pending_requests,
            active_turn,
            latest_failure,
            goal,
            queued_inputs,
            final_cursor,
            has_more,
        },
    })
}

async fn latest_failure_on(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<Option<AgentTimelineFailureV1>, DomainStoreErrorV1> {
    // Select the latest turn boundary first. An unknown failure or newer human
    // input must not expose an older classified failure as current.
    let row = sqlx::query(
        "SELECT timeline_epoch, sequence, item_id, turn_id, client_message_id, \
         provider_message_id, body_json, created_at_ms FROM agent_timeline_rows \
         WHERE interaction_session_id = ?1 AND timeline_epoch = ?2 \
         AND ((json_extract(body_json, '$.type') = 'message' \
               AND json_extract(body_json, '$.role') = 'user') \
           OR (json_extract(body_json, '$.type') = 'lifecycle' \
               AND json_extract(body_json, '$.state') IN \
                 ('turn_started', 'turn_completed', 'turn_failed', 'turn_canceled'))) \
         ORDER BY sequence DESC LIMIT 1",
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_latest_failure", error))?;
    let Some(row) = row else { return Ok(None) };
    let failure = timeline_row_from_row(row)?;
    let AgentTimelineItemBodyV1::Lifecycle {
        state: AgentTimelineLifecycleStateV1::TurnFailed,
        detail: Some(detail),
    } = &failure.item.body
    else {
        return Ok(None);
    };
    let Some(reason) = dure_app::AgentTurnFailureReasonV1::from_token(detail) else {
        return Ok(None);
    };
    let user_input = sqlx::query_scalar::<_, String>(
        "SELECT json_extract(body_json, '$.markdown') FROM agent_timeline_rows \
         WHERE interaction_session_id = ?1 AND timeline_epoch = ?2 AND sequence < ?3 \
         AND (turn_id = ?4 OR client_message_id = ?5) \
         AND json_extract(body_json, '$.type') = 'message' \
         AND json_extract(body_json, '$.role') = 'user' \
         ORDER BY sequence DESC LIMIT 1",
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .bind(failure.cursor.sequence)
    .bind(failure.item.turn_id.as_ref().map(|id| id.as_str()))
    .bind(
        failure
            .item
            .client_message_id
            .as_ref()
            .map(|id| id.as_str()),
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_failed_input", error))?;
    Ok(Some(AgentTimelineFailureV1 {
        item_id: failure.item.item_id,
        created_at_ms: failure.item.created_at_ms,
        reason,
        user_input,
    }))
}

pub(crate) async fn active_turn_for_session(
    connection: &mut SqliteConnection,
    binding: &AgentInteractionBindingV1,
) -> Result<Option<AgentTimelineActiveTurnV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        WITH latest_start AS (
            SELECT sequence, turn_id, client_message_id
            FROM agent_timeline_rows
            WHERE interaction_session_id = ?1
              AND timeline_epoch = ?2
              AND json_valid(body_json) = 1
              AND json_extract(body_json, '$.type') = 'lifecycle'
              AND json_extract(body_json, '$.state') = 'turn_started'
              AND turn_id IS NOT NULL
              AND client_message_id IS NOT NULL
            ORDER BY sequence DESC
            LIMIT 1
        )
        SELECT started.turn_id, started.client_message_id
        FROM latest_start AS started
        WHERE NOT EXISTS (
            SELECT 1
            FROM agent_timeline_rows AS terminal
            WHERE terminal.interaction_session_id = ?1
              AND terminal.timeline_epoch = ?2
              AND terminal.sequence > started.sequence
              AND json_valid(terminal.body_json) = 1
              AND json_extract(terminal.body_json, '$.type') = 'lifecycle'
              AND json_extract(terminal.body_json, '$.state') IN (
                  'turn_completed', 'turn_failed', 'turn_canceled'
              )
              AND (
                  terminal.turn_id IS NOT NULL
                  OR terminal.client_message_id IS NOT NULL
              )
              AND (
                  terminal.turn_id IS NULL
                  OR terminal.turn_id = started.turn_id
              )
              AND (
                  terminal.client_message_id IS NULL
                  OR terminal.client_message_id = started.client_message_id
              )
        )
          AND NOT EXISTS (
              SELECT 1
              FROM agent_timeline_rows AS stopped
              WHERE stopped.interaction_session_id = ?1
                AND stopped.timeline_epoch = ?2
                AND stopped.sequence > started.sequence
                AND json_valid(stopped.body_json) = 1
                AND json_extract(stopped.body_json, '$.type') = 'lifecycle'
                AND json_extract(stopped.body_json, '$.state') IN (
                    'session_failed', 'session_exited'
                )
          )
          AND (
              SELECT COUNT(*)
              FROM agent_timeline_rows AS ready
              WHERE ready.interaction_session_id = ?1
                AND ready.timeline_epoch = ?2
                AND ready.sequence > started.sequence
                AND json_valid(ready.body_json) = 1
                AND json_extract(ready.body_json, '$.type') = 'lifecycle'
                AND json_extract(ready.body_json, '$.state') = 'session_ready'
          ) <= CASE COALESCE((
              SELECT json_extract(previous.body_json, '$.state')
              FROM agent_timeline_rows AS previous
              WHERE previous.interaction_session_id = ?1
                AND previous.timeline_epoch = ?2
                AND previous.sequence < started.sequence
                AND json_valid(previous.body_json) = 1
                AND json_extract(previous.body_json, '$.type') = 'lifecycle'
                AND json_extract(previous.body_json, '$.state') IN (
                    'session_ready', 'session_failed', 'session_exited'
                )
              ORDER BY previous.sequence DESC
              LIMIT 1
          ), 'session_exited')
              WHEN 'session_ready' THEN 0
              ELSE 1
          END
        "#,
    )
    .bind(binding.interaction_session_id.as_str())
    .bind(binding.timeline_epoch.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_timeline_active_turn", error))?;
    row.map(|row| {
        Ok(AgentTimelineActiveTurnV1 {
            turn_id: parse_id(
                "agent_timeline_rows.turn_id",
                row.try_get("turn_id")
                    .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
                AgentTurnIdV1::new,
            )?,
            client_message_id: parse_id(
                "agent_timeline_rows.client_message_id",
                row.try_get("client_message_id")
                    .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
                AgentClientMessageIdV1::new,
            )?,
        })
    })
    .transpose()
}

async fn live_text_for_session(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
) -> Result<Vec<AgentTimelineLiveTextV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT stream_id, item_id, kind, text_value, turn_id, client_message_id,
               provider_message_id, updated_at_ms
        FROM agent_timeline_live_text
        WHERE interaction_session_id = ?1
        ORDER BY stream_id
        LIMIT ?2
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(
        i64::try_from(MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1 + 1)
            .map_err(|_| storage("timeline_live_text_limit", "live-head limit is outside i64"))?,
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_timeline_live_text", error))?;
    if rows.len() > MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1 {
        return Err(storage(
            "corrupt_agent_timeline_live_text",
            "stored live-head count exceeds its bound",
        ));
    }
    rows.into_iter().map(live_text_from_row).collect()
}

pub(crate) async fn pending_for_runtime(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    runtime: &AgentProviderRuntimeFenceV1,
) -> Result<Vec<AgentPendingRequestV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT interaction_session_id, request_id, runtime_generation, provider_epoch,
               kind, turn_id, client_message_id, payload_json, state, outcome_json,
               created_at_ms, updated_at_ms
        FROM agent_pending_requests
        WHERE interaction_session_id = ?1
          AND runtime_generation = ?2
          AND provider_epoch = ?3
          AND state = 'pending'
        ORDER BY created_at_ms, request_id
        LIMIT ?4
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(&runtime.runtime_generation)
    .bind(&runtime.provider_epoch)
    .bind(
        i64::try_from(MAX_AGENT_PENDING_REQUESTS_V1 + 1)
            .map_err(|_| storage("pending_request_limit", "pending limit is outside i64"))?,
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_pending_requests", error))?;
    if rows.len() > MAX_AGENT_PENDING_REQUESTS_V1 {
        return Err(storage(
            "corrupt_agent_pending_requests",
            "stored pending-request count exceeds its bound",
        ));
    }
    rows.into_iter().map(|row| pending_from_row(&row)).collect()
}

async fn pending_with_state_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    request_id: &AgentInteractionRequestIdV1,
) -> Result<Option<(AgentPendingRequestV1, String, Option<Value>)>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT interaction_session_id, request_id, runtime_generation, provider_epoch,
               kind, turn_id, client_message_id, payload_json, state, outcome_json,
               created_at_ms, updated_at_ms
        FROM agent_pending_requests
        WHERE interaction_session_id = ?1 AND request_id = ?2
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(request_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_pending_request", error))?;
    row.map(|row| {
        let request = pending_from_row(&row)?;
        let state = row
            .try_get("state")
            .map_err(|error| corrupt_row("agent_pending_requests", error))?;
        let outcome = row
            .try_get::<Option<String>, _>("outcome_json")
            .map_err(|error| corrupt_row("agent_pending_requests", error))?
            .map(|source| decode("agent_pending_outcome", &source))
            .transpose()?;
        Ok((request, state, outcome))
    })
    .transpose()
}

fn pending_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<AgentPendingRequestV1, DomainStoreErrorV1> {
    let payload_source: String = row
        .try_get("payload_json")
        .map_err(|error| corrupt_row("agent_pending_requests", error))?;
    let record = AgentPendingRequestV1 {
        interaction_session_id: parse_id(
            "agent_pending_requests.interaction_session_id",
            row.try_get("interaction_session_id")
                .map_err(|error| corrupt_row("agent_pending_requests", error))?,
            AgentInteractionSessionIdV1::new,
        )?,
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: row
                .try_get("runtime_generation")
                .map_err(|error| corrupt_row("agent_pending_requests", error))?,
            provider_epoch: row
                .try_get("provider_epoch")
                .map_err(|error| corrupt_row("agent_pending_requests", error))?,
        },
        request: AgentPendingRequestDraftV1 {
            request_id: parse_id(
                "agent_pending_requests.request_id",
                row.try_get("request_id")
                    .map_err(|error| corrupt_row("agent_pending_requests", error))?,
                AgentInteractionRequestIdV1::new,
            )?,
            kind: parse_pending_kind(
                &row.try_get::<String, _>("kind")
                    .map_err(|error| corrupt_row("agent_pending_requests", error))?,
            )?,
            turn_id: parse_optional_id(
                "agent_pending_requests.turn_id",
                row.try_get("turn_id")
                    .map_err(|error| corrupt_row("agent_pending_requests", error))?,
                AgentTurnIdV1::new,
            )?,
            client_message_id: parse_id(
                "agent_pending_requests.client_message_id",
                row.try_get("client_message_id")
                    .map_err(|error| corrupt_row("agent_pending_requests", error))?,
                AgentClientMessageIdV1::new,
            )?,
            payload: decode("agent_pending_request_payload", &payload_source)?,
            created_at_ms: row
                .try_get("created_at_ms")
                .map_err(|error| corrupt_row("agent_pending_requests", error))?,
        },
    };
    record
        .runtime
        .validate()
        .map_err(|error| storage("corrupt_agent_pending_request", error.to_string()))?;
    record
        .request
        .validate()
        .map_err(|error| storage("corrupt_agent_pending_request", error.to_string()))?;
    Ok(record)
}

fn timeline_row_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<AgentTimelineRowV1, DomainStoreErrorV1> {
    let body_source: String = row
        .try_get("body_json")
        .map_err(|error| corrupt_row("agent_timeline_rows", error))?;
    let record = AgentTimelineRowV1 {
        cursor: AgentTimelineCursorV1 {
            epoch: parse_id(
                "agent_timeline_rows.timeline_epoch",
                row.try_get("timeline_epoch")
                    .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
                AgentTimelineEpochV1::new,
            )?,
            sequence: row
                .try_get("sequence")
                .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
        },
        item: AgentTimelineItemDraftV1 {
            item_id: parse_id(
                "agent_timeline_rows.item_id",
                row.try_get("item_id")
                    .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
                AgentTimelineItemIdV1::new,
            )?,
            turn_id: parse_optional_id(
                "agent_timeline_rows.turn_id",
                row.try_get("turn_id")
                    .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
                AgentTurnIdV1::new,
            )?,
            client_message_id: parse_optional_id(
                "agent_timeline_rows.client_message_id",
                row.try_get("client_message_id")
                    .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
                AgentClientMessageIdV1::new,
            )?,
            provider_message_id: parse_optional_id(
                "agent_timeline_rows.provider_message_id",
                row.try_get("provider_message_id")
                    .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
                AgentProviderMessageIdV1::new,
            )?,
            body: decode("agent_timeline_item", &body_source)?,
            created_at_ms: row
                .try_get("created_at_ms")
                .map_err(|error| corrupt_row("agent_timeline_rows", error))?,
        },
    };
    record
        .cursor
        .validate()
        .map_err(|error| storage("corrupt_agent_timeline_row", error.to_string()))?;
    record
        .item
        .validate()
        .map_err(|error| storage("corrupt_agent_timeline_row", error.to_string()))?;
    Ok(record)
}

fn live_text_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<AgentTimelineLiveTextV1, DomainStoreErrorV1> {
    let record = AgentTimelineLiveTextV1 {
        stream_id: parse_id(
            "agent_timeline_live_text.stream_id",
            row.try_get("stream_id")
                .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
            AgentTimelineStreamIdV1::new,
        )?,
        item_id: parse_id(
            "agent_timeline_live_text.item_id",
            row.try_get("item_id")
                .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
            AgentTimelineItemIdV1::new,
        )?,
        kind: parse_text_kind(
            &row.try_get::<String, _>("kind")
                .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
        )?,
        text: row
            .try_get("text_value")
            .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
        turn_id: parse_optional_id(
            "agent_timeline_live_text.turn_id",
            row.try_get("turn_id")
                .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
            AgentTurnIdV1::new,
        )?,
        client_message_id: parse_optional_id(
            "agent_timeline_live_text.client_message_id",
            row.try_get("client_message_id")
                .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
            AgentClientMessageIdV1::new,
        )?,
        provider_message_id: parse_id(
            "agent_timeline_live_text.provider_message_id",
            row.try_get("provider_message_id")
                .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
            AgentProviderMessageIdV1::new,
        )?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("agent_timeline_live_text", error))?,
    };
    if record.text.len() > MAX_AGENT_TIMELINE_TEXT_BYTES_V1 || record.updated_at_ms < 0 {
        return Err(storage(
            "corrupt_agent_timeline_live_text",
            "stored live text exceeds its bounds",
        ));
    }
    Ok(record)
}

pub(crate) async fn turn_effect_on(
    connection: &mut SqliteConnection,
    interaction_session_id: &AgentInteractionSessionIdV1,
    client_message_id: &AgentClientMessageIdV1,
) -> Result<Option<AgentTurnEffectReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT intent_json, state, provider_receipt_json, timeline_sequence, updated_at_ms
        FROM agent_turn_effects
        WHERE interaction_session_id = ?1 AND client_message_id = ?2
        "#,
    )
    .bind(interaction_session_id.as_str())
    .bind(client_message_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_turn_effect", error))?;
    let Some(row) = row else { return Ok(None) };
    let intent_source: String = row
        .try_get("intent_json")
        .map_err(|error| corrupt_row("agent_turn_effects", error))?;
    let intent: AgentStartTurnIntentV1 = decode("agent_turn_intent", &intent_source)?;
    let binding = required_binding(connection, interaction_session_id).await?;
    let provider_receipt = row
        .try_get::<Option<String>, _>("provider_receipt_json")
        .map_err(|error| corrupt_row("agent_turn_effects", error))?
        .map(|source| decode("agent_turn_provider_receipt", &source))
        .transpose()?;
    Ok(Some(AgentTurnEffectReceiptV1 {
        intent,
        state: parse_turn_state(
            &row.try_get::<String, _>("state")
                .map_err(|error| corrupt_row("agent_turn_effects", error))?,
        )?,
        provider_receipt,
        timeline_cursor: AgentTimelineCursorV1 {
            epoch: binding.timeline_epoch,
            sequence: row
                .try_get("timeline_sequence")
                .map_err(|error| corrupt_row("agent_turn_effects", error))?,
        },
        newly_prepared: false,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("agent_turn_effects", error))?,
    }))
}

async fn pending_answer_on(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<AgentPendingAnswerReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT intent_json, request_json, state, provider_receipt_json, updated_at_ms
        FROM agent_pending_answer_effects WHERE idempotency_key = ?1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_pending_answer", error))?;
    row.map(|row| {
        let intent_source: String = row
            .try_get("intent_json")
            .map_err(|error| corrupt_row("agent_pending_answer_effects", error))?;
        let request_source: String = row
            .try_get("request_json")
            .map_err(|error| corrupt_row("agent_pending_answer_effects", error))?;
        let provider_receipt = row
            .try_get::<Option<String>, _>("provider_receipt_json")
            .map_err(|error| corrupt_row("agent_pending_answer_effects", error))?
            .map(|source| decode("agent_pending_answer_provider_receipt", &source))
            .transpose()?;
        Ok(AgentPendingAnswerReceiptV1 {
            intent: decode("agent_pending_answer_intent", &intent_source)?,
            request: decode("agent_pending_request", &request_source)?,
            state: parse_pending_answer_state(
                &row.try_get::<String, _>("state")
                    .map_err(|error| corrupt_row("agent_pending_answer_effects", error))?,
            )?,
            provider_receipt,
            newly_prepared: false,
            updated_at_ms: row
                .try_get("updated_at_ms")
                .map_err(|error| corrupt_row("agent_pending_answer_effects", error))?,
        })
    })
    .transpose()
}

fn parse_optional_id<T, E>(
    field: &'static str,
    value: Option<String>,
    constructor: impl Fn(String) -> Result<T, E> + Copy,
) -> Result<Option<T>, DomainStoreErrorV1>
where
    E: std::fmt::Display,
{
    value
        .map(|value| parse_id(field, value, constructor))
        .transpose()
}

fn optional_json(
    entity: &'static str,
    value: Option<&Value>,
) -> Result<Option<String>, DomainStoreErrorV1> {
    value.map(|value| encode(entity, value)).transpose()
}

fn text_kind(value: &AgentTimelineTextKindV1) -> &'static str {
    match value {
        AgentTimelineTextKindV1::Assistant => "assistant",
        AgentTimelineTextKindV1::Reasoning => "reasoning",
        AgentTimelineTextKindV1::ToolInput => "tool_input",
    }
}

fn parse_text_kind(value: &str) -> Result<AgentTimelineTextKindV1, DomainStoreErrorV1> {
    match value {
        "assistant" => Ok(AgentTimelineTextKindV1::Assistant),
        "reasoning" => Ok(AgentTimelineTextKindV1::Reasoning),
        "tool_input" => Ok(AgentTimelineTextKindV1::ToolInput),
        _ => Err(storage(
            "corrupt_agent_timeline_live_text",
            format!("unknown live text kind {value:?}"),
        )),
    }
}

fn pending_kind(value: &AgentPendingRequestKindV1) -> &'static str {
    match value {
        AgentPendingRequestKindV1::Permission => "permission",
        AgentPendingRequestKindV1::Question => "question",
    }
}

fn parse_pending_kind(value: &str) -> Result<AgentPendingRequestKindV1, DomainStoreErrorV1> {
    match value {
        "permission" => Ok(AgentPendingRequestKindV1::Permission),
        "question" => Ok(AgentPendingRequestKindV1::Question),
        _ => Err(storage(
            "corrupt_agent_pending_request",
            format!("unknown pending request kind {value:?}"),
        )),
    }
}

fn turn_state(value: &AgentTurnEffectStateV1) -> &'static str {
    match value {
        AgentTurnEffectStateV1::Prepared => "prepared",
        AgentTurnEffectStateV1::Accepted => "accepted",
        AgentTurnEffectStateV1::Failed => "failed",
        AgentTurnEffectStateV1::Uncertain => "uncertain",
    }
}

fn parse_turn_state(value: &str) -> Result<AgentTurnEffectStateV1, DomainStoreErrorV1> {
    match value {
        "prepared" => Ok(AgentTurnEffectStateV1::Prepared),
        "accepted" => Ok(AgentTurnEffectStateV1::Accepted),
        "failed" => Ok(AgentTurnEffectStateV1::Failed),
        "uncertain" => Ok(AgentTurnEffectStateV1::Uncertain),
        _ => Err(storage(
            "corrupt_agent_turn_effect",
            format!("unknown turn effect state {value:?}"),
        )),
    }
}

fn pending_answer_state(value: &AgentPendingAnswerStateV1) -> &'static str {
    match value {
        AgentPendingAnswerStateV1::Prepared => "prepared",
        AgentPendingAnswerStateV1::Succeeded => "succeeded",
        AgentPendingAnswerStateV1::Failed => "failed",
        AgentPendingAnswerStateV1::Uncertain => "uncertain",
    }
}

fn parse_pending_answer_state(
    value: &str,
) -> Result<AgentPendingAnswerStateV1, DomainStoreErrorV1> {
    match value {
        "prepared" => Ok(AgentPendingAnswerStateV1::Prepared),
        "succeeded" => Ok(AgentPendingAnswerStateV1::Succeeded),
        "failed" => Ok(AgentPendingAnswerStateV1::Failed),
        "uncertain" => Ok(AgentPendingAnswerStateV1::Uncertain),
        _ => Err(storage(
            "corrupt_agent_pending_answer",
            format!("unknown pending answer state {value:?}"),
        )),
    }
}

fn same_pending_request(
    left: &AgentPendingRequestDraftV1,
    right: &AgentPendingRequestDraftV1,
) -> bool {
    left.request_id == right.request_id
        && left.kind == right.kind
        && left.turn_id == right.turn_id
        && left.client_message_id == right.client_message_id
        && left.payload == right.payload
}

fn same_interaction_binding(
    left: &AgentInteractionBindingV1,
    right: &AgentInteractionBindingV1,
) -> bool {
    left.schema_version == right.schema_version
        && left.interaction_session_id == right.interaction_session_id
        && left.agent_id == right.agent_id
        && left.provider_id == right.provider_id
        && left.execution_profile == right.execution_profile
        && left.provider_conversation_ref == right.provider_conversation_ref
        && left.runtime == right.runtime
        && left.timeline_epoch == right.timeline_epoch
        && left.binding_revision == right.binding_revision
        && left.history_complete == right.history_complete
}

fn same_start_turn_intent(left: &AgentStartTurnIntentV1, right: &AgentStartTurnIntentV1) -> bool {
    left.schema_version == right.schema_version
        && left.interaction_session_id == right.interaction_session_id
        && left.runtime == right.runtime
        && left.turn_id == right.turn_id
        && left.client_message_id == right.client_message_id
        && left.input == right.input
}

fn same_pending_answer_intent(
    left: &AgentPendingAnswerIntentV1,
    right: &AgentPendingAnswerIntentV1,
) -> bool {
    left.schema_version == right.schema_version
        && left.interaction_session_id == right.interaction_session_id
        && left.runtime == right.runtime
        && left.request_id == right.request_id
        && left.client_message_id == right.client_message_id
        && left.idempotency_key == right.idempotency_key
        && left.answer == right.answer
}
