use dure_app::{
    AgentIdV1, AgentInteractionProfileV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeNativeRehostCommitV1, AgentRuntimeSelectionV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionEffectAuthorizationV1, AgentRuntimeTransitionIntentV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionRepairRequestV1,
    AgentRuntimeTransitionStateV1, AgentRuntimeTransitionSupersedeRequestV1, DomainStoreErrorV1,
    OperationIdV1, advance_agent_runtime_transition_v1,
    authorize_agent_runtime_transition_repair_v1, supersede_agent_runtime_transition_v1,
    supersede_agent_runtime_transition_with_native_rehost_v1,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::agent_runtime_close::{
    effective_close_for_agent_on, ensure_runtime_successor_source_on, ensure_transition_source_on,
};
use crate::agent_timeline::binding_for_agent_on;
use crate::checkpoint_bindings::authority_on;
use crate::error::{corrupt_row, identity_conflict, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

mod admission;
pub(crate) mod request_replay;
pub(crate) use admission::admit;
mod deferred;
mod idle_candidates;
pub(crate) use deferred::ensure_target_activation_on;
mod store;
pub(crate) use request_replay::resume;

pub(crate) async fn initialize_selection(
    pool: &SqlitePool,
    selection: &AgentRuntimeSelectionV1,
) -> Result<AgentRuntimeSelectionV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("initialize_agent_runtime_selection", error))?;
    begin_immediate(&mut connection, "initialize_agent_runtime_selection").await?;
    let result = initialize_selection_on(&mut connection, selection).await;
    finish_transaction(
        &mut connection,
        "initialize_agent_runtime_selection",
        result,
    )
    .await
}

pub(crate) async fn initialize_selection_on(
    connection: &mut SqliteConnection,
    selection: &AgentRuntimeSelectionV1,
) -> Result<AgentRuntimeSelectionV1, DomainStoreErrorV1> {
    selection.validate()?;
    if selection.revision != 1 || selection.selected_by_operation_id.is_some() {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "runtimeSelection",
            reason: "only an initial revision may be initialized directly".into(),
        });
    }
    require_agent_provider(connection, selection).await?;
    if let Some(existing) = selection_on(connection, &selection.agent_id).await? {
        if existing == *selection {
            return Ok(existing);
        }
        return Err(identity_conflict(
            "agent runtime selection",
            selection.agent_id.as_str(),
            "an active selection is already initialized",
        ));
    }
    if crate::agent_runtime_checkout::checkout_on(connection, &selection.agent_id)
        .await?
        .is_some_and(|record| record.admission != dure_app::SessionCheckoutAdmissionV1::Open)
    {
        return Err(storage(
            "session_checkout_closing",
            "the Agent registration is closing",
        ));
    }
    insert_selection(connection, selection).await?;
    Ok(selection.clone())
}

pub(crate) async fn selection(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeSelectionV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            agent_id,
            schema_version,
            provider_id,
            interaction_profile,
            revision,
            selected_by_operation_id,
            selection_json,
            updated_at_ms
        FROM agent_runtime_selections
        WHERE agent_id = ?1
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_selection", error))?;
    row.map(selection_from_row).transpose()
}

pub(crate) async fn startup_recovery_candidates(
    pool: &SqlitePool,
) -> Result<Vec<AgentIdV1>, DomainStoreErrorV1> {
    query_recovery_candidates(pool, true).await
}

pub(crate) async fn incomplete_recovery_candidates(
    pool: &SqlitePool,
) -> Result<Vec<AgentIdV1>, DomainStoreErrorV1> {
    query_recovery_candidates(pool, false).await
}

async fn query_recovery_candidates(
    pool: &SqlitePool,
    include_stable_structured: bool,
) -> Result<Vec<AgentIdV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT agent_id FROM (
            SELECT agent_id
            FROM agent_runtime_closes
            WHERE state = 'admitted'
               OR (state = 'stopped' AND removal_json IS NOT NULL
                   AND json_extract(removal_json, '$.completedAtMs') IS NULL)
            UNION
            SELECT agent_id
            FROM agent_runtime_transitions
            WHERE state IN ('admitted', 'target_started')
               OR (state = 'source_stopped'
                   AND COALESCE(json_extract(record_json, '$.deferredTarget.state'), '') != 'waiting')
            UNION
            SELECT agent_id FROM agent_runtime_selections AS selection
            WHERE ?1 AND interaction_profile = 'structured_protocol'
              AND NOT EXISTS (
                  SELECT 1 FROM agent_runtime_transitions AS transition
                  WHERE transition.agent_id = selection.agent_id
                    AND transition.state = 'source_stopped'
                    AND json_extract(transition.record_json, '$.deferredTarget.state') = 'waiting'
              )
            UNION
            SELECT agent.agent_id FROM agents AS agent
            JOIN session_checkout_bindings AS checkout ON checkout.owner_id = agent.checkout_owner_id
            WHERE checkout.admission = 'closing'
              AND NOT EXISTS (SELECT 1 FROM agent_runtime_selections AS selected
                              WHERE selected.agent_id = agent.agent_id)
        )
        ORDER BY agent_id
        "#,
    )
    .bind(include_stable_structured)
    .fetch_all(pool)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_recovery_candidates", error))?;
    rows.into_iter()
        .map(|row| {
            let agent_id: String = row
                .try_get("agent_id")
                .map_err(|error| corrupt_row("agent_runtime_recovery_candidates", error))?;
            AgentIdV1::new(agent_id).map_err(|error| {
                storage(
                    "corrupt_agent_runtime_recovery_candidate",
                    error.to_string(),
                )
            })
        })
        .collect()
}

pub(crate) async fn advance(
    pool: &SqlitePool,
    request: &AgentRuntimeTransitionAdvanceRequestV1,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("advance_agent_runtime_transition", error))?;
    begin_immediate(&mut connection, "advance_agent_runtime_transition").await?;
    let result = advance_on(&mut connection, request).await;
    finish_transaction(&mut connection, "advance_agent_runtime_transition", result).await
}

pub(crate) async fn advance_on(
    connection: &mut SqliteConnection,
    request: &AgentRuntimeTransitionAdvanceRequestV1,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    request.validate()?;
    let current = transition_on(connection, &request.operation_id)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "agent runtime transition",
            id: request.operation_id.as_str().into(),
        })?;
    let next = advance_agent_runtime_transition_v1(&current, request)?;
    if let AgentRuntimeTransitionAdvanceV1::TargetStarted { authority, .. } = &request.advance {
        require_current_runtime_authority_on(
            connection,
            &current.intent.source.agent_id,
            authority,
        )
        .await?;
    }
    if next == current {
        if current.state == AgentRuntimeTransitionStateV1::Committed {
            require_committed_selection(connection, &current).await?;
            let authority = current.target_authority.as_ref().ok_or_else(|| {
                storage(
                    "corrupt_agent_runtime_transition_commit",
                    "committed transition has no target authority",
                )
            })?;
            require_current_runtime_generation_authority_on(
                connection,
                &current.intent.source.agent_id,
                authority,
            )
            .await?;
        }
        return Ok(current);
    }

    if next.state == AgentRuntimeTransitionStateV1::Committed {
        let selected = selection_on(connection, &current.intent.source.agent_id).await?;
        if selected.as_ref() != Some(&current.intent.source) {
            return Err(identity_conflict(
                "agent runtime selection",
                current.intent.source.agent_id.as_str(),
                "the source selection changed before transition commit",
            ));
        }
        let target = next.intent.target_selection_at(next.updated_at_ms)?;
        let authority = next.target_authority.as_ref().ok_or_else(|| {
            storage(
                "corrupt_agent_runtime_transition_commit",
                "committed transition has no target authority",
            )
        })?;
        require_current_runtime_generation_authority_on(
            connection,
            &current.intent.source.agent_id,
            authority,
        )
        .await?;
        update_selection(connection, &current.intent.source, &target).await?;
        crate::agent_runtime_dispatch::rebind_committed_transition_on(connection, &next).await?;
    }
    update_transition(connection, &current, &next).await?;
    Ok(next)
}

pub(crate) async fn require_current_runtime_authority_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
    authority: &AgentRuntimeBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    match authority {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            if binding_for_agent_on(connection, agent_id).await?.as_ref() != Some(binding) {
                return Err(identity_conflict(
                    "agent interaction binding",
                    agent_id.as_str(),
                    "the runtime transition authority is not the active binding",
                ));
            }
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => {
            if authority_on(connection, agent_id).await?.as_ref() != Some(authority) {
                return Err(identity_conflict(
                    "agent checkpoint binding authority",
                    agent_id.as_str(),
                    "the runtime transition authority is not the active binding",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn runtime_generation_authority_converges_from(
    expected: &AgentRuntimeBindingAuthorityV1,
    current: &AgentRuntimeBindingAuthorityV1,
) -> bool {
    match (expected, current) {
        (
            AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: expected,
            },
            AgentRuntimeBindingAuthorityV1::NativeCli { authority: current },
        ) => {
            expected.schema_version == current.schema_version
                && expected.binding.agent_id == current.binding.agent_id
                && expected.binding.runtime_kind_id == current.binding.runtime_kind_id
                && expected.binding.session_id == current.binding.session_id
                && expected.binding.credential_reference_id
                    == current.binding.credential_reference_id
                && expected.binding.binding_generation == current.binding.binding_generation
                && expected.binding.bound_at_ms == current.binding.bound_at_ms
                && (expected.binding.provider_conversation_id
                    == current.binding.provider_conversation_id
                    || (expected.binding.provider_conversation_id.is_none()
                        && current.binding.provider_conversation_id.is_some()))
                && expected.runtime_workspace_id == current.runtime_workspace_id
                && expected.runner_principal == current.runner_principal
                && expected.runner_instance == current.runner_instance
                && expected.channel_epoch == current.channel_epoch
                && expected.host_instance_id == current.host_instance_id
                && expected.terminal_epoch == current.terminal_epoch
                && expected.updated_at_ms == current.updated_at_ms
        }
        (
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: left },
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: right },
        ) => left == right,
        _ => false,
    }
}

async fn require_current_runtime_generation_authority_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
    expected: &AgentRuntimeBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    let current = match expected {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. } => {
            binding_for_agent_on(connection, agent_id)
                .await?
                .map(|binding| AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding })
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } => authority_on(connection, agent_id)
            .await?
            .map(|authority| AgentRuntimeBindingAuthorityV1::NativeCli { authority }),
    };
    if current
        .as_ref()
        .is_none_or(|current| !runtime_generation_authority_converges_from(expected, current))
    {
        return Err(identity_conflict(
            "agent runtime authority",
            agent_id.as_str(),
            "the runtime transition target is no longer the current generation",
        ));
    }
    Ok(())
}

pub(crate) async fn authorize_repair(
    pool: &SqlitePool,
    request: &AgentRuntimeTransitionRepairRequestV1,
) -> Result<AgentRuntimeTransitionEffectAuthorizationV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("repair_agent_runtime_transition", error))?;
    begin_immediate(&mut connection, "repair_agent_runtime_transition").await?;
    let result = async {
        let current = transition_on(&mut connection, &request.operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent runtime transition",
                id: request.operation_id.as_str().into(),
            })?;
        ensure_transition_source_on(&mut connection, &current).await?;
        let outcome = authorize_agent_runtime_transition_repair_v1(&current, request)?;
        if let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(next) = &outcome {
            update_transition(&mut connection, &current, next).await?;
        }
        Ok(outcome)
    }
    .await;
    finish_transaction(&mut connection, "repair_agent_runtime_transition", result).await
}

pub(crate) async fn supersede(
    pool: &SqlitePool,
    request: &AgentRuntimeTransitionSupersedeRequestV1,
) -> Result<AgentRuntimeTransitionEffectAuthorizationV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("supersede_agent_runtime_transition", error))?;
    begin_immediate(&mut connection, "supersede_agent_runtime_transition").await?;
    let result = async {
        let current = transition_on(&mut connection, &request.operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent runtime transition",
                id: request.operation_id.as_str().into(),
            })?;
        ensure_transition_source_on(&mut connection, &current).await?;
        if current.state == AgentRuntimeTransitionStateV1::Superseded {
            return replay_supersede(&mut connection, &current, request).await;
        }
        let (superseded, successor) = supersede_agent_runtime_transition_v1(&current, request)?;
        let selected = selection_on(&mut connection, &current.intent.source.agent_id).await?;
        if selected.as_ref() != Some(&current.intent.source) {
            return Err(identity_conflict(
                "agent runtime selection",
                current.intent.source.agent_id.as_str(),
                "the stopped source selection changed before supersede",
            ));
        }
        if transition_on(&mut connection, &successor.intent.operation_id)
            .await?
            .is_some()
            || transition_by_key_on(&mut connection, &successor.intent.idempotency_key)
                .await?
                .is_some()
        {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: "runtime transition successor identity is already used".into(),
            });
        }
        update_transition(&mut connection, &current, &superseded).await?;
        insert_transition(&mut connection, &successor).await?;
        Ok(AgentRuntimeTransitionEffectAuthorizationV1::Authorized(
            successor,
        ))
    }
    .await;
    finish_transaction(
        &mut connection,
        "supersede_agent_runtime_transition",
        result,
    )
    .await
}

async fn replay_supersede(
    connection: &mut SqliteConnection,
    current: &AgentRuntimeTransitionRecordV1,
    request: &AgentRuntimeTransitionSupersedeRequestV1,
) -> Result<AgentRuntimeTransitionEffectAuthorizationV1, DomainStoreErrorV1> {
    if request
        .expected_journal_revision
        .checked_add(1)
        .is_none_or(|revision| revision != current.journal_revision)
    {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.intent.source.agent_id.as_str().into(),
            expected_revision: request.expected_journal_revision,
            actual_revision: Some(current.journal_revision),
        });
    }
    if current.superseded_by_operation_id.as_ref() != Some(&request.successor_intent.operation_id) {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "runtime transition was superseded by a different operation".into(),
        });
    }
    let successor = transition_on(connection, &request.successor_intent.operation_id)
        .await?
        .ok_or_else(|| {
            storage(
                "corrupt_agent_runtime_transition_supersede",
                "superseded transition has no successor",
            )
        })?;
    if successor.intent != request.successor_intent {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "runtime transition successor has a different intent".into(),
        });
    }
    Ok(AgentRuntimeTransitionEffectAuthorizationV1::Replayed(
        successor,
    ))
}

pub(crate) async fn transition(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    let row = transition_row_by_operation(pool, operation_id).await?;
    row.map(transition_from_row).transpose()
}

pub(crate) async fn transition_by_idempotency_key(
    pool: &SqlitePool,
    idempotency_key: &str,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_runtime_transition", error))?;
    transition_by_key_on(&mut connection, idempotency_key).await
}

pub(crate) async fn active_transition(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_active_agent_runtime_transition", error))?;
    active_transition_on(&mut connection, agent_id).await
}

async fn require_agent_provider(
    connection: &mut SqliteConnection,
    selection: &AgentRuntimeSelectionV1,
) -> Result<(), DomainStoreErrorV1> {
    let provider: Option<String> =
        sqlx::query_scalar("SELECT provider_id FROM agents WHERE agent_id = ?1")
            .bind(selection.agent_id.as_str())
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| map_sqlx("read_agent_runtime_selection_agent", error))?;
    match provider {
        None => Err(DomainStoreErrorV1::NotFound {
            entity: "agent",
            id: selection.agent_id.as_str().into(),
        }),
        Some(provider) if provider != selection.provider_id.as_str() => Err(identity_conflict(
            "agent runtime selection",
            selection.agent_id.as_str(),
            "providerId differs from the durable Agent",
        )),
        Some(_) => Ok(()),
    }
}

async fn insert_selection(
    connection: &mut SqliteConnection,
    selection: &AgentRuntimeSelectionV1,
) -> Result<(), DomainStoreErrorV1> {
    let selection_json = serde_json::to_string(selection)
        .map_err(|error| serialization("agent runtime selection", error))?;
    sqlx::query(
        r#"
        INSERT INTO agent_runtime_selections (
            agent_id,
            schema_version,
            provider_id,
            interaction_profile,
            revision,
            selected_by_operation_id,
            selection_json,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
    )
    .bind(selection.agent_id.as_str())
    .bind(i64::from(selection.schema_version))
    .bind(selection.provider_id.as_str())
    .bind(profile_name(selection.interaction_profile))
    .bind(selection.revision)
    .bind(
        selection
            .selected_by_operation_id
            .as_ref()
            .map(OperationIdV1::as_str),
    )
    .bind(selection_json)
    .bind(selection.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("initialize_agent_runtime_selection", error))?;
    Ok(())
}

pub(crate) async fn update_selection(
    connection: &mut SqliteConnection,
    source: &AgentRuntimeSelectionV1,
    target: &AgentRuntimeSelectionV1,
) -> Result<(), DomainStoreErrorV1> {
    let selection_json = serde_json::to_string(target)
        .map_err(|error| serialization("agent runtime selection", error))?;
    let result = sqlx::query(
        r#"
        UPDATE agent_runtime_selections SET
            schema_version = ?2,
            provider_id = ?3,
            interaction_profile = ?4,
            revision = ?5,
            selected_by_operation_id = ?6,
            selection_json = ?7,
            updated_at_ms = ?8
        WHERE agent_id = ?1 AND revision = ?9
        "#,
    )
    .bind(target.agent_id.as_str())
    .bind(i64::from(target.schema_version))
    .bind(target.provider_id.as_str())
    .bind(profile_name(target.interaction_profile))
    .bind(target.revision)
    .bind(
        target
            .selected_by_operation_id
            .as_ref()
            .map(OperationIdV1::as_str),
    )
    .bind(selection_json)
    .bind(target.updated_at_ms)
    .bind(source.revision)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("commit_agent_runtime_selection", error))?;
    if result.rows_affected() != 1 {
        return Err(identity_conflict(
            "agent runtime selection",
            source.agent_id.as_str(),
            "selection revision changed before commit",
        ));
    }
    Ok(())
}

pub(crate) async fn selection_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeSelectionV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            agent_id,
            schema_version,
            provider_id,
            interaction_profile,
            revision,
            selected_by_operation_id,
            selection_json,
            updated_at_ms
        FROM agent_runtime_selections
        WHERE agent_id = ?1
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_selection", error))?;
    row.map(selection_from_row).transpose()
}

fn selection_from_row(row: SqliteRow) -> Result<AgentRuntimeSelectionV1, DomainStoreErrorV1> {
    let selection_json: String = row
        .try_get("selection_json")
        .map_err(|error| corrupt_row("agent_runtime_selections", error))?;
    let selection: AgentRuntimeSelectionV1 = serde_json::from_str(&selection_json)
        .map_err(|error| serialization("agent runtime selection", error))?;
    selection.validate()?;
    let stored = (
        row.try_get::<String, _>("agent_id")
            .map_err(|error| corrupt_row("agent_runtime_selections", error))?,
        row.try_get::<i64, _>("schema_version")
            .map_err(|error| corrupt_row("agent_runtime_selections", error))?,
        row.try_get::<String, _>("provider_id")
            .map_err(|error| corrupt_row("agent_runtime_selections", error))?,
        row.try_get::<String, _>("interaction_profile")
            .map_err(|error| corrupt_row("agent_runtime_selections", error))?,
        row.try_get::<i64, _>("revision")
            .map_err(|error| corrupt_row("agent_runtime_selections", error))?,
        row.try_get::<Option<String>, _>("selected_by_operation_id")
            .map_err(|error| corrupt_row("agent_runtime_selections", error))?,
        row.try_get::<i64, _>("updated_at_ms")
            .map_err(|error| corrupt_row("agent_runtime_selections", error))?,
    );
    let projected = (
        selection.agent_id.as_str().to_owned(),
        i64::from(selection.schema_version),
        selection.provider_id.as_str().to_owned(),
        profile_name(selection.interaction_profile).to_owned(),
        selection.revision,
        selection
            .selected_by_operation_id
            .as_ref()
            .map(|operation| operation.as_str().to_owned()),
        selection.updated_at_ms,
    );
    if stored != projected {
        return Err(storage(
            "corrupt_agent_runtime_selection",
            "selection columns do not match selection_json",
        ));
    }
    Ok(selection)
}

fn replay_admission(
    intent: &AgentRuntimeTransitionIntentV1,
    by_operation: Option<AgentRuntimeTransitionRecordV1>,
    by_key: Option<AgentRuntimeTransitionRecordV1>,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    match (by_operation, by_key) {
        (Some(operation), Some(key))
            if operation.intent.operation_id == key.intent.operation_id
                && operation.intent == *intent =>
        {
            Ok(operation)
        }
        (Some(operation), None) if operation.intent == *intent => Ok(operation),
        (None, Some(key)) if key.intent == *intent => Ok(key),
        _ => Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: format!(
                "runtime transition operation {} or key {:?} has a different intent",
                intent.operation_id, intent.idempotency_key
            ),
        }),
    }
}

async fn insert_transition(
    connection: &mut SqliteConnection,
    record: &AgentRuntimeTransitionRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let record_json = serde_json::to_string(record)
        .map_err(|error| serialization("agent runtime transition", error))?;
    sqlx::query(
        r#"
        INSERT INTO agent_runtime_transitions (
            operation_id,
            idempotency_key,
            agent_id,
            state,
            journal_revision,
            record_json,
            created_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
    )
    .bind(record.intent.operation_id.as_str())
    .bind(&record.intent.idempotency_key)
    .bind(record.intent.source.agent_id.as_str())
    .bind(record.state.as_str())
    .bind(record.journal_revision)
    .bind(record_json)
    .bind(record.created_at_ms)
    .bind(record.updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("admit_agent_runtime_transition", error))?;
    Ok(())
}

pub(crate) async fn supersede_for_native_rehost_on(
    connection: &mut SqliteConnection,
    current: &AgentRuntimeTransitionRecordV1,
    request: &AgentRuntimeNativeRehostCommitV1,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    let superseded = supersede_agent_runtime_transition_with_native_rehost_v1(current, request)?;
    update_transition(connection, current, &superseded).await?;
    Ok(superseded)
}

async fn update_transition(
    connection: &mut SqliteConnection,
    current: &AgentRuntimeTransitionRecordV1,
    next: &AgentRuntimeTransitionRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let record_json = serde_json::to_string(next)
        .map_err(|error| serialization("agent runtime transition", error))?;
    let result = sqlx::query(
        r#"
        UPDATE agent_runtime_transitions SET
            state = ?2,
            journal_revision = ?3,
            record_json = ?4,
            updated_at_ms = ?5
        WHERE operation_id = ?1 AND journal_revision = ?6
        "#,
    )
    .bind(next.intent.operation_id.as_str())
    .bind(next.state.as_str())
    .bind(next.journal_revision)
    .bind(record_json)
    .bind(next.updated_at_ms)
    .bind(current.journal_revision)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("advance_agent_runtime_transition", error))?;
    if result.rows_affected() != 1 {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.intent.source.agent_id.as_str().into(),
            expected_revision: current.journal_revision,
            actual_revision: None,
        });
    }
    Ok(())
}

async fn require_committed_selection(
    connection: &mut SqliteConnection,
    record: &AgentRuntimeTransitionRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let target = record.intent.target_selection_at(record.updated_at_ms)?;
    let selected = selection_on(connection, &target.agent_id).await?;
    if selected.as_ref() != Some(&target) {
        return Err(storage(
            "corrupt_agent_runtime_transition_commit",
            "committed transition is not the active runtime selection",
        ));
    }
    Ok(())
}

pub(crate) async fn transition_on(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            agent_id,
            state,
            journal_revision,
            record_json,
            created_at_ms,
            updated_at_ms
        FROM agent_runtime_transitions
        WHERE operation_id = ?1
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_transition", error))?;
    row.map(transition_from_row).transpose()
}

async fn transition_by_key_on(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            agent_id,
            state,
            journal_revision,
            record_json,
            created_at_ms,
            updated_at_ms
        FROM agent_runtime_transitions
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_transition", error))?;
    if let Some(row) = row {
        return transition_from_row(row).map(Some);
    }
    request_replay::by_key(connection, idempotency_key).await
}

pub(crate) async fn active_transition_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            agent_id,
            state,
            journal_revision,
            record_json,
            created_at_ms,
            updated_at_ms
        FROM agent_runtime_transitions
        WHERE agent_id = ?1 AND state NOT IN ('committed', 'source_retained', 'superseded')
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_active_agent_runtime_transition", error))?;
    row.map(transition_from_row).transpose()
}

async fn transition_row_by_operation(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
) -> Result<Option<SqliteRow>, DomainStoreErrorV1> {
    sqlx::query(
        r#"
        SELECT
            operation_id,
            idempotency_key,
            agent_id,
            state,
            journal_revision,
            record_json,
            created_at_ms,
            updated_at_ms
        FROM agent_runtime_transitions
        WHERE operation_id = ?1
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_transition", error))
}

fn transition_from_row(
    row: SqliteRow,
) -> Result<AgentRuntimeTransitionRecordV1, DomainStoreErrorV1> {
    let record_json: String = row
        .try_get("record_json")
        .map_err(|error| corrupt_row("agent_runtime_transitions", error))?;
    let record: AgentRuntimeTransitionRecordV1 = serde_json::from_str(&record_json)
        .map_err(|error| serialization("agent runtime transition", error))?;
    record.validate()?;
    let stored = (
        row.try_get::<String, _>("operation_id")
            .map_err(|error| corrupt_row("agent_runtime_transitions", error))?,
        row.try_get::<String, _>("idempotency_key")
            .map_err(|error| corrupt_row("agent_runtime_transitions", error))?,
        row.try_get::<String, _>("agent_id")
            .map_err(|error| corrupt_row("agent_runtime_transitions", error))?,
        row.try_get::<String, _>("state")
            .map_err(|error| corrupt_row("agent_runtime_transitions", error))?,
        row.try_get::<i64, _>("journal_revision")
            .map_err(|error| corrupt_row("agent_runtime_transitions", error))?,
        row.try_get::<i64, _>("created_at_ms")
            .map_err(|error| corrupt_row("agent_runtime_transitions", error))?,
        row.try_get::<i64, _>("updated_at_ms")
            .map_err(|error| corrupt_row("agent_runtime_transitions", error))?,
    );
    let projected = (
        record.intent.operation_id.as_str().to_owned(),
        record.intent.idempotency_key.clone(),
        record.intent.source.agent_id.as_str().to_owned(),
        record.state.as_str().to_owned(),
        record.journal_revision,
        record.created_at_ms,
        record.updated_at_ms,
    );
    if stored != projected {
        return Err(storage(
            "corrupt_agent_runtime_transition",
            "transition columns do not match record_json",
        ));
    }
    Ok(record)
}

fn profile_name(profile: AgentInteractionProfileV1) -> &'static str {
    match profile {
        AgentInteractionProfileV1::NativeCli => "native_cli",
        AgentInteractionProfileV1::StructuredProtocol => "structured_protocol",
    }
}
