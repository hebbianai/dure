use dure_app::{
    DELEGATE_ONCE_SCHEMA_VERSION_V1, DelegateOncePromptActivityRequestV1,
    DelegateOncePromptClaimRequestV1, DelegateOncePromptOutcomeRequestV1, DelegateOnceReceiptV1,
    DelegateOnceRequestV1, DelegateOnceSessionBindingRequestV1, DelegateOnceStartFailureRequestV1,
    DispatchIdV1, DomainStoreErrorV1, ProviderIdV1, RunIdV1, TaskIdV1, WorkflowDispatchStateV1,
    WorkflowPromptActivityStateV1, WorkflowPromptDeliveryClaimV1, WorkflowPromptDeliveryOutcomeV1,
    WorkflowPromptDeliveryReceiptV1, WorkflowPromptDeliveryStateV1, WorkflowSessionGenerationV1,
    prepare_delegate_once, validate_workflow_effective_launch_identity,
    workflow_prepared_session_id,
};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, storage};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) mod launch;

pub(crate) async fn create(
    pool: &SqlitePool,
    request: &DelegateOnceRequestV1,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    let prepared = prepare_delegate_once(request)?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("create_delegate_once", error))?;
    begin_immediate(&mut connection, "create_delegate_once").await?;

    let result = async {
        if let Some(stored_digest) =
            request_digest_on(&mut connection, &request.idempotency_key).await?
        {
            if stored_digest != prepared.request_digest {
                return Err(DomainStoreErrorV1::IdempotencyConflict {
                    reason: "delegate_once key is already bound to a different request".into(),
                });
            }
            return receipt_on(&mut connection, &request.idempotency_key)
                .await?
                .ok_or_else(|| corrupt_link("receipt disappeared after digest lookup"));
        }

        let receipt = &prepared.receipt;
        sqlx::query(
            r#"
            INSERT INTO workflow_runs (
                run_id,
                contribution_id,
                coordinator_agent_id,
                coordinator_session_id,
                coordinator_binding_generation,
                created_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )
        .bind(receipt.run_id.as_str())
        .bind(request.contribution_id.as_str())
        .bind(request.coordinator.agent_id.as_str())
        .bind(&request.coordinator.session_id)
        .bind(request.coordinator.binding_generation)
        .bind(request.created_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("create_delegate_once_run", error))?;

        sqlx::query(
            r#"
            INSERT INTO workflow_tasks (
                task_id,
                run_id,
                schema_version,
                summary,
                instructions,
                state,
                created_at_ms,
                updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'dispatched', ?6, ?6)
            "#,
        )
        .bind(receipt.task_id.as_str())
        .bind(receipt.run_id.as_str())
        .bind(i64::from(request.schema_version))
        .bind(&request.task.summary)
        .bind(&request.task.instructions)
        .bind(request.created_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("create_delegate_once_task", error))?;

        sqlx::query(
            r#"
            INSERT INTO workflow_dispatches (
                dispatch_id,
                task_id,
                provider_id,
                runtime_kind_id,
                target_reference,
                generation,
                state,
                created_at_ms,
                updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', ?7, ?7)
            "#,
        )
        .bind(receipt.dispatch_id.as_str())
        .bind(receipt.task_id.as_str())
        .bind(request.provider_id.as_str())
        .bind(request.runtime_kind_id.as_str())
        .bind(&request.target_reference)
        .bind(receipt.generation)
        .bind(request.created_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("create_delegate_once_dispatch", error))?;

        sqlx::query(
            r#"
            INSERT INTO workflow_dispatch_launches (
                dispatch_id,
                launch_idempotency_key,
                state,
                updated_at_ms
            ) VALUES (?1, ?2, 'starting', ?3)
            "#,
        )
        .bind(receipt.dispatch_id.as_str())
        .bind(&receipt.launch_idempotency_key)
        .bind(request.created_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("create_delegate_once_launch", error))?;

        sqlx::query(
            r#"
            INSERT INTO workflow_delegate_once_receipts (
                idempotency_key,
                request_digest,
                run_id,
                task_id,
                dispatch_id
            ) VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(&request.idempotency_key)
        .bind(&prepared.request_digest)
        .bind(receipt.run_id.as_str())
        .bind(receipt.task_id.as_str())
        .bind(receipt.dispatch_id.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("create_delegate_once_receipt", error))?;

        Ok(receipt.clone())
    }
    .await;

    finish_transaction(&mut connection, "create_delegate_once", result).await
}

pub(crate) async fn bind_session(
    pool: &SqlitePool,
    request: &DelegateOnceSessionBindingRequestV1,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("bind_delegate_once_session", error))?;
    begin_immediate(&mut connection, "bind_delegate_once_session").await?;

    let result = async {
        let launch_state = validate_launch_transition(
            &mut connection,
            &request.task_id,
            &request.dispatch_id,
            request.generation,
            &request.launch_idempotency_key,
            request.bound_at_ms,
        )
        .await?;
        match launch_state.as_str() {
            "starting" => {
                let updated = sqlx::query(
                    r#"
                    UPDATE workflow_dispatch_launches
                    SET
                        state = 'active',
                        effective_launch_idempotency_key = ?1,
                        session_id = ?2,
                        workspace_id = ?3,
                        provider_id = ?4,
                        runner_principal = ?5,
                        runner_instance = ?6,
                        channel_epoch = ?7,
                        host_instance_id = ?8,
                        terminal_epoch = ?9,
                        prompt_delivery_idempotency_key = ?10,
                        prompt_delivery_state = 'pending',
                        updated_at_ms = ?11
                    WHERE dispatch_id = ?12 AND state = 'starting'
                    "#,
                )
                .bind(&request.effective_launch_idempotency_key)
                .bind(&request.session.session_id)
                .bind(&request.session.workspace_id)
                .bind(request.session.provider_id.as_str())
                .bind(&request.session.runner_principal)
                .bind(&request.session.runner_instance)
                .bind(&request.session.channel_epoch)
                .bind(&request.session.host_instance_id)
                .bind(&request.session.terminal_epoch)
                .bind(format!("prompt:{}", request.launch_idempotency_key))
                .bind(request.bound_at_ms)
                .bind(request.dispatch_id.as_str())
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("bind_delegate_once_session", error))?;
                if updated.rows_affected() != 1 {
                    return Err(corrupt_link("Dispatch launch changed during binding"));
                }
            }
            "active" => {}
            "start_failed" => {
                return Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "workflow_dispatch_launch",
                    id: request.dispatch_id.to_string(),
                    reason: "a terminal start failure is already recorded".into(),
                });
            }
            _ => return Err(corrupt_link("Dispatch launch has an unsupported state")),
        }
        let receipt = receipt_for_dispatch(&mut connection, &request.dispatch_id).await?;
        if receipt.session.as_ref() != Some(&request.session)
            || receipt.effective_launch_key()? != request.effective_launch_idempotency_key.as_str()
        {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "workflow_session_generation",
                id: request.dispatch_id.to_string(),
                reason: "Dispatch is already bound to a different Session generation".into(),
            });
        }
        Ok(receipt)
    }
    .await;

    finish_transaction(&mut connection, "bind_delegate_once_session", result).await
}

pub(crate) async fn repair_effective_launch(
    pool: &SqlitePool,
    request: &dure_app::WorkflowEffectiveLaunchRepairRequestV1,
) -> Result<(), DomainStoreErrorV1> {
    repair_effective_launch_for_runtime(pool, request, None).await
}

pub(crate) async fn repair_effective_launch_for_runtime(
    pool: &SqlitePool,
    request: &dure_app::WorkflowEffectiveLaunchRepairRequestV1,
    expected_runtime_kind_id: Option<&dure_app::RuntimeKindIdV1>,
) -> Result<(), DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("repair_delegate_once_effective_launch", error))?;
    begin_immediate(&mut connection, "repair_delegate_once_effective_launch").await?;
    let result = async {
        let row = sqlx::query(
            r#"
            SELECT
                launch.launch_idempotency_key,
                launch.effective_launch_idempotency_key
            FROM workflow_dispatch_launches AS launch
            JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = launch.dispatch_id
            WHERE launch.dispatch_id = ?1
              AND launch.state = 'active'
              AND launch.delivery_mode = 'pty_prompt'
              AND launch.session_id = ?2
              AND launch.workspace_id = ?3
              AND launch.provider_id = ?4
              AND launch.runner_principal = ?5
              AND launch.runner_instance = ?6
              AND launch.channel_epoch = ?7
              AND launch.host_instance_id = ?8
              AND launch.terminal_epoch = ?9
              AND dispatch.task_id = ?10
              AND dispatch.generation = ?11
              AND (?12 IS NULL OR dispatch.runtime_kind_id = ?12)
            "#,
        )
        .bind(request.dispatch_id.as_str())
        .bind(&request.session.session_id)
        .bind(&request.session.workspace_id)
        .bind(request.session.provider_id.as_str())
        .bind(&request.session.runner_principal)
        .bind(&request.session.runner_instance)
        .bind(&request.session.channel_epoch)
        .bind(&request.session.host_instance_id)
        .bind(&request.session.terminal_epoch)
        .bind(request.task_id.as_str())
        .bind(request.generation)
        .bind(expected_runtime_kind_id.map(dure_app::RuntimeKindIdV1::as_str))
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("repair_delegate_once_effective_launch", error))?
        .ok_or_else(|| DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_effective_launch_identity",
            id: request.dispatch_id.to_string(),
            reason: "the exact pty_prompt Dispatch Session does not exist".into(),
        })?;
        let launch_idempotency_key: String = row
            .try_get("launch_idempotency_key")
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
        let stored_effective_launch_idempotency_key: Option<String> = row
            .try_get("effective_launch_idempotency_key")
            .map_err(|error| storage("corrupt_workflow_dispatch", error.to_string()))?;
        let prepared_session_id = workflow_prepared_session_id(&request.dispatch_id)?;
        validate_workflow_effective_launch_identity(
            &prepared_session_id,
            &launch_idempotency_key,
            &request.session,
            &request.effective_launch_idempotency_key,
        )?;
        if stored_effective_launch_idempotency_key
            .as_deref()
            .is_some_and(|stored| stored != request.effective_launch_idempotency_key)
        {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "workflow_effective_launch_identity",
                id: request.dispatch_id.to_string(),
                reason: "the Dispatch is already bound to a different effective create key".into(),
            });
        }
        let updated = sqlx::query(
            r#"
            UPDATE workflow_dispatch_launches
            SET effective_launch_idempotency_key = ?1,
                updated_at_ms = MAX(updated_at_ms, ?2)
            WHERE dispatch_id = ?3
              AND state = 'active'
              AND delivery_mode = 'pty_prompt'
              AND session_id = ?4
              AND workspace_id = ?5
              AND provider_id = ?6
              AND runner_principal = ?7
              AND runner_instance = ?8
              AND channel_epoch = ?9
              AND host_instance_id = ?10
              AND terminal_epoch = ?11
              AND (
                    effective_launch_idempotency_key IS NULL
                    OR effective_launch_idempotency_key = ?1
              )
              AND EXISTS (
                    SELECT 1
                    FROM workflow_dispatches AS dispatch
                    WHERE dispatch.dispatch_id = workflow_dispatch_launches.dispatch_id
                      AND dispatch.task_id = ?12
                      AND dispatch.generation = ?13
                      AND (?14 IS NULL OR dispatch.runtime_kind_id = ?14)
              )
              AND launch_idempotency_key = ?15
            "#,
        )
        .bind(&request.effective_launch_idempotency_key)
        .bind(request.repaired_at_ms)
        .bind(request.dispatch_id.as_str())
        .bind(&request.session.session_id)
        .bind(&request.session.workspace_id)
        .bind(request.session.provider_id.as_str())
        .bind(&request.session.runner_principal)
        .bind(&request.session.runner_instance)
        .bind(&request.session.channel_epoch)
        .bind(&request.session.host_instance_id)
        .bind(&request.session.terminal_epoch)
        .bind(request.task_id.as_str())
        .bind(request.generation)
        .bind(expected_runtime_kind_id.map(dure_app::RuntimeKindIdV1::as_str))
        .bind(&launch_idempotency_key)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("repair_delegate_once_effective_launch", error))?;
        if updated.rows_affected() != 1 {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "workflow_effective_launch_identity",
                id: request.dispatch_id.to_string(),
                reason: "the exact Dispatch Session cannot accept this effective create key".into(),
            });
        }
        Ok(())
    }
    .await;
    finish_transaction(
        &mut connection,
        "repair_delegate_once_effective_launch",
        result,
    )
    .await
}

pub(crate) async fn fail_start(
    pool: &SqlitePool,
    request: &DelegateOnceStartFailureRequestV1,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("fail_delegate_once_start", error))?;
    begin_immediate(&mut connection, "fail_delegate_once_start").await?;

    let result = async {
        let launch_state = validate_launch_transition(
            &mut connection,
            &request.task_id,
            &request.dispatch_id,
            request.generation,
            &request.launch_idempotency_key,
            request.failed_at_ms,
        )
        .await?;
        match launch_state.as_str() {
            "starting" => {
                let updated = sqlx::query(
                    r#"
                    UPDATE workflow_dispatch_launches
                    SET state = 'start_failed', start_error_code = ?1, updated_at_ms = ?2
                    WHERE dispatch_id = ?3 AND state = 'starting'
                    "#,
                )
                .bind(&request.error_code)
                .bind(request.failed_at_ms)
                .bind(request.dispatch_id.as_str())
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("fail_delegate_once_start", error))?;
                if updated.rows_affected() != 1 {
                    return Err(corrupt_link(
                        "Dispatch launch changed while recording failure",
                    ));
                }
            }
            "start_failed" => {}
            "active" => {
                return Err(DomainStoreErrorV1::IdentityConflict {
                    entity: "workflow_dispatch_launch",
                    id: request.dispatch_id.to_string(),
                    reason: "a Session generation is already bound".into(),
                });
            }
            _ => return Err(corrupt_link("Dispatch launch has an unsupported state")),
        }
        let receipt = receipt_for_dispatch(&mut connection, &request.dispatch_id).await?;
        if receipt.start_error_code.as_deref() != Some(request.error_code.as_str()) {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "workflow_start_failure",
                id: request.dispatch_id.to_string(),
                reason: "Dispatch already records a different start failure".into(),
            });
        }
        Ok(receipt)
    }
    .await;

    finish_transaction(&mut connection, "fail_delegate_once_start", result).await
}

pub(crate) async fn claim_prompt(
    pool: &SqlitePool,
    request: &DelegateOncePromptClaimRequestV1,
) -> Result<WorkflowPromptDeliveryClaimV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("claim_delegate_once_prompt", error))?;
    begin_immediate(&mut connection, "claim_delegate_once_prompt").await?;

    let result = async {
        let receipt = receipt_for_dispatch(&mut connection, &request.dispatch_id).await?;
        validate_prompt_fence(
            &receipt,
            &request.task_id,
            request.generation,
            &request.delivery_idempotency_key,
            &request.session,
            false,
        )?;
        let prompt = receipt
            .prompt_delivery
            .as_ref()
            .ok_or_else(|| corrupt_link("active Dispatch has no prompt delivery receipt"))?;
        let claimed = if prompt.state == WorkflowPromptDeliveryStateV1::Pending {
            validate_prompt_transition_time(&receipt, request.claimed_at_ms)?;
            let updated = sqlx::query(
                r#"
                UPDATE workflow_dispatch_launches
                SET prompt_delivery_state = 'uncertain', updated_at_ms = ?1
                WHERE dispatch_id = ?2 AND prompt_delivery_state = 'pending'
                "#,
            )
            .bind(request.claimed_at_ms)
            .bind(request.dispatch_id.as_str())
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("claim_delegate_once_prompt", error))?;
            if updated.rows_affected() != 1 {
                return Err(corrupt_link(
                    "prompt delivery changed while claiming its external boundary",
                ));
            }
            true
        } else {
            false
        };
        Ok(WorkflowPromptDeliveryClaimV1 {
            claimed,
            receipt: receipt_for_dispatch(&mut connection, &request.dispatch_id).await?,
        })
    }
    .await;

    finish_transaction(&mut connection, "claim_delegate_once_prompt", result).await
}

pub(crate) async fn record_prompt_outcome(
    pool: &SqlitePool,
    request: &DelegateOncePromptOutcomeRequestV1,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("record_delegate_once_prompt_outcome", error))?;
    begin_immediate(&mut connection, "record_delegate_once_prompt_outcome").await?;

    let result = async {
        let receipt = receipt_for_dispatch(&mut connection, &request.dispatch_id).await?;
        validate_prompt_fence(
            &receipt,
            &request.task_id,
            request.generation,
            &request.delivery_idempotency_key,
            &request.session,
            false,
        )?;
        let prompt = receipt
            .prompt_delivery
            .as_ref()
            .ok_or_else(|| corrupt_link("active Dispatch has no prompt delivery receipt"))?;

        let (target_state, evidence_json, error_code) = match &request.outcome {
            WorkflowPromptDeliveryOutcomeV1::WrittenToPty(evidence) => (
                WorkflowPromptDeliveryStateV1::WrittenToPty,
                Some(serde_json::to_string(evidence).map_err(|error| {
                    storage(
                        "prompt_delivery_serialization",
                        format!("could not serialize prompt delivery evidence: {error}"),
                    )
                })?),
                None,
            ),
            WorkflowPromptDeliveryOutcomeV1::Failed { error_code } => (
                WorkflowPromptDeliveryStateV1::Failed,
                None,
                Some(error_code.clone()),
            ),
        };

        if prompt.state == WorkflowPromptDeliveryStateV1::Uncertain {
            validate_prompt_transition_time(&receipt, request.recorded_at_ms)?;
            let state = match target_state {
                WorkflowPromptDeliveryStateV1::WrittenToPty => "written_to_pty",
                WorkflowPromptDeliveryStateV1::Failed => "failed",
                _ => unreachable!("prompt outcomes are terminal"),
            };
            let updated = sqlx::query(
                r#"
                UPDATE workflow_dispatch_launches
                SET
                    prompt_delivery_state = ?1,
                    prompt_delivery_evidence_json = ?2,
                    prompt_delivery_error_code = ?3,
                    updated_at_ms = ?4
                WHERE dispatch_id = ?5 AND prompt_delivery_state = 'uncertain'
                "#,
            )
            .bind(state)
            .bind(&evidence_json)
            .bind(&error_code)
            .bind(request.recorded_at_ms)
            .bind(request.dispatch_id.as_str())
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("record_delegate_once_prompt_outcome", error))?;
            if updated.rows_affected() != 1 {
                return Err(corrupt_link(
                    "prompt delivery changed while recording its outcome",
                ));
            }
        } else if prompt.state != target_state
            || !prompt_outcome_matches_evidence(prompt, &request.outcome)
            || prompt.error_code.as_ref() != error_code.as_ref()
        {
            return Err(DomainStoreErrorV1::IdentityConflict {
                entity: "workflow_prompt_delivery",
                id: request.dispatch_id.to_string(),
                reason: "prompt delivery already records a different or unclaimed outcome".into(),
            });
        }

        receipt_for_dispatch(&mut connection, &request.dispatch_id).await
    }
    .await;

    finish_transaction(
        &mut connection,
        "record_delegate_once_prompt_outcome",
        result,
    )
    .await
}

fn prompt_outcome_matches_evidence(
    prompt: &WorkflowPromptDeliveryReceiptV1,
    outcome: &WorkflowPromptDeliveryOutcomeV1,
) -> bool {
    match outcome {
        WorkflowPromptDeliveryOutcomeV1::WrittenToPty(expected) => {
            let Some(mut stored) = prompt.evidence.clone() else {
                return false;
            };
            stored.clear_activity();
            &stored == expected
        }
        WorkflowPromptDeliveryOutcomeV1::Failed { .. } => prompt.evidence.is_none(),
    }
}

pub(crate) async fn record_prompt_activity(
    pool: &SqlitePool,
    request: &DelegateOncePromptActivityRequestV1,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("record_delegate_once_prompt_activity", error))?;
    begin_immediate(&mut connection, "record_delegate_once_prompt_activity").await?;

    let result = async {
        let receipt = receipt_for_dispatch(&mut connection, &request.dispatch_id).await?;
        validate_prompt_fence(
            &receipt,
            &request.task_id,
            request.generation,
            &request.delivery_idempotency_key,
            &request.session,
            true,
        )?;
        let prompt = receipt
            .prompt_delivery
            .as_ref()
            .ok_or_else(|| corrupt_link("active Dispatch has no prompt delivery receipt"))?;
        if prompt.state != WorkflowPromptDeliveryStateV1::WrittenToPty {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "promptDelivery.state",
                reason: "activity requires a written_to_pty delivery receipt".into(),
            });
        }
        let mut evidence = prompt
            .evidence
            .clone()
            .ok_or_else(|| corrupt_link("written prompt has no delivery evidence"))?;
        let replace = match evidence.activity() {
            None => true,
            Some(current)
                if current.state != WorkflowPromptActivityStateV1::Observed
                    && request.activity.state == WorkflowPromptActivityStateV1::Observed =>
            {
                true
            }
            Some(_) => false,
        };
        if !replace {
            return Ok(receipt);
        }

        validate_prompt_transition_time(&receipt, request.observed_at_ms)?;
        evidence.set_activity(request.activity.clone());
        evidence.validate()?;
        let evidence_json = serde_json::to_string(&evidence).map_err(|error| {
            storage(
                "prompt_activity_serialization",
                format!("could not serialize prompt activity evidence: {error}"),
            )
        })?;
        let updated = sqlx::query(
            r#"
            UPDATE workflow_dispatch_launches
            SET prompt_delivery_evidence_json = ?1, updated_at_ms = ?2
            WHERE dispatch_id = ?3 AND prompt_delivery_state = 'written_to_pty'
            "#,
        )
        .bind(evidence_json)
        .bind(request.observed_at_ms)
        .bind(request.dispatch_id.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("record_delegate_once_prompt_activity", error))?;
        if updated.rows_affected() != 1 {
            return Err(corrupt_link(
                "prompt delivery changed while recording activity evidence",
            ));
        }
        receipt_for_dispatch(&mut connection, &request.dispatch_id).await
    }
    .await;

    finish_transaction(
        &mut connection,
        "record_delegate_once_prompt_activity",
        result,
    )
    .await
}

fn validate_prompt_fence(
    receipt: &DelegateOnceReceiptV1,
    task_id: &TaskIdV1,
    generation: i64,
    delivery_idempotency_key: &str,
    session: &WorkflowSessionGenerationV1,
    allow_completed: bool,
) -> Result<(), DomainStoreErrorV1> {
    if (receipt.status != WorkflowDispatchStateV1::Active
        && !(allow_completed && receipt.status == WorkflowDispatchStateV1::Completed))
        || &receipt.task_id != task_id
        || receipt.generation != generation
        || receipt.session.as_ref() != Some(session)
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_prompt_delivery_fence",
            id: receipt.dispatch_id.to_string(),
            reason: "task, Dispatch generation, and exact Session generation must remain eligible"
                .into(),
        });
    }
    let prompt = receipt
        .prompt_delivery
        .as_ref()
        .ok_or_else(|| corrupt_link("active Dispatch has no prompt delivery receipt"))?;
    if prompt.idempotency_key != delivery_idempotency_key {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_prompt_delivery",
            id: receipt.dispatch_id.to_string(),
            reason: "prompt delivery idempotency key does not match the Dispatch".into(),
        });
    }
    Ok(())
}

fn validate_prompt_transition_time(
    receipt: &DelegateOnceReceiptV1,
    transition_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    if transition_at_ms < receipt.updated_at_ms {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "promptDelivery.transitionAtMs",
            reason: "must not precede the current Dispatch receipt".into(),
        });
    }
    Ok(())
}

pub(crate) async fn receipt(
    pool: &SqlitePool,
    idempotency_key: &str,
) -> Result<Option<DelegateOnceReceiptV1>, DomainStoreErrorV1> {
    validate_idempotency_key(idempotency_key)?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_delegate_once_receipt", error))?;
    receipt_on(&mut connection, idempotency_key).await
}

pub(crate) async fn receipt_for_exact_dispatch(
    pool: &SqlitePool,
    task_id: &TaskIdV1,
    dispatch_id: &DispatchIdV1,
    generation: i64,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    if generation < 1 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "generation",
            reason: "must be positive".into(),
        });
    }
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_delegate_once_receipt_for_dispatch", error))?;
    let receipt = receipt_for_dispatch(&mut connection, dispatch_id).await?;
    if receipt.task_id != *task_id || receipt.generation != generation {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_dispatch_fence",
            id: dispatch_id.to_string(),
            reason: "taskId, dispatchId, and generation must match the current Dispatch".into(),
        });
    }
    Ok(receipt)
}

async fn request_digest_on(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<String>, DomainStoreErrorV1> {
    let digest: Option<String> = sqlx::query_scalar(
        "SELECT request_digest FROM workflow_delegate_once_receipts WHERE idempotency_key = ?1",
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_delegate_once_digest", error))?;
    if digest.as_deref().is_some_and(|value| {
        value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    }) {
        return Err(corrupt_link("delegate_once request digest is invalid"));
    }
    Ok(digest)
}

async fn validate_launch_transition(
    connection: &mut SqliteConnection,
    task_id: &TaskIdV1,
    dispatch_id: &DispatchIdV1,
    generation: i64,
    launch_idempotency_key: &str,
    transition_at_ms: i64,
) -> Result<String, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            dispatch.task_id,
            dispatch.generation,
            dispatch.state AS dispatch_state,
            dispatch.created_at_ms,
            launch.dispatch_id AS linked_launch_id,
            launch.launch_idempotency_key,
            launch.effective_launch_idempotency_key,
            launch.state AS launch_state
        FROM workflow_dispatches AS dispatch
        LEFT JOIN workflow_dispatch_launches AS launch
            ON launch.dispatch_id = dispatch.dispatch_id
        WHERE dispatch.dispatch_id = ?1
        "#,
    )
    .bind(dispatch_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("validate_delegate_once_launch", error))?
    .ok_or_else(|| DomainStoreErrorV1::NotFound {
        entity: "workflow_dispatch",
        id: dispatch_id.to_string(),
    })?;
    let stored_task_id: String = row
        .try_get("task_id")
        .map_err(|error| corrupt_row("workflow_dispatches", error))?;
    let stored_generation: i64 = row
        .try_get("generation")
        .map_err(|error| corrupt_row("workflow_dispatches", error))?;
    if stored_task_id != task_id.as_str() || stored_generation != generation {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_dispatch_fence",
            id: dispatch_id.to_string(),
            reason: "taskId, dispatchId, and generation must match the current Dispatch".into(),
        });
    }
    let dispatch_state: String = row
        .try_get("dispatch_state")
        .map_err(|error| corrupt_row("workflow_dispatches", error))?;
    if !matches!(dispatch_state.as_str(), "starting" | "completed") {
        return Err(corrupt_link("Dispatch has an unsupported state"));
    }
    let created_at_ms: i64 = row
        .try_get("created_at_ms")
        .map_err(|error| corrupt_row("workflow_dispatches", error))?;
    if transition_at_ms < created_at_ms {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "transitionAtMs",
            reason: "must not precede the Dispatch".into(),
        });
    }
    let linked_launch_id: Option<String> = row
        .try_get("linked_launch_id")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    let stored_launch_key: Option<String> = row
        .try_get("launch_idempotency_key")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    if linked_launch_id.as_deref() != Some(dispatch_id.as_str())
        || stored_launch_key.as_deref().is_none()
    {
        return Err(corrupt_link("Dispatch has no launch receipt"));
    }
    if stored_launch_key.as_deref() != Some(launch_idempotency_key) {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_launch_key",
            id: dispatch_id.to_string(),
            reason: "launch idempotency key does not match the durable Dispatch".into(),
        });
    }
    row.try_get("launch_state")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))
}

async fn receipt_for_dispatch(
    connection: &mut SqliteConnection,
    dispatch_id: &DispatchIdV1,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    let idempotency_key = sqlx::query_scalar::<_, String>(
        "SELECT idempotency_key FROM workflow_delegate_once_receipts WHERE dispatch_id = ?1",
    )
    .bind(dispatch_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_delegate_once_receipt_for_dispatch", error))?
    .ok_or_else(|| DomainStoreErrorV1::NotFound {
        entity: "workflow_dispatch",
        id: dispatch_id.to_string(),
    })?;
    receipt_on(connection, &idempotency_key)
        .await?
        .ok_or_else(|| corrupt_link("delegate_once receipt disappeared during transition"))
}

async fn receipt_on(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<DelegateOnceReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            receipt.idempotency_key,
            receipt.run_id,
            receipt.task_id,
            receipt.dispatch_id,
            run.run_id AS linked_run_id,
            task.task_id AS linked_task_id,
            task.run_id AS task_run_id,
            task.state AS task_state,
            dispatch.dispatch_id AS linked_dispatch_id,
            dispatch.task_id AS dispatch_task_id,
            dispatch.provider_id AS dispatch_provider_id,
            dispatch.generation,
            dispatch.state AS dispatch_state,
            dispatch.completion_result,
            launch.dispatch_id AS linked_launch_id,
            launch.launch_idempotency_key,
            launch.effective_launch_idempotency_key,
            launch.state AS launch_state,
            launch.session_id,
            launch.workspace_id,
            launch.provider_id AS launch_provider_id,
            launch.runner_principal,
            launch.runner_instance,
            launch.channel_epoch,
            launch.host_instance_id,
            launch.terminal_epoch,
            launch.start_error_code,
            launch.prompt_delivery_idempotency_key,
            launch.prompt_delivery_state,
            launch.prompt_delivery_evidence_json,
            launch.prompt_delivery_error_code,
            run.created_at_ms,
            dispatch.updated_at_ms AS dispatch_updated_at_ms,
            launch.updated_at_ms AS launch_updated_at_ms
        FROM workflow_delegate_once_receipts AS receipt
        LEFT JOIN workflow_runs AS run ON run.run_id = receipt.run_id
        LEFT JOIN workflow_tasks AS task ON task.task_id = receipt.task_id
        LEFT JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = receipt.dispatch_id
        LEFT JOIN workflow_dispatch_launches AS launch ON launch.dispatch_id = receipt.dispatch_id
        WHERE receipt.idempotency_key = ?1
        "#,
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_delegate_once_receipt", error))?;
    row.map(receipt_from_row).transpose()
}

fn receipt_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<DelegateOnceReceiptV1, DomainStoreErrorV1> {
    let run_id = stored_id::<RunIdV1>(&row, "run_id", RunIdV1::new)?;
    let task_id = stored_id::<TaskIdV1>(&row, "task_id", TaskIdV1::new)?;
    let dispatch_id = stored_id::<DispatchIdV1>(&row, "dispatch_id", DispatchIdV1::new)?;
    let linked_run: Option<String> = row
        .try_get("linked_run_id")
        .map_err(|error| corrupt_row("workflow_delegate_once_receipts", error))?;
    let linked_task: Option<String> = row
        .try_get("linked_task_id")
        .map_err(|error| corrupt_row("workflow_delegate_once_receipts", error))?;
    let task_run: Option<String> = row
        .try_get("task_run_id")
        .map_err(|error| corrupt_row("workflow_delegate_once_receipts", error))?;
    let linked_dispatch: Option<String> = row
        .try_get("linked_dispatch_id")
        .map_err(|error| corrupt_row("workflow_delegate_once_receipts", error))?;
    let dispatch_task: Option<String> = row
        .try_get("dispatch_task_id")
        .map_err(|error| corrupt_row("workflow_delegate_once_receipts", error))?;
    if linked_run.as_deref() != Some(run_id.as_str())
        || linked_task.as_deref() != Some(task_id.as_str())
        || task_run.as_deref() != Some(run_id.as_str())
        || linked_dispatch.as_deref() != Some(dispatch_id.as_str())
        || dispatch_task.as_deref() != Some(task_id.as_str())
    {
        return Err(corrupt_link(
            "delegate_once receipt references missing or mismatched records",
        ));
    }
    let linked_launch: Option<String> = row
        .try_get("linked_launch_id")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    if linked_launch.as_deref() != Some(dispatch_id.as_str()) {
        return Err(corrupt_link("delegate_once receipt has no launch receipt"));
    }
    let dispatch_state: String = row
        .try_get("dispatch_state")
        .map_err(|error| corrupt_row("workflow_dispatches", error))?;
    let launch_state: Option<String> = row
        .try_get("launch_state")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    let task_state: Option<String> = row
        .try_get("task_state")
        .map_err(|error| corrupt_row("workflow_tasks", error))?;
    let status = match (
        dispatch_state.as_str(),
        task_state.as_deref(),
        launch_state.as_deref(),
    ) {
        ("starting", Some("dispatched"), Some("starting")) => WorkflowDispatchStateV1::Starting,
        ("starting", Some("dispatched"), Some("active")) => WorkflowDispatchStateV1::Active,
        ("starting", Some("dispatched"), Some("start_failed")) => {
            WorkflowDispatchStateV1::StartFailed
        }
        ("completed", Some("completed"), Some("active")) => WorkflowDispatchStateV1::Completed,
        ("completed", Some("completed"), Some("start_failed")) => {
            WorkflowDispatchStateV1::StartFailed
        }
        ("starting" | "completed", _, Some("starting" | "active" | "start_failed")) => {
            return Err(corrupt_link(
                "Task, Dispatch, and launch states do not agree",
            ));
        }
        _ => return Err(corrupt_link("Dispatch launch has an unsupported state")),
    };
    let launch_idempotency_key: String = row
        .try_get("launch_idempotency_key")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    let effective_launch_idempotency_key: Option<String> = row
        .try_get("effective_launch_idempotency_key")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    let session = match status {
        WorkflowDispatchStateV1::Active | WorkflowDispatchStateV1::Completed => {
            let provider_id = required_launch_value(&row, "launch_provider_id")?;
            let dispatch_provider_id: String = row
                .try_get("dispatch_provider_id")
                .map_err(|error| corrupt_row("workflow_dispatches", error))?;
            if provider_id != dispatch_provider_id {
                return Err(corrupt_link("Session provider does not match the Dispatch"));
            }
            Some(WorkflowSessionGenerationV1 {
                session_id: required_launch_value(&row, "session_id")?,
                workspace_id: required_launch_value(&row, "workspace_id")?,
                provider_id: ProviderIdV1::new(provider_id)
                    .map_err(|error| corrupt_identifier("provider_id", error))?,
                runner_principal: required_launch_value(&row, "runner_principal")?,
                runner_instance: required_launch_value(&row, "runner_instance")?,
                channel_epoch: required_launch_value(&row, "channel_epoch")?,
                host_instance_id: required_launch_value(&row, "host_instance_id")?,
                terminal_epoch: required_launch_value(&row, "terminal_epoch")?,
            })
        }
        WorkflowDispatchStateV1::Starting | WorkflowDispatchStateV1::StartFailed => {
            ensure_session_identity_absent(&row)?;
            None
        }
    };
    let start_error_code: Option<String> = row
        .try_get("start_error_code")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    let prompt_delivery = match status {
        WorkflowDispatchStateV1::Active | WorkflowDispatchStateV1::Completed => {
            Some(prompt_delivery_from_row(&row)?)
        }
        WorkflowDispatchStateV1::Starting | WorkflowDispatchStateV1::StartFailed => None,
    };
    let dispatch_updated_at_ms: i64 = row
        .try_get("dispatch_updated_at_ms")
        .map_err(|error| corrupt_row("workflow_dispatches", error))?;
    let launch_updated_at_ms: i64 = row
        .try_get("launch_updated_at_ms")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    let receipt = DelegateOnceReceiptV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        idempotency_key: row
            .try_get("idempotency_key")
            .map_err(|error| corrupt_row("workflow_delegate_once_receipts", error))?,
        run_id,
        task_id,
        dispatch_id,
        generation: row
            .try_get("generation")
            .map_err(|error| corrupt_row("workflow_dispatches", error))?,
        status,
        launch_idempotency_key,
        effective_launch_idempotency_key,
        session,
        start_error_code,
        prompt_delivery,
        result: row
            .try_get("completion_result")
            .map_err(|error| corrupt_row("workflow_dispatches", error))?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|error| corrupt_row("workflow_runs", error))?,
        updated_at_ms: dispatch_updated_at_ms.max(launch_updated_at_ms),
    };
    receipt.validate()?;
    Ok(receipt)
}

fn required_launch_value(
    row: &sqlx::sqlite::SqliteRow,
    field: &'static str,
) -> Result<String, DomainStoreErrorV1> {
    row.try_get::<Option<String>, _>(field)
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?
        .ok_or_else(|| corrupt_link("active Dispatch launch is missing Session identity"))
}

fn prompt_delivery_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<WorkflowPromptDeliveryReceiptV1, DomainStoreErrorV1> {
    let idempotency_key = required_launch_value(row, "prompt_delivery_idempotency_key")?;
    let state: String = required_launch_value(row, "prompt_delivery_state")?;
    let state = match state.as_str() {
        "pending" => WorkflowPromptDeliveryStateV1::Pending,
        "uncertain" => WorkflowPromptDeliveryStateV1::Uncertain,
        "written_to_pty" => WorkflowPromptDeliveryStateV1::WrittenToPty,
        "failed" => WorkflowPromptDeliveryStateV1::Failed,
        _ => return Err(corrupt_link("prompt delivery has an unsupported state")),
    };
    let evidence_json: Option<String> = row
        .try_get("prompt_delivery_evidence_json")
        .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?;
    let evidence = evidence_json
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                storage(
                    "corrupt_workflow_prompt_evidence",
                    format!("prompt delivery evidence is invalid: {error}"),
                )
            })
        })
        .transpose()?;
    let receipt = WorkflowPromptDeliveryReceiptV1 {
        idempotency_key,
        state,
        evidence,
        error_code: row
            .try_get("prompt_delivery_error_code")
            .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?,
    };
    receipt.validate()?;
    Ok(receipt)
}

fn ensure_session_identity_absent(row: &sqlx::sqlite::SqliteRow) -> Result<(), DomainStoreErrorV1> {
    for field in [
        "effective_launch_idempotency_key",
        "session_id",
        "workspace_id",
        "launch_provider_id",
        "runner_principal",
        "runner_instance",
        "channel_epoch",
        "host_instance_id",
        "terminal_epoch",
        "prompt_delivery_idempotency_key",
        "prompt_delivery_state",
        "prompt_delivery_evidence_json",
        "prompt_delivery_error_code",
    ] {
        if row
            .try_get::<Option<String>, _>(field)
            .map_err(|error| corrupt_row("workflow_dispatch_launches", error))?
            .is_some()
        {
            return Err(corrupt_link(
                "inactive Dispatch launch contains Session identity",
            ));
        }
    }
    Ok(())
}

fn stored_id<T>(
    row: &sqlx::sqlite::SqliteRow,
    field: &'static str,
    parse: impl FnOnce(String) -> Result<T, dure_app::DomainIdErrorV1>,
) -> Result<T, DomainStoreErrorV1> {
    let value = row
        .try_get::<String, _>(field)
        .map_err(|error| corrupt_row("workflow_delegate_once_receipts", error))?;
    parse(value).map_err(|error| corrupt_identifier(field, error))
}

fn validate_idempotency_key(value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.is_empty()
        || value.len() > 160
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-' | b'/')
        })
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "idempotencyKey",
            reason: "must be a bounded non-secret identifier token".into(),
        });
    }
    Ok(())
}

fn corrupt_link(detail: &'static str) -> DomainStoreErrorV1 {
    storage("corrupt_workflow_link", detail)
}
