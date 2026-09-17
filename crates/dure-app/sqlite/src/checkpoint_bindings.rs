use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1,
    AgentCheckpointObservationV1, AgentCheckpointRecordV1, AgentIdV1, DomainStoreErrorV1,
    RuntimeKindIdV1, SessionBindingRecordV1, WorkflowSessionGenerationV1,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, identity_conflict, map_sqlx, storage};
use crate::records::session_binding_on;
use crate::schema::{begin_immediate, finish_transaction};

mod write;
pub(crate) use write::{upsert, upsert_on};

async fn reject_other_exact_generation_owner(
    connection: &mut sqlx::SqliteConnection,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    let owner = sqlx::query_scalar::<_, String>(
        r#"
        SELECT authority.agent_id
        FROM agent_checkpoint_binding_authorities AS authority
        JOIN session_bindings AS binding
          ON binding.agent_id = authority.agent_id
         AND binding.session_id = authority.session_id
         AND binding.binding_generation = authority.binding_generation
        WHERE authority.agent_id <> ?1
          AND binding.runtime_kind_id = ?2
          AND authority.session_id = ?3
          AND authority.runtime_workspace_id = ?4
          AND authority.runner_principal = ?5
          AND authority.runner_instance = ?6
          AND authority.channel_epoch = ?7
          AND authority.host_instance_id = ?8
          AND authority.terminal_epoch = ?9
        ORDER BY authority.agent_id
        LIMIT 1
        "#,
    )
    .bind(authority.binding.agent_id.as_str())
    .bind(authority.binding.runtime_kind_id.as_str())
    .bind(&authority.binding.session_id)
    .bind(&authority.runtime_workspace_id)
    .bind(&authority.runner_principal)
    .bind(&authority.runner_instance)
    .bind(&authority.channel_epoch)
    .bind(&authority.host_instance_id)
    .bind(&authority.terminal_epoch)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("claim_checkpoint_binding_authority", error))?;
    if let Some(owner) = owner {
        return Err(identity_conflict(
            "agent_checkpoint_binding_authority",
            &authority.binding.session_id,
            format!("the exact runtime generation is already owned by Agent {owner}"),
        ));
    }
    Ok(())
}

async fn insert_authority(
    connection: &mut sqlx::SqliteConnection,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        r#"
        INSERT INTO agent_checkpoint_binding_authorities (
            agent_id, schema_version, session_id, runtime_workspace_id,
            runner_principal, runner_instance, channel_epoch, host_instance_id,
            terminal_epoch, binding_generation, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
    )
    .bind(authority.binding.agent_id.as_str())
    .bind(i64::from(authority.schema_version))
    .bind(&authority.binding.session_id)
    .bind(&authority.runtime_workspace_id)
    .bind(&authority.runner_principal)
    .bind(&authority.runner_instance)
    .bind(&authority.channel_epoch)
    .bind(&authority.host_instance_id)
    .bind(&authority.terminal_epoch)
    .bind(authority.binding.binding_generation)
    .bind(authority.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("upsert_checkpoint_binding_authority", error))?;
    Ok(())
}

pub(crate) async fn update_binding_on(
    connection: &mut sqlx::SqliteConnection,
    binding: &SessionBindingRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let updated = sqlx::query(
        r#"
        UPDATE session_bindings SET
            runtime_kind_id = ?2,
            session_id = ?3,
            provider_conversation_id = ?4,
            credential_reference_id = ?5,
            binding_generation = ?6,
            bound_at_ms = ?7
        WHERE agent_id = ?1
        "#,
    )
    .bind(binding.agent_id.as_str())
    .bind(binding.runtime_kind_id.as_str())
    .bind(&binding.session_id)
    .bind(&binding.provider_conversation_id)
    .bind(&binding.credential_reference_id)
    .bind(binding.binding_generation)
    .bind(binding.bound_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("update_checkpoint_session_binding", error))?;
    if updated.rows_affected() != 1 {
        return Err(identity_conflict(
            "session_binding",
            binding.agent_id.as_str(),
            "the current binding disappeared before update",
        ));
    }
    Ok(())
}

pub(crate) async fn update_authority(
    connection: &mut sqlx::SqliteConnection,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    let updated = sqlx::query(
        r#"
        UPDATE agent_checkpoint_binding_authorities SET
            schema_version = ?2,
            session_id = ?3,
            runtime_workspace_id = ?4,
            runner_principal = ?5,
            runner_instance = ?6,
            channel_epoch = ?7,
            host_instance_id = ?8,
            terminal_epoch = ?9,
            binding_generation = ?10,
            updated_at_ms = ?11
        WHERE agent_id = ?1
        "#,
    )
    .bind(authority.binding.agent_id.as_str())
    .bind(i64::from(authority.schema_version))
    .bind(&authority.binding.session_id)
    .bind(&authority.runtime_workspace_id)
    .bind(&authority.runner_principal)
    .bind(&authority.runner_instance)
    .bind(&authority.channel_epoch)
    .bind(&authority.host_instance_id)
    .bind(&authority.terminal_epoch)
    .bind(authority.binding.binding_generation)
    .bind(authority.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("upsert_checkpoint_binding_authority", error))?;
    if updated.rows_affected() != 1 {
        return Err(identity_conflict(
            "agent_checkpoint_binding_authority",
            authority.binding.agent_id.as_str(),
            "the current authority disappeared before update",
        ));
    }
    Ok(())
}

pub(crate) async fn get(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentCheckpointBindingAuthorityV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_checkpoint_binding_authority", error))?;
    authority_on(&mut connection, agent_id).await
}

pub(crate) async fn converge_provider_conversation(
    pool: &SqlitePool,
    expected: &AgentCheckpointBindingAuthorityV1,
    provider_conversation_id: &str,
) -> Result<AgentCheckpointBindingAuthorityV1, DomainStoreErrorV1> {
    expected.validate()?;
    if expected.binding.provider_conversation_id.is_some() {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "providerConversationId",
            reason: "convergence requires a missing provider conversation".into(),
        });
    }
    let mut converged = expected.clone();
    converged.binding.provider_conversation_id = Some(provider_conversation_id.into());
    converged.validate()?;

    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("converge_checkpoint_provider_conversation", error))?;
    begin_immediate(&mut connection, "converge_checkpoint_provider_conversation").await?;
    let result = async {
        if authority_on(&mut connection, &expected.binding.agent_id)
            .await?
            .as_ref()
            != Some(expected)
        {
            return Err(identity_conflict(
                "agent_checkpoint_binding_authority",
                expected.binding.agent_id.as_str(),
                "provider conversation may only converge for the exact current authority",
            ));
        }
        let updated = sqlx::query(
            r#"
            UPDATE session_bindings
            SET provider_conversation_id = ?2
            WHERE agent_id = ?1
              AND provider_conversation_id IS NULL
            "#,
        )
        .bind(expected.binding.agent_id.as_str())
        .bind(provider_conversation_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("converge_checkpoint_provider_conversation", error))?;
        if updated.rows_affected() != 1 {
            return Err(identity_conflict(
                "agent_checkpoint_binding_authority",
                expected.binding.agent_id.as_str(),
                "provider conversation may only advance from missing to present",
            ));
        }
        Ok(converged)
    }
    .await;
    finish_transaction(
        &mut connection,
        "converge_checkpoint_provider_conversation",
        result,
    )
    .await
}

pub(crate) async fn authority_on(
    connection: &mut sqlx::SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentCheckpointBindingAuthorityV1>, DomainStoreErrorV1> {
    let row = sqlx::query(&authority_select("WHERE sb.agent_id = ?1"))
        .bind(agent_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_checkpoint_binding_authority", error))?;
    row.as_ref().map(authority_from_row).transpose()
}

pub(crate) async fn authority_for_exact_session_on(
    connection: &mut sqlx::SqliteConnection,
    session: &WorkflowSessionGenerationV1,
    runtime_kind_id: &RuntimeKindIdV1,
) -> Result<Option<AgentCheckpointBindingAuthorityV1>, DomainStoreErrorV1> {
    session.validate()?;
    let rows = sqlx::query(&authority_select(
        r#"
        WHERE sb.runtime_kind_id = ?1
          AND sb.session_id = ?2
          AND authority.runtime_workspace_id = ?3
          AND authority.runner_principal = ?4
          AND authority.runner_instance = ?5
          AND authority.channel_epoch = ?6
          AND authority.host_instance_id = ?7
          AND authority.terminal_epoch = ?8
        "#,
    ))
    .bind(runtime_kind_id.as_str())
    .bind(&session.session_id)
    .bind(&session.workspace_id)
    .bind(&session.runner_principal)
    .bind(&session.runner_instance)
    .bind(&session.channel_epoch)
    .bind(&session.host_instance_id)
    .bind(&session.terminal_epoch)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("resolve_exact_checkpoint_binding_authority", error))?;
    if rows.len() > 1 {
        return Err(identity_conflict(
            "agent_checkpoint_binding_authority",
            &session.session_id,
            "the exact Session generation has multiple owners in one runtime",
        ));
    }
    rows.first().map(authority_from_row).transpose()
}

pub(crate) async fn replace_exact_on(
    connection: &mut sqlx::SqliteConnection,
    expected: &AgentCheckpointBindingAuthorityV1,
    target: &AgentCheckpointBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    expected.validate()?;
    target.validate()?;
    reject_other_exact_generation_owner(connection, target).await?;
    if authority_on(connection, &expected.binding.agent_id)
        .await?
        .as_ref()
        != Some(expected)
    {
        return Err(identity_conflict(
            "agent_checkpoint_binding_authority",
            expected.binding.agent_id.as_str(),
            "native rehost source authority changed before commit",
        ));
    }
    update_binding_on(connection, &target.binding).await?;
    update_authority(connection, target).await?;
    Ok(())
}

pub(crate) async fn observations(
    pool: &SqlitePool,
    agent_ids: &[AgentIdV1],
) -> Result<Vec<AgentCheckpointObservationV1>, DomainStoreErrorV1> {
    if agent_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut query = QueryBuilder::<Sqlite>::new(authority_select("WHERE sb.agent_id IN ("));
    {
        let mut separated = query.separated(", ");
        for agent_id in agent_ids {
            separated.push_bind(agent_id.as_str());
        }
    }
    query.push(") ORDER BY sb.agent_id");
    let rows = query
        .build()
        .fetch_all(pool)
        .await
        .map_err(|error| map_sqlx("observe_checkpoint_bindings", error))?;
    rows.into_iter().map(observation_from_row).collect()
}

fn authority_select(suffix: &str) -> String {
    format!(
        r#"
        SELECT
            sb.agent_id AS binding_agent_id,
            sb.runtime_kind_id,
            sb.session_id AS binding_session_id,
            sb.provider_conversation_id,
            sb.credential_reference_id,
            sb.binding_generation AS binding_generation,
            sb.bound_at_ms,
            authority.schema_version AS authority_schema_version,
            authority.session_id AS authority_session_id,
            authority.runtime_workspace_id,
            authority.runner_principal,
            authority.runner_instance,
            authority.channel_epoch,
            authority.host_instance_id,
            authority.terminal_epoch,
            authority.binding_generation AS authority_binding_generation,
            authority.updated_at_ms AS authority_updated_at_ms,
            checkpoint.schema_version AS checkpoint_schema_version,
            checkpoint.checkpoint_text,
            checkpoint.revision,
            checkpoint.updated_by_session_id,
            checkpoint.updated_by_binding_generation,
            checkpoint.updated_at_ms AS checkpoint_updated_at_ms
        FROM session_bindings AS sb
        JOIN agent_checkpoint_binding_authorities AS authority
          ON authority.agent_id = sb.agent_id
         AND authority.session_id = sb.session_id
         AND authority.binding_generation = sb.binding_generation
        -- Observation is a durable-state read: serve the agent's latest
        -- checkpoint row even when the binding authority has advanced past
        -- the generation that wrote it (rehost with no newer write). The
        -- exact-binding fence stays on the write/read-your-write paths
        -- (validate_exact_binding); scoping this join to the current
        -- generation froze sidebars on pre-rehost text (2026-08-13).
        LEFT JOIN agent_checkpoints AS checkpoint
          ON checkpoint.agent_id = sb.agent_id
        {suffix}
        "#,
    )
}

fn authority_from_row(
    row: &SqliteRow,
) -> Result<AgentCheckpointBindingAuthorityV1, DomainStoreErrorV1> {
    let agent_id = AgentIdV1::new(
        row.try_get::<String, _>("binding_agent_id")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
    )
    .map_err(|error| corrupt_identifier("agent_checkpoint_binding_authorities.agent_id", error))?;
    let runtime_kind_id = RuntimeKindIdV1::new(
        row.try_get::<String, _>("runtime_kind_id")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
    )
    .map_err(|error| {
        corrupt_identifier(
            "agent_checkpoint_binding_authorities.runtime_kind_id",
            error,
        )
    })?;
    let authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: u16::try_from(
            row.try_get::<i64, _>("authority_schema_version")
                .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        )
        .map_err(|error| storage("corrupt_checkpoint_binding_authority", error.to_string()))?,
        binding: SessionBindingRecordV1 {
            agent_id,
            runtime_kind_id,
            session_id: row
                .try_get("binding_session_id")
                .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
            provider_conversation_id: row
                .try_get("provider_conversation_id")
                .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
            credential_reference_id: row
                .try_get("credential_reference_id")
                .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
            binding_generation: row
                .try_get("binding_generation")
                .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
            bound_at_ms: row
                .try_get("bound_at_ms")
                .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        },
        runtime_workspace_id: row
            .try_get("runtime_workspace_id")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        runner_principal: row
            .try_get("runner_principal")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        runner_instance: row
            .try_get("runner_instance")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        channel_epoch: row
            .try_get("channel_epoch")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        host_instance_id: row
            .try_get("host_instance_id")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        terminal_epoch: row
            .try_get("terminal_epoch")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
        updated_at_ms: row
            .try_get("authority_updated_at_ms")
            .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?,
    };
    let authority_session_id: String = row
        .try_get("authority_session_id")
        .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?;
    let authority_generation: i64 = row
        .try_get("authority_binding_generation")
        .map_err(|error| corrupt_row("agent_checkpoint_binding_authorities", error))?;
    if authority_session_id != authority.binding.session_id
        || authority_generation != authority.binding.binding_generation
    {
        return Err(storage(
            "corrupt_checkpoint_binding_authority",
            "binding and exact fence generations diverged",
        ));
    }
    authority
        .validate()
        .map_err(|error| storage("corrupt_checkpoint_binding_authority", error.to_string()))?;
    Ok(authority)
}

fn observation_from_row(
    row: SqliteRow,
) -> Result<AgentCheckpointObservationV1, DomainStoreErrorV1> {
    let checkpoint_schema = row
        .try_get::<Option<i64>, _>("checkpoint_schema_version")
        .map_err(|error| corrupt_row("agent_checkpoints", error))?;
    let authority = authority_from_row(&row)?;
    let checkpoint = checkpoint_schema
        .map(|schema_version| {
            let schema_version = u16::try_from(schema_version)
                .map_err(|error| storage("corrupt_agent_checkpoint", error.to_string()))?;
            if schema_version != AGENT_CHECKPOINT_SCHEMA_VERSION_V1 {
                return Err(storage(
                    "corrupt_agent_checkpoint",
                    "unsupported checkpoint schema",
                ));
            }
            let record = AgentCheckpointRecordV1 {
                schema_version,
                agent_id: authority.binding.agent_id.clone(),
                checkpoint: row
                    .try_get("checkpoint_text")
                    .map_err(|error| corrupt_row("agent_checkpoints", error))?,
                revision: row
                    .try_get("revision")
                    .map_err(|error| corrupt_row("agent_checkpoints", error))?,
                updated_by_session_id: row
                    .try_get("updated_by_session_id")
                    .map_err(|error| corrupt_row("agent_checkpoints", error))?,
                updated_by_binding_generation: row
                    .try_get("updated_by_binding_generation")
                    .map_err(|error| corrupt_row("agent_checkpoints", error))?,
                updated_at_ms: row
                    .try_get("checkpoint_updated_at_ms")
                    .map_err(|error| corrupt_row("agent_checkpoints", error))?,
            };
            record
                .validate()
                .map_err(|error| storage("corrupt_agent_checkpoint", error.to_string()))?;
            Ok(record)
        })
        .transpose()?;
    Ok(AgentCheckpointObservationV1 {
        authority,
        checkpoint,
    })
}
