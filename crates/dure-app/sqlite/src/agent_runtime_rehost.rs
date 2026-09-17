use dure_app::{
    AgentCheckpointBindingAuthorityV1, AgentIdV1, AgentInteractionProfileV1,
    AgentRuntimeNativeRehostCommitReceiptV1, AgentRuntimeNativeRehostCommitV1,
    AgentRuntimeNativeRehostReceiptV1, AgentRuntimeSelectionV1, DomainStoreErrorV1, OperationIdV1,
    WorkflowSessionGenerationV1,
};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::agent_runtime_close::ensure_runtime_successor_source_on;
use crate::agent_runtime_transition::{
    active_transition_on, initialize_selection_on, selection_on, supersede_for_native_rehost_on,
    update_selection,
};
use crate::checkpoint_bindings::{authority_on, replace_exact_on, upsert_on};
use crate::error::{identity_conflict, map_sqlx, storage};
use crate::orchestration::{
    self, OrchestrationDispatchSessionRebindMutationV1, OrchestrationDispatchSessionRebindRequestV1,
};
use crate::schema::{begin_immediate, finish_transaction};

fn dispatch_rebind_request(
    request: &AgentRuntimeNativeRehostCommitV1,
    target_selection: &AgentRuntimeSelectionV1,
) -> Result<OrchestrationDispatchSessionRebindMutationV1, DomainStoreErrorV1> {
    OrchestrationDispatchSessionRebindMutationV1::try_new(
        agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
        request.operation_id.as_str().to_owned(),
        WorkflowSessionGenerationV1::from_checkpoint_authority(
            &request.source_authority,
            &request.source_selection.provider_id,
        ),
        WorkflowSessionGenerationV1::from_checkpoint_authority(
            &request.target_authority,
            &target_selection.provider_id,
        ),
        Some(request.target_launch_idempotency_key.as_str().to_owned()),
        request.committed_at_ms,
    )
}

pub(crate) async fn commit_initial_native_adoption(
    pool: &SqlitePool,
    source_authority: Option<&AgentCheckpointBindingAuthorityV1>,
    target_authority: &AgentCheckpointBindingAuthorityV1,
    target_selection: &AgentRuntimeSelectionV1,
    dispatch_rebind: Option<&OrchestrationDispatchSessionRebindRequestV1>,
    target_launch_idempotency_key: &str,
    checkout: Option<&dure_app::SessionCheckoutBindingV1>,
) -> Result<AgentRuntimeSelectionV1, DomainStoreErrorV1> {
    target_authority.validate()?;
    target_selection.validate()?;
    if target_selection.interaction_profile != AgentInteractionProfileV1::NativeCli
        || target_selection.revision != 1
        || target_selection.selected_by_operation_id.is_some()
        || target_selection.agent_id != target_authority.binding.agent_id
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "runtimeSelection",
            reason: "initial native adoption requires the exact revision-one target authority"
                .into(),
        });
    }
    let target_generation = WorkflowSessionGenerationV1::from_checkpoint_authority(
        target_authority,
        &target_selection.provider_id,
    );
    let source_generation = source_authority
        .map(|authority| {
            authority.validate()?;
            if authority.binding.agent_id != target_authority.binding.agent_id {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "sourceAuthority",
                    reason: "source and target must belong to the same Agent".into(),
                });
            }
            Ok(WorkflowSessionGenerationV1::from_checkpoint_authority(
                authority,
                &target_selection.provider_id,
            ))
        })
        .transpose()?;
    let dispatch_rebind = match (source_generation.as_ref(), dispatch_rebind) {
        (Some(source), Some(request)) if source != &target_generation => {
            if request.source != *source || request.target != target_generation {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "dispatchRebind",
                    reason: "Dispatch rebind must match the exact source and target authorities"
                        .into(),
                });
            }
            Some(OrchestrationDispatchSessionRebindMutationV1::try_new(
                request.schema_version,
                request.operation_id.clone(),
                request.source.clone(),
                request.target.clone(),
                Some(target_launch_idempotency_key.to_owned()),
                request.rebound_at_ms,
            )?)
        }
        (Some(source), None) if source == &target_generation => None,
        (None, None) => None,
        _ => {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "dispatchRebind",
                reason: "only an exact Session generation change may carry a Dispatch rebind"
                    .into(),
            });
        }
    };
    let agent_id = &target_selection.agent_id;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("commit_initial_agent_runtime_native_adoption", error))?;
    begin_immediate(
        &mut connection,
        "commit_initial_agent_runtime_native_adoption",
    )
    .await?;
    let result = async {
        let current_authority = authority_on(&mut connection, agent_id).await?;
        let current_selection = selection_on(&mut connection, agent_id).await?;
        if current_authority.as_ref() == Some(target_authority)
            && current_selection.as_ref() == Some(target_selection)
        {
            if let Some(dispatch_rebind) = &dispatch_rebind {
                orchestration::rebind_dispatch_session_on(&mut connection, dispatch_rebind).await?;
            }
            return Ok(target_selection.clone());
        }
        if current_selection.is_some() || current_authority.as_ref() != source_authority {
            return Err(identity_conflict(
                "agent runtime native adoption",
                agent_id.as_str(),
                "source runtime authority changed before commit",
            ));
        }
        if let Some(dispatch_rebind) = &dispatch_rebind {
            orchestration::rebind_dispatch_session_on(&mut connection, dispatch_rebind).await?;
        }
        upsert_on(&mut connection, target_authority).await?;
        let selected = initialize_selection_on(&mut connection, target_selection).await?;
        if let Some(checkout) = checkout {
            crate::agent_runtime_checkout::adopt_on(&mut connection, agent_id, checkout).await?;
        }
        Ok(selected)
    }
    .await;
    finish_transaction(
        &mut connection,
        "commit_initial_agent_runtime_native_adoption",
        result,
    )
    .await
}

pub(crate) async fn commit(
    pool: &SqlitePool,
    request: &AgentRuntimeNativeRehostCommitV1,
) -> Result<AgentRuntimeNativeRehostCommitReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let target_selection = request.target_selection()?;
    let dispatch_rebind = dispatch_rebind_request(request, &target_selection)?;
    let target_receipt = AgentRuntimeNativeRehostReceiptV1 {
        schema_version: request.schema_version,
        operation_id: request.operation_id.clone(),
        agent_id: target_selection.agent_id.clone(),
        selection_revision: target_selection.revision,
        source: request.request_source.clone(),
        session_id: request.target_authority.binding.session_id.clone(),
        workspace_id: request.target_authority.runtime_workspace_id.clone(),
        launch_idempotency_key: request.target_launch_idempotency_key.clone(),
        provider_launch_reference: request.target_provider_launch_reference.clone(),
        committed_at_ms: request.committed_at_ms,
    };
    target_receipt.validate_for(&target_selection, &request.target_authority)?;
    let agent_id = &request.source_selection.agent_id;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("commit_agent_runtime_native_rehost", error))?;
    begin_immediate(&mut connection, "commit_agent_runtime_native_rehost").await?;
    let result = async {
        ensure_runtime_successor_source_on(
            &mut connection,
            &request.source_selection,
            &dure_app::AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: request.source_authority.clone(),
            },
            &request.operation_id,
            request.committed_at_ms,
        )
        .await?;
        match (
            active_transition_on(&mut connection, agent_id).await?,
            request.repair_transition.as_ref(),
        ) {
            (None, None) => {}
            (Some(active), Some(_)) => {
                supersede_for_native_rehost_on(&mut connection, &active, request).await?;
            }
            _ => {
                return Err(identity_conflict(
                    "agent runtime transition",
                    agent_id.as_str(),
                    "native rehost repair fence did not match active runtime state",
                ));
            }
        }
        if selection_on(&mut connection, agent_id).await?.as_ref()
            != Some(&request.source_selection)
        {
            return Err(identity_conflict(
                "agent runtime selection",
                agent_id.as_str(),
                "native rehost source selection changed before commit",
            ));
        }
        if authority_on(&mut connection, agent_id).await?.as_ref()
            != Some(&request.source_authority)
        {
            return Err(identity_conflict(
                "agent checkpoint binding authority",
                agent_id.as_str(),
                "native rehost source authority changed before commit",
            ));
        }
        // Dispatch enrollment is optional client projection, but authoritative
        // backend state. Discover and transfer it under the same exact source
        // and target transaction as the Agent runtime commit. An unassigned
        // source is a no-op; any store failure rolls the whole commit back so
        // replay can converge without a second frontend writer.
        orchestration::rebind_dispatch_session_on(&mut connection, &dispatch_rebind).await?;
        update_selection(
            &mut connection,
            &request.source_selection,
            &target_selection,
        )
        .await?;
        replace_exact_on(
            &mut connection,
            &request.source_authority,
            &request.target_authority,
        )
        .await?;
        upsert_receipt_on(&mut connection, &target_receipt).await?;
        Ok(AgentRuntimeNativeRehostCommitReceiptV1 {
            selection: target_selection,
            authority: request.target_authority.clone(),
            receipt: target_receipt,
        })
    }
    .await;
    finish_transaction(
        &mut connection,
        "commit_agent_runtime_native_rehost",
        result,
    )
    .await
}

async fn upsert_receipt_on(
    connection: &mut SqliteConnection,
    receipt: &AgentRuntimeNativeRehostReceiptV1,
) -> Result<(), DomainStoreErrorV1> {
    sqlx::query(
        r#"
        INSERT INTO agent_runtime_native_rehost_receipts (
            agent_id,
            schema_version,
            operation_id,
            selection_revision,
            source_session_id,
            source_workspace_id,
            source_runner_principal,
            source_runner_instance,
            source_channel_epoch,
            source_host_instance_id,
            source_terminal_epoch,
            session_id,
            workspace_id,
            launch_idempotency_key,
            provider_launch_reference,
            committed_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        ON CONFLICT(agent_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            operation_id = excluded.operation_id,
            selection_revision = excluded.selection_revision,
            source_session_id = excluded.source_session_id,
            source_workspace_id = excluded.source_workspace_id,
            source_runner_principal = excluded.source_runner_principal,
            source_runner_instance = excluded.source_runner_instance,
            source_channel_epoch = excluded.source_channel_epoch,
            source_host_instance_id = excluded.source_host_instance_id,
            source_terminal_epoch = excluded.source_terminal_epoch,
            session_id = excluded.session_id,
            workspace_id = excluded.workspace_id,
            launch_idempotency_key = excluded.launch_idempotency_key,
            provider_launch_reference = excluded.provider_launch_reference,
            committed_at_ms = excluded.committed_at_ms
        "#,
    )
    .bind(receipt.agent_id.as_str())
    .bind(i64::from(receipt.schema_version))
    .bind(receipt.operation_id.as_str())
    .bind(receipt.selection_revision)
    .bind(&receipt.source.session_id)
    .bind(&receipt.source.workspace_id)
    .bind(&receipt.source.runner_principal)
    .bind(&receipt.source.runner_instance)
    .bind(&receipt.source.channel_epoch)
    .bind(&receipt.source.host_instance_id)
    .bind(&receipt.source.terminal_epoch)
    .bind(&receipt.session_id)
    .bind(&receipt.workspace_id)
    .bind(receipt.launch_idempotency_key.as_str())
    .bind(
        receipt
            .provider_launch_reference
            .as_ref()
            .map(dure_app::ProviderLaunchReferenceV1::as_str),
    )
    .bind(receipt.committed_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("write_agent_runtime_native_rehost_receipt", error))?;
    Ok(())
}

pub(crate) async fn receipt(
    pool: &SqlitePool,
    agent_id: &AgentIdV1,
) -> Result<Option<AgentRuntimeNativeRehostReceiptV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            agent_id,
            schema_version,
            operation_id,
            selection_revision,
            source_session_id,
            source_workspace_id,
            source_runner_principal,
            source_runner_instance,
            source_channel_epoch,
            source_host_instance_id,
            source_terminal_epoch,
            session_id,
            workspace_id,
            launch_idempotency_key,
            provider_launch_reference,
            committed_at_ms
        FROM agent_runtime_native_rehost_receipts
        WHERE agent_id = ?1
        "#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?;
    row.map(|row| {
        let stored_agent_id: String = row
            .try_get("agent_id")
            .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?;
        let schema_version: i64 = row
            .try_get("schema_version")
            .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?;
        let operation_id: String = row
            .try_get("operation_id")
            .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?;
        let launch_idempotency_key: String = row
            .try_get("launch_idempotency_key")
            .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?;
        let provider_launch_reference: Option<String> = row
            .try_get("provider_launch_reference")
            .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?;
        Ok(AgentRuntimeNativeRehostReceiptV1 {
            schema_version: u16::try_from(schema_version).map_err(|_| {
                storage(
                    "corrupt_agent_runtime_native_rehost_receipt",
                    "schema version is out of range",
                )
            })?,
            operation_id: OperationIdV1::new(operation_id).map_err(|error| {
                storage(
                    "corrupt_agent_runtime_native_rehost_receipt",
                    error.to_string(),
                )
            })?,
            agent_id: AgentIdV1::new(stored_agent_id).map_err(|error| {
                storage(
                    "corrupt_agent_runtime_native_rehost_receipt",
                    error.to_string(),
                )
            })?,
            selection_revision: row
                .try_get("selection_revision")
                .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
            source: dure_app::AgentRuntimeNativeRehostSourceV1 {
                session_id: row
                    .try_get("source_session_id")
                    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
                workspace_id: row
                    .try_get("source_workspace_id")
                    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
                runner_principal: row
                    .try_get("source_runner_principal")
                    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
                runner_instance: row
                    .try_get("source_runner_instance")
                    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
                channel_epoch: row
                    .try_get("source_channel_epoch")
                    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
                host_instance_id: row
                    .try_get("source_host_instance_id")
                    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
                terminal_epoch: row
                    .try_get("source_terminal_epoch")
                    .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
            },
            session_id: row
                .try_get("session_id")
                .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
            workspace_id: row
                .try_get("workspace_id")
                .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
            launch_idempotency_key: OperationIdV1::new(launch_idempotency_key).map_err(
                |error| {
                    storage(
                        "corrupt_agent_runtime_native_rehost_receipt",
                        error.to_string(),
                    )
                },
            )?,
            provider_launch_reference: provider_launch_reference
                .map(dure_app::ProviderLaunchReferenceV1::new)
                .transpose()?,
            committed_at_ms: row
                .try_get("committed_at_ms")
                .map_err(|error| map_sqlx("read_agent_runtime_native_rehost_receipt", error))?,
        })
    })
    .transpose()
}
