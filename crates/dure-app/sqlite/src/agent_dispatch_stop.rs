use serde::{Deserialize, Serialize, de::DeserializeOwned};

use dure_app::{
    AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1, AgentDispatchStopAuthorizeRequestV1,
    AgentDispatchStopPlanV1, AgentDispatchStopPreviewV1, AgentDispatchStopRecordV1,
    AgentDispatchStopRuntimeFenceV1, AgentDispatchStopStateV1, AgentDispatchStopTerminalRequestV1,
    AgentDispatchStopTerminalTransitionV1, AgentDispatchStopWorkspacePlanV1, AgentIdV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseRecordV1, AgentRuntimeSelectionV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1, DomainStoreErrorV1,
    GitCheckoutRegistrationV1, OperationIdV1, advance_agent_runtime_transition_v1,
    authorize_agent_dispatch_stop_v1, preview_agent_dispatch_stop_v1,
    replay_superseded_agent_dispatch_stop_v1, supersede_agent_dispatch_stop_v1,
    terminalize_agent_dispatch_stop_v1,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{
    corrupt_identifier, corrupt_row, identity_conflict, map_sqlx, serialization, storage,
};
use crate::schema::{begin_immediate, finish_transaction};
use crate::{agent_runtime_close, agent_runtime_transition, agent_spawn, records};

struct HydratedStop {
    record: AgentDispatchStopRecordV1,
    authorized_at_ms: Option<i64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredStopPlanTailV1 {
    #[serde(flatten)]
    workspace_plan: AgentDispatchStopWorkspacePlanV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_fence: Option<AgentDispatchStopRuntimeFenceV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkout_registration: Option<GitCheckoutRegistrationV1>,
}

enum SpawnCheckoutEvidence {
    Current,
    Frozen(Option<GitCheckoutRegistrationV1>),
}

pub(crate) async fn plan(
    pool: &SqlitePool,
    plan: &AgentDispatchStopPlanV1,
) -> Result<AgentDispatchStopRecordV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("plan_agent_dispatch_stop", error))?;
    begin_immediate(&mut connection, "plan_agent_dispatch_stop").await?;
    let result = async {
        if let Some(existing) = stop_on(&mut connection, plan.operation_id()).await? {
            if existing.record.plan() == plan {
                return Ok(existing.record);
            }
            return Err(identity_conflict(
                "agent dispatch stop",
                plan.operation_id().as_str(),
                "the operation already belongs to another immutable plan",
            ));
        }

        let reconstructed = reconstruct_plan_on(
            &mut connection,
            AgentDispatchStopPreviewV1 {
                schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
                operation_id: plan.operation_id().clone(),
                spawn_operation_id: plan.spawn().operation_id.clone(),
                workspace_plan: plan.workspace_plan().clone(),
                planned_at_ms: plan.planned_at_ms(),
            },
            plan.runtime_selection().clone(),
            plan.runtime_authority().clone(),
            plan.runtime_fence().cloned(),
            SpawnCheckoutEvidence::Current,
        )
        .await?;
        if reconstructed != *plan {
            return Err(identity_conflict(
                "agent dispatch stop",
                plan.operation_id().as_str(),
                "the plan does not match this store's canonical spawn receipt",
            ));
        }
        require_current_runtime_on(&mut connection, plan).await?;
        require_owned_checkout_on(&mut connection, plan).await?;
        if let Some(active) = competing_active_on(&mut connection, plan).await? {
            match active.record.state() {
                AgentDispatchStopStateV1::Planned => {
                    let superseded = supersede_agent_dispatch_stop_v1(&active.record, plan)?;
                    update_on(&mut connection, &active.record, &superseded, None).await?;
                }
                AgentDispatchStopStateV1::Authorized { .. } => {
                    return Err(identity_conflict(
                        "agent dispatch stop",
                        plan.agent_id().as_str(),
                        "an authorized stop cannot be superseded",
                    ));
                }
                AgentDispatchStopStateV1::Superseded
                | AgentDispatchStopStateV1::Succeeded { .. }
                | AgentDispatchStopStateV1::SourceRetained { .. }
                | AgentDispatchStopStateV1::WorkspacePreserved { .. }
                | AgentDispatchStopStateV1::WorkspaceReplaced { .. } => {
                    return Err(storage(
                        "corrupt_agent_dispatch_stop",
                        "an inactive stop was returned as the active blocker",
                    ));
                }
            }
        }

        let record = AgentDispatchStopRecordV1::planned(plan.clone());
        insert_on(&mut connection, &record).await?;
        Ok(record)
    }
    .await;
    finish_transaction(&mut connection, "plan_agent_dispatch_stop", result).await
}

pub(crate) async fn authorize(
    pool: &SqlitePool,
    request: &AgentDispatchStopAuthorizeRequestV1,
) -> Result<(AgentDispatchStopRecordV1, AgentRuntimeCloseRecordV1), DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("authorize_agent_dispatch_stop", error))?;
    begin_immediate(&mut connection, "authorize_agent_dispatch_stop").await?;
    let result = async {
        let current = stop_on(&mut connection, &request.operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent dispatch stop",
                id: request.operation_id.as_str().into(),
            })?;
        if matches!(current.record.state(), AgentDispatchStopStateV1::Superseded) {
            return Err(DomainStoreErrorV1::InvalidEventStream {
                reason: "a superseded Agent stop cannot authorize effects".into(),
            });
        }
        converge_current_runtime_on(&mut connection, current.record.plan()).await?;
        let child =
            agent_runtime_close::admit_on(&mut connection, &request.runtime_close_intent).await?;
        let (next, child) = authorize_agent_dispatch_stop_v1(&current.record, request, &child)?;
        if next != current.record {
            update_on(
                &mut connection,
                &current.record,
                &next,
                Some(request.authorized_at_ms),
            )
            .await?;
        }
        Ok((next, child))
    }
    .await;
    finish_transaction(&mut connection, "authorize_agent_dispatch_stop", result).await
}

pub(crate) async fn terminalize(
    pool: &SqlitePool,
    request: &AgentDispatchStopTerminalRequestV1,
) -> Result<AgentDispatchStopRecordV1, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("terminalize_agent_dispatch_stop", error))?;
    begin_immediate(&mut connection, "terminalize_agent_dispatch_stop").await?;
    let result = async {
        let current = stop_on(&mut connection, &request.operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent dispatch stop",
                id: request.operation_id.as_str().into(),
            })?;
        let effective = authoritative_terminal_request_on(&mut connection, request).await?;
        let next = terminalize_agent_dispatch_stop_v1(&current.record, &effective)?;
        if next != current.record {
            update_on(
                &mut connection,
                &current.record,
                &next,
                current.authorized_at_ms,
            )
            .await?;
        }
        Ok(next)
    }
    .await;
    finish_transaction(&mut connection, "terminalize_agent_dispatch_stop", result).await
}

pub(crate) async fn stop(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
) -> Result<Option<AgentDispatchStopRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_dispatch_stop", error))?;
    begin_read(&mut connection, "read_agent_dispatch_stop").await?;
    let result = stop_on(&mut connection, operation_id)
        .await
        .map(|value| value.map(|hydrated| hydrated.record));
    finish_transaction(&mut connection, "read_agent_dispatch_stop", result).await
}

pub(crate) async fn stop_for_spawn_operation(
    pool: &SqlitePool,
    spawn_operation_id: &OperationIdV1,
) -> Result<Option<AgentDispatchStopRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_agent_dispatch_stop_for_spawn", error))?;
    begin_read(&mut connection, "read_agent_dispatch_stop_for_spawn").await?;
    let result = async {
        let operation_id = operation_for_spawn_on(&mut connection, spawn_operation_id).await?;
        let Some(operation_id) = operation_id else {
            return Ok(None);
        };
        Ok(stop_on(&mut connection, &operation_id)
            .await?
            .map(|hydrated| hydrated.record))
    }
    .await;
    finish_transaction(
        &mut connection,
        "read_agent_dispatch_stop_for_spawn",
        result,
    )
    .await
}

pub(crate) async fn active_stop(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentDispatchStopRecordV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_active_agent_dispatch_stop", error))?;
    begin_read(&mut connection, "read_active_agent_dispatch_stop").await?;
    let result = async {
        let operation_id = active_operation_for_agent_on(&mut connection, agent_id).await?;
        let Some(operation_id) = operation_id else {
            return Ok(None);
        };
        Ok(stop_on(&mut connection, &operation_id)
            .await?
            .map(|hydrated| hydrated.record))
    }
    .await;
    finish_transaction(&mut connection, "read_active_agent_dispatch_stop", result).await
}

pub(crate) async fn recovery_candidates(
    pool: &SqlitePool,
) -> Result<Vec<AgentIdV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        r#"
        SELECT agent_id
        FROM agent_dispatch_stops
        WHERE state = 'authorized'
        ORDER BY updated_at_ms, operation_id
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| map_sqlx("read_agent_dispatch_stop_recovery_candidates", error))?;
    rows.into_iter()
        .map(|row| {
            let agent_id = row
                .try_get::<String, _>("agent_id")
                .map_err(|error| corrupt_row("agent_dispatch_stops", error))?;
            AgentIdV1::new(agent_id)
                .map_err(|error| corrupt_identifier("agent_dispatch_stops.agent_id", error))
        })
        .collect()
}

async fn reconstruct_plan_on(
    connection: &mut SqliteConnection,
    preview: AgentDispatchStopPreviewV1,
    runtime_selection: AgentRuntimeSelectionV1,
    runtime_authority: AgentRuntimeBindingAuthorityV1,
    runtime_fence: Option<AgentDispatchStopRuntimeFenceV1>,
    checkout_evidence: SpawnCheckoutEvidence,
) -> Result<AgentDispatchStopPlanV1, DomainStoreErrorV1> {
    let mut spawn =
        agent_spawn::validated_receipt_by_operation(connection, &preview.spawn_operation_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "agent spawn receipt",
                id: preview.spawn_operation_id.as_str().into(),
            })?;
    if let SpawnCheckoutEvidence::Frozen(registration) = checkout_evidence {
        spawn.checkout_registration = registration;
    }
    preview_agent_dispatch_stop_v1(
        preview,
        &spawn,
        runtime_selection,
        runtime_authority,
        runtime_fence,
    )
}

async fn require_current_runtime_on(
    connection: &mut SqliteConnection,
    plan: &AgentDispatchStopPlanV1,
) -> Result<(), DomainStoreErrorV1> {
    match plan.runtime_fence() {
        Some(AgentDispatchStopRuntimeFenceV1::Close { record }) => {
            let current =
                agent_runtime_close::effective_close_for_agent_on(connection, plan.agent_id())
                    .await?;
            return (current.as_ref() == Some(record.as_ref()))
                .then_some(())
                .ok_or_else(|| {
                    identity_conflict(
                        "agent runtime close",
                        plan.agent_id().as_str(),
                        "the dispatch stop does not target the current close journal",
                    )
                });
        }
        Some(AgentDispatchStopRuntimeFenceV1::Transition { record }) => {
            let current =
                agent_runtime_transition::active_transition_on(connection, plan.agent_id()).await?;
            return (current.as_ref() == Some(record.as_ref()))
                .then_some(())
                .ok_or_else(|| {
                    identity_conflict(
                        "agent runtime transition",
                        plan.agent_id().as_str(),
                        "the dispatch stop does not target the current transition journal",
                    )
                });
        }
        None => {
            if agent_runtime_close::effective_close_for_agent_on(connection, plan.agent_id())
                .await?
                .is_some()
                || agent_runtime_transition::active_transition_on(connection, plan.agent_id())
                    .await?
                    .is_some()
            {
                return Err(runtime_conflict(
                    plan,
                    "an unfenced dispatch stop requires a stable runtime",
                ));
            }
        }
    }
    require_selection_and_authority_on(connection, plan).await
}

async fn require_selection_and_authority_on(
    connection: &mut SqliteConnection,
    plan: &AgentDispatchStopPlanV1,
) -> Result<(), DomainStoreErrorV1> {
    let current = agent_runtime_transition::selection_on(connection, plan.agent_id()).await?;
    if current.as_ref() != Some(plan.runtime_selection()) {
        return Err(identity_conflict(
            "agent runtime selection",
            plan.agent_id().as_str(),
            "the dispatch stop does not target the current runtime selection",
        ));
    }
    agent_runtime_transition::require_current_runtime_authority_on(
        connection,
        plan.agent_id(),
        plan.runtime_authority(),
    )
    .await
}

async fn converge_current_runtime_on(
    connection: &mut SqliteConnection,
    plan: &AgentDispatchStopPlanV1,
) -> Result<(), DomainStoreErrorV1> {
    match plan.runtime_fence() {
        None => require_selection_and_authority_on(connection, plan).await,
        Some(AgentDispatchStopRuntimeFenceV1::Close { record }) => {
            let current = agent_runtime_close::close_on(connection, &record.intent.operation_id)
                .await?
                .ok_or_else(|| runtime_conflict(plan, "the frozen close no longer exists"))?;
            let exact_or_terminal_successor = current == **record
                || (record.state == dure_app::AgentRuntimeCloseStateV1::Admitted
                    && current.intent == record.intent
                    && current.journal_revision == record.journal_revision + 1
                    && matches!(
                        current.state,
                        dure_app::AgentRuntimeCloseStateV1::Stopped
                            | dure_app::AgentRuntimeCloseStateV1::SourceRetained
                    ));
            if !exact_or_terminal_successor
                || current.intent.source != *plan.runtime_selection()
                || current.intent.source_authority != *plan.runtime_authority()
            {
                return Err(runtime_conflict(
                    plan,
                    "the dispatch stop does not target the current close journal",
                ));
            }
            if current.state == dure_app::AgentRuntimeCloseStateV1::SourceRetained {
                if agent_runtime_close::effective_close_for_agent_on(connection, plan.agent_id())
                    .await?
                    .is_some()
                    || agent_runtime_transition::active_transition_on(connection, plan.agent_id())
                        .await?
                        .is_some()
                {
                    return Err(runtime_conflict(
                        plan,
                        "the retained source acquired a newer runtime operation",
                    ));
                }
                require_selection_and_authority_on(connection, plan).await?;
            }
            Ok(())
        }
        Some(AgentDispatchStopRuntimeFenceV1::Transition { record }) => {
            converge_transition_on(connection, plan, record).await
        }
    }
}

async fn converge_transition_on(
    connection: &mut SqliteConnection,
    plan: &AgentDispatchStopPlanV1,
    frozen: &AgentRuntimeTransitionRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let request = plan.runtime_transition_advance_for_authorize()?;
    let expected = match request.as_ref() {
        Some(request) => advance_agent_runtime_transition_v1(frozen, request)?,
        None => frozen.clone(),
    };
    let current = agent_runtime_transition::transition_on(connection, &frozen.intent.operation_id)
        .await?
        .ok_or_else(|| runtime_conflict(plan, "the frozen transition no longer exists"))?;
    if current != *frozen && current != expected {
        return Err(runtime_conflict(
            plan,
            "the dispatch stop does not target the current transition journal",
        ));
    }
    let current = match request {
        Some(request) => agent_runtime_transition::advance_on(connection, &request).await?,
        None => current,
    };
    if current != expected {
        return Err(runtime_conflict(
            plan,
            "the transition did not converge to the frozen successor",
        ));
    }

    match frozen.state {
        AgentRuntimeTransitionStateV1::Admitted | AgentRuntimeTransitionStateV1::TargetStarted => {
            require_selection_and_authority_on(connection, plan).await
        }
        AgentRuntimeTransitionStateV1::SourceStopped
        | AgentRuntimeTransitionStateV1::RepairRequired => {
            let active =
                agent_runtime_transition::active_transition_on(connection, plan.agent_id()).await?;
            if active.as_ref() != Some(&current)
                || current.intent.source != *plan.runtime_selection()
                || current.intent.source_authority != *plan.runtime_authority()
            {
                return Err(runtime_conflict(
                    plan,
                    "the converged transition is not the current runtime authority",
                ));
            }
            agent_runtime_transition::require_current_runtime_authority_on(
                connection,
                plan.agent_id(),
                plan.runtime_authority(),
            )
            .await
        }
        AgentRuntimeTransitionStateV1::SourceRetained
        | AgentRuntimeTransitionStateV1::Committed
        | AgentRuntimeTransitionStateV1::Superseded => Err(runtime_conflict(
            plan,
            "a terminal transition cannot be a dispatch stop fence",
        )),
    }
}

fn runtime_conflict(plan: &AgentDispatchStopPlanV1, reason: &str) -> DomainStoreErrorV1 {
    identity_conflict("agent dispatch stop", plan.agent_id().as_str(), reason)
}

async fn require_owned_checkout_on(
    connection: &mut SqliteConnection,
    plan: &AgentDispatchStopPlanV1,
) -> Result<(), DomainStoreErrorV1> {
    let Some(owned_checkout) = plan.owned_checkout() else {
        return Ok(());
    };
    if let Some(registration) = &plan.spawn().checkout_registration {
        return (owned_checkout.repository_path == registration.repository_path
            && owned_checkout.instance == registration.instance)
            .then_some(())
            .ok_or_else(|| {
                identity_conflict(
                    "agent dispatch stop checkout",
                    plan.spawn().operation_id.as_str(),
                    "removal must target the spawn's frozen checkout registration",
                )
            });
    }
    let workspace_id = plan.spawn().workspace.workspace_id();
    let workspace = records::workspace_on(connection, workspace_id)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "workspace",
            id: workspace_id.as_str().into(),
        })?;
    if workspace.project_id != plan.spawn().authority.project_id
        || workspace.root_path != owned_checkout.instance.canonical_path
    {
        return Err(identity_conflict(
            "agent dispatch stop checkout",
            workspace_id.as_str(),
            "the captured checkout does not belong to the spawned workspace",
        ));
    }
    Ok(())
}

async fn authoritative_terminal_request_on(
    connection: &mut SqliteConnection,
    request: &AgentDispatchStopTerminalRequestV1,
) -> Result<AgentDispatchStopTerminalRequestV1, DomainStoreErrorV1> {
    let requested_child = match &request.transition {
        AgentDispatchStopTerminalTransitionV1::Preserved { runtime_close }
        | AgentDispatchStopTerminalTransitionV1::Succeeded { runtime_close, .. }
        | AgentDispatchStopTerminalTransitionV1::SourceRetained { runtime_close }
        | AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced { runtime_close } => {
            runtime_close
        }
    };
    let child = agent_runtime_close::close_on(connection, &requested_child.intent.operation_id)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "agent runtime close",
            id: requested_child.intent.operation_id.as_str().into(),
        })?;
    let transition = match &request.transition {
        AgentDispatchStopTerminalTransitionV1::Preserved { .. } => {
            AgentDispatchStopTerminalTransitionV1::Preserved {
                runtime_close: Box::new(child),
            }
        }
        AgentDispatchStopTerminalTransitionV1::Succeeded { workspace, .. } => {
            AgentDispatchStopTerminalTransitionV1::Succeeded {
                runtime_close: Box::new(child),
                workspace: workspace.clone(),
            }
        }
        AgentDispatchStopTerminalTransitionV1::SourceRetained { .. } => {
            AgentDispatchStopTerminalTransitionV1::SourceRetained {
                runtime_close: Box::new(child),
            }
        }
        AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced { .. } => {
            AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                runtime_close: Box::new(child),
            }
        }
    };
    Ok(AgentDispatchStopTerminalRequestV1 {
        schema_version: request.schema_version,
        operation_id: request.operation_id.clone(),
        plan_token: request.plan_token.clone(),
        expected_journal_revision: request.expected_journal_revision,
        transition,
        transitioned_at_ms: request.transitioned_at_ms,
    })
}

async fn insert_on(
    connection: &mut SqliteConnection,
    record: &AgentDispatchStopRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let plan = record.plan();
    let runtime_selection_json = encode(
        "Agent dispatch stop runtime selection",
        plan.runtime_selection(),
    )?;
    let runtime_authority_json = encode(
        "Agent dispatch stop runtime authority",
        plan.runtime_authority(),
    )?;
    let workspace_action_json = encode(
        "Agent dispatch stop workspace action",
        &StoredStopPlanTailV1 {
            workspace_plan: plan.workspace_plan().clone(),
            runtime_fence: plan.runtime_fence().cloned(),
            checkout_registration: plan.spawn().checkout_registration.clone(),
        },
    )?;
    sqlx::query(
        r#"
        INSERT INTO agent_dispatch_stops (
            operation_id, agent_id, spawn_operation_id, plan_token, state,
            journal_revision, runtime_selection_json, runtime_authority_json,
            workspace_action_json, runtime_close_operation_id,
            terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, 'planned', 1, ?5, ?6, ?7, NULL, NULL, ?8, NULL, ?8)
        "#,
    )
    .bind(plan.operation_id().as_str())
    .bind(plan.agent_id().as_str())
    .bind(plan.spawn().operation_id.as_str())
    .bind(plan.plan_token().as_str())
    .bind(runtime_selection_json)
    .bind(runtime_authority_json)
    .bind(workspace_action_json)
    .bind(plan.planned_at_ms())
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("plan_agent_dispatch_stop", error))?;
    Ok(())
}

async fn update_on(
    connection: &mut SqliteConnection,
    current: &AgentDispatchStopRecordV1,
    next: &AgentDispatchStopRecordV1,
    authorized_at_ms: Option<i64>,
) -> Result<(), DomainStoreErrorV1> {
    let terminal_workspace_receipt_json = match next.state() {
        AgentDispatchStopStateV1::Succeeded { workspace, .. } => {
            Some(encode("Agent dispatch stop workspace receipt", workspace)?)
        }
        AgentDispatchStopStateV1::Planned
        | AgentDispatchStopStateV1::Superseded
        | AgentDispatchStopStateV1::Authorized { .. }
        | AgentDispatchStopStateV1::SourceRetained { .. }
        | AgentDispatchStopStateV1::WorkspacePreserved { .. }
        | AgentDispatchStopStateV1::WorkspaceReplaced { .. } => None,
    };
    let result = sqlx::query(
        r#"
        UPDATE agent_dispatch_stops SET
            state = ?2,
            journal_revision = ?3,
            runtime_close_operation_id = ?4,
            terminal_workspace_receipt_json = ?5,
            authorized_at_ms = ?6,
            updated_at_ms = ?7
        WHERE operation_id = ?1 AND journal_revision = ?8
        "#,
    )
    .bind(next.plan().operation_id().as_str())
    .bind(state_name(next.state()))
    .bind(next.journal_revision())
    .bind(runtime_operation_id(next.state()).map(OperationIdV1::as_str))
    .bind(terminal_workspace_receipt_json)
    .bind(authorized_at_ms)
    .bind(next.updated_at_ms())
    .bind(current.journal_revision())
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("advance_agent_dispatch_stop", error))?;
    if result.rows_affected() != 1 {
        return Err(DomainStoreErrorV1::RevisionConflict {
            agent_id: current.plan().agent_id().as_str().into(),
            expected_revision: current.journal_revision(),
            actual_revision: None,
        });
    }
    Ok(())
}

async fn stop_on(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
) -> Result<Option<HydratedStop>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT operation_id, agent_id, spawn_operation_id, plan_token, state,
               journal_revision, runtime_selection_json, runtime_authority_json,
               workspace_action_json, runtime_close_operation_id,
               terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
               updated_at_ms
        FROM agent_dispatch_stops
        WHERE operation_id = ?1
        "#,
    )
    .bind(operation_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_dispatch_stop", error))?;
    match row {
        Some(row) => hydrate_row_on(connection, row).await.map(Some),
        None => Ok(None),
    }
}

async fn hydrate_row_on(
    connection: &mut SqliteConnection,
    row: SqliteRow,
) -> Result<HydratedStop, DomainStoreErrorV1> {
    let operation_id = stored_operation_id(&row, "operation_id")?;
    let agent_id = stored_agent_id(&row)?;
    let spawn_operation_id = stored_operation_id(&row, "spawn_operation_id")?;
    let plan_token = column::<String>(&row, "plan_token")?;
    let state = column::<String>(&row, "state")?;
    let journal_revision = column::<i64>(&row, "journal_revision")?;
    let runtime_selection = decode::<AgentRuntimeSelectionV1>(
        "Agent dispatch stop runtime selection",
        column::<String>(&row, "runtime_selection_json")?,
    )?;
    let runtime_authority = decode::<AgentRuntimeBindingAuthorityV1>(
        "Agent dispatch stop runtime authority",
        column::<String>(&row, "runtime_authority_json")?,
    )?;
    let stored_tail = decode::<StoredStopPlanTailV1>(
        "Agent dispatch stop workspace action",
        column::<String>(&row, "workspace_action_json")?,
    )?;
    let runtime_close_operation_id = column::<Option<String>>(&row, "runtime_close_operation_id")?
        .map(OperationIdV1::new)
        .transpose()
        .map_err(|error| {
            corrupt_identifier("agent_dispatch_stops.runtime_close_operation_id", error)
        })?;
    let terminal_workspace_receipt_json =
        column::<Option<String>>(&row, "terminal_workspace_receipt_json")?;
    let planned_at_ms = column::<i64>(&row, "planned_at_ms")?;
    let authorized_at_ms = column::<Option<i64>>(&row, "authorized_at_ms")?;
    let updated_at_ms = column::<i64>(&row, "updated_at_ms")?;

    let plan = reconstruct_plan_on(
        connection,
        AgentDispatchStopPreviewV1 {
            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            operation_id: operation_id.clone(),
            spawn_operation_id: spawn_operation_id.clone(),
            workspace_plan: stored_tail.workspace_plan,
            planned_at_ms,
        },
        runtime_selection,
        runtime_authority,
        stored_tail.runtime_fence,
        SpawnCheckoutEvidence::Frozen(stored_tail.checkout_registration),
    )
    .await?;
    if plan.agent_id() != &agent_id
        || plan.spawn().operation_id != spawn_operation_id
        || plan.plan_token().as_str() != plan_token
    {
        return Err(storage(
            "corrupt_agent_dispatch_stop",
            "stored plan identity does not match its authoritative reconstruction",
        ));
    }

    let planned = AgentDispatchStopRecordV1::planned(plan);
    let record = match state.as_str() {
        "planned" => planned,
        "superseded" => {
            if runtime_close_operation_id.is_some()
                || terminal_workspace_receipt_json.is_some()
                || authorized_at_ms.is_some()
            {
                return Err(storage(
                    "corrupt_agent_dispatch_stop",
                    "a superseded stop contains effect authority",
                ));
            }
            replay_superseded_agent_dispatch_stop_v1(&planned, updated_at_ms)?
        }
        "authorized"
        | "succeeded"
        | "source_retained"
        | "workspace_preserved"
        | "workspace_replaced" => {
            let child_operation_id = runtime_close_operation_id.as_ref().ok_or_else(|| {
                storage(
                    "corrupt_agent_dispatch_stop",
                    "a non-planned stop has no child runtime-close operation",
                )
            })?;
            let child = agent_runtime_close::close_on(connection, child_operation_id)
                .await?
                .ok_or_else(|| {
                    storage(
                        "missing_agent_dispatch_stop_child",
                        format!("runtime close {child_operation_id} is missing"),
                    )
                })?;
            let authorized_at_ms = authorized_at_ms.ok_or_else(|| {
                storage(
                    "corrupt_agent_dispatch_stop",
                    "a non-planned stop has no authorization timestamp",
                )
            })?;
            let (authorized, _) = authorize_agent_dispatch_stop_v1(
                &planned,
                &AgentDispatchStopAuthorizeRequestV1 {
                    schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
                    operation_id: operation_id.clone(),
                    plan_token: planned.plan().plan_token().clone(),
                    expected_journal_revision: 1,
                    runtime_close_intent: child.intent.clone(),
                    authorized_at_ms,
                },
                &child,
            )?;
            match state.as_str() {
                "authorized" => authorized,
                terminal => {
                    let transition = match terminal {
                        "succeeded" => AgentDispatchStopTerminalTransitionV1::Succeeded {
                            runtime_close: Box::new(child),
                            workspace: decode(
                                "Agent dispatch stop workspace receipt",
                                terminal_workspace_receipt_json.ok_or_else(|| {
                                    storage(
                                        "corrupt_agent_dispatch_stop",
                                        "a succeeded stop has no workspace receipt",
                                    )
                                })?,
                            )?,
                        },
                        "source_retained" => {
                            AgentDispatchStopTerminalTransitionV1::SourceRetained {
                                runtime_close: Box::new(child),
                            }
                        }
                        "workspace_preserved" => AgentDispatchStopTerminalTransitionV1::Preserved {
                            runtime_close: Box::new(child),
                        },
                        "workspace_replaced" => {
                            AgentDispatchStopTerminalTransitionV1::WorkspaceReplaced {
                                runtime_close: Box::new(child),
                            }
                        }
                        _ => unreachable!(),
                    };
                    terminalize_agent_dispatch_stop_v1(
                        &authorized,
                        &AgentDispatchStopTerminalRequestV1 {
                            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
                            operation_id: operation_id.clone(),
                            plan_token: authorized.plan().plan_token().clone(),
                            expected_journal_revision: 2,
                            transition,
                            transitioned_at_ms: updated_at_ms,
                        },
                    )?
                }
            }
        }
        _ => {
            return Err(storage(
                "corrupt_agent_dispatch_stop",
                format!("stored stop state {state:?} is unsupported"),
            ));
        }
    };

    if record.journal_revision() != journal_revision
        || record.updated_at_ms() != updated_at_ms
        || state_name(record.state()) != state
        || runtime_operation_id(record.state()) != runtime_close_operation_id.as_ref()
    {
        return Err(storage(
            "corrupt_agent_dispatch_stop",
            "stored transition columns do not match the authoritative reconstruction",
        ));
    }
    Ok(HydratedStop {
        record,
        authorized_at_ms,
    })
}

async fn competing_active_on(
    connection: &mut SqliteConnection,
    plan: &AgentDispatchStopPlanV1,
) -> Result<Option<HydratedStop>, DomainStoreErrorV1> {
    let by_agent = active_operation_for_agent_on(connection, plan.agent_id()).await?;
    let by_spawn = active_operation_for_spawn_on(connection, &plan.spawn().operation_id).await?;
    let operation_id = match (by_agent, by_spawn) {
        (None, None) => return Ok(None),
        (Some(by_agent), Some(by_spawn)) if by_agent == by_spawn => by_agent,
        (Some(by_agent), Some(by_spawn)) => {
            return Err(identity_conflict(
                "agent dispatch stop",
                plan.agent_id().as_str(),
                format!(
                    "active Agent operation {by_agent} differs from spawn operation {by_spawn}"
                ),
            ));
        }
        (Some(operation_id), None) => {
            return Err(identity_conflict(
                "agent dispatch stop",
                plan.agent_id().as_str(),
                format!("operation {operation_id} belongs to another spawn"),
            ));
        }
        (None, Some(operation_id)) => {
            return Err(identity_conflict(
                "agent dispatch stop spawn",
                plan.spawn().operation_id.as_str(),
                format!("operation {operation_id} belongs to another Agent"),
            ));
        }
    };
    let active = stop_on(connection, &operation_id).await?.ok_or_else(|| {
        storage(
            "corrupt_agent_dispatch_stop",
            format!("active operation {operation_id} is missing"),
        )
    })?;
    if active.record.plan().agent_id() != plan.agent_id()
        || active.record.plan().spawn().operation_id != plan.spawn().operation_id
    {
        return Err(identity_conflict(
            "agent dispatch stop",
            plan.agent_id().as_str(),
            format!("operation {operation_id} does not replace the same Agent spawn"),
        ));
    }
    Ok(Some(active))
}

async fn active_operation_for_agent_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<OperationIdV1>, DomainStoreErrorV1> {
    operation_id_query(
        sqlx::query_scalar(
            "SELECT operation_id FROM agent_dispatch_stops WHERE agent_id = ?1 AND state IN ('planned', 'authorized')",
        )
        .bind(agent_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_active_agent_dispatch_stop", error))?,
        "agent_dispatch_stops.operation_id",
    )
}

async fn active_operation_for_spawn_on(
    connection: &mut SqliteConnection,
    spawn_operation_id: &OperationIdV1,
) -> Result<Option<OperationIdV1>, DomainStoreErrorV1> {
    operation_id_query(
        sqlx::query_scalar(
            "SELECT operation_id FROM agent_dispatch_stops WHERE spawn_operation_id = ?1 AND state IN ('planned', 'authorized')",
        )
        .bind(spawn_operation_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_active_agent_dispatch_stop", error))?,
        "agent_dispatch_stops.operation_id",
    )
}

async fn operation_for_spawn_on(
    connection: &mut SqliteConnection,
    spawn_operation_id: &OperationIdV1,
) -> Result<Option<OperationIdV1>, DomainStoreErrorV1> {
    operation_id_query(
        sqlx::query_scalar(
            r#"
            SELECT operation_id
            FROM agent_dispatch_stops
            WHERE spawn_operation_id = ?1
            ORDER BY
                CASE
                    WHEN state IN ('planned', 'authorized') THEN 0
                    WHEN state IN (
                        'succeeded',
                        'source_retained',
                        'workspace_preserved',
                        'workspace_replaced'
                    ) THEN 1
                    WHEN state = 'superseded' THEN 2
                    ELSE 3
                END,
                planned_at_ms DESC,
                operation_id DESC
            LIMIT 1
            "#,
        )
        .bind(spawn_operation_id.as_str())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_agent_dispatch_stop_for_spawn", error))?,
        "agent_dispatch_stops.operation_id",
    )
}

fn operation_id_query(
    value: Option<String>,
    field: &'static str,
) -> Result<Option<OperationIdV1>, DomainStoreErrorV1> {
    value
        .map(OperationIdV1::new)
        .transpose()
        .map_err(|error| corrupt_identifier(field, error))
}

fn stored_operation_id(
    row: &SqliteRow,
    field: &'static str,
) -> Result<OperationIdV1, DomainStoreErrorV1> {
    OperationIdV1::new(column::<String>(row, field)?)
        .map_err(|error| corrupt_identifier(field, error))
}

fn stored_agent_id(row: &SqliteRow) -> Result<AgentIdV1, DomainStoreErrorV1> {
    AgentIdV1::new(column::<String>(row, "agent_id")?)
        .map_err(|error| corrupt_identifier("agent_dispatch_stops.agent_id", error))
}

fn column<T>(row: &SqliteRow, field: &'static str) -> Result<T, DomainStoreErrorV1>
where
    for<'value> T: sqlx::Decode<'value, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite>,
{
    row.try_get(field)
        .map_err(|error| corrupt_row("agent_dispatch_stops", error))
}

fn encode<T: serde::Serialize>(
    entity: &'static str,
    value: &T,
) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(value).map_err(|error| serialization(entity, error))
}

fn decode<T: DeserializeOwned>(
    entity: &'static str,
    value: String,
) -> Result<T, DomainStoreErrorV1> {
    serde_json::from_str(&value).map_err(|error| serialization(entity, error))
}

fn state_name(state: &AgentDispatchStopStateV1) -> &'static str {
    match state {
        AgentDispatchStopStateV1::Planned => "planned",
        AgentDispatchStopStateV1::Superseded => "superseded",
        AgentDispatchStopStateV1::Authorized { .. } => "authorized",
        AgentDispatchStopStateV1::Succeeded { .. } => "succeeded",
        AgentDispatchStopStateV1::SourceRetained { .. } => "source_retained",
        AgentDispatchStopStateV1::WorkspacePreserved { .. } => "workspace_preserved",
        AgentDispatchStopStateV1::WorkspaceReplaced { .. } => "workspace_replaced",
    }
}

fn runtime_operation_id(state: &AgentDispatchStopStateV1) -> Option<&OperationIdV1> {
    match state {
        AgentDispatchStopStateV1::Authorized {
            runtime_close_operation_id,
        } => Some(runtime_close_operation_id),
        AgentDispatchStopStateV1::Succeeded { runtime, .. }
        | AgentDispatchStopStateV1::SourceRetained { runtime }
        | AgentDispatchStopStateV1::WorkspacePreserved { runtime }
        | AgentDispatchStopStateV1::WorkspaceReplaced { runtime } => Some(&runtime.operation_id),
        AgentDispatchStopStateV1::Planned | AgentDispatchStopStateV1::Superseded => None,
    }
}

async fn begin_read(
    connection: &mut SqliteConnection,
    operation: &'static str,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx(operation, error))?;
    Ok(())
}
