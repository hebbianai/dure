use std::collections::BTreeSet;

use dure_app::{
    AgentIdV1, AgentInteractionProfileV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1, DomainStoreErrorV1,
    RuntimeKindIdV1, WorkflowSessionGenerationV1,
};
use sqlx::{SqliteConnection, SqlitePool};

use crate::agent_runtime_transition::{
    runtime_generation_authority_converges_from, selection_on, transition_on,
};
use crate::checkpoint_bindings::authority_for_exact_session_on;
use crate::error::{identity_conflict, map_sqlx};
use crate::orchestration::{
    OrchestrationDispatchGenerationV1, OrchestrationDispatchSessionRebindMutationV1,
    OrchestrationDispatchSessionRebindReceiptV1, rebind_dispatch_session_on,
    reconcile_dispatch_session_on, reporting_runtime_authority_for_exact_dispatch_on,
};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn rebind_committed_transition_on(
    connection: &mut SqliteConnection,
    record: &AgentRuntimeTransitionRecordV1,
) -> Result<(), DomainStoreErrorV1> {
    let Some(request) =
        OrchestrationDispatchSessionRebindMutationV1::from_committed_native_runtime_transition(
            record,
            record.updated_at_ms,
        )?
    else {
        return Ok(());
    };
    rebind_dispatch_session_on(connection, &request).await?;
    Ok(())
}

pub(crate) async fn reconcile_committed_transition_chain(
    pool: &SqlitePool,
    expected_agent_id: &AgentIdV1,
    exact: &OrchestrationDispatchGenerationV1,
    source: &WorkflowSessionGenerationV1,
    target: &WorkflowSessionGenerationV1,
    reconciled_at_ms: i64,
) -> Result<Option<OrchestrationDispatchSessionRebindReceiptV1>, DomainStoreErrorV1> {
    source.validate()?;
    target.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("reconcile_runtime_transition_dispatch", error))?;
    begin_immediate(&mut connection, "reconcile_runtime_transition_dispatch").await?;
    let result = reconcile_committed_transition_chain_on(
        &mut connection,
        expected_agent_id,
        exact,
        source,
        target,
        reconciled_at_ms,
    )
    .await;
    finish_transaction(
        &mut connection,
        "reconcile_runtime_transition_dispatch",
        result,
    )
    .await
}

async fn reconcile_committed_transition_chain_on(
    connection: &mut SqliteConnection,
    expected_agent_id: &AgentIdV1,
    exact: &OrchestrationDispatchGenerationV1,
    source: &WorkflowSessionGenerationV1,
    target: &WorkflowSessionGenerationV1,
    reconciled_at_ms: i64,
) -> Result<Option<OrchestrationDispatchSessionRebindReceiptV1>, DomainStoreErrorV1> {
    let Some(reporting_authority) = reporting_runtime_authority_for_exact_dispatch_on(
        connection,
        exact,
        Some(expected_agent_id),
    )
    .await?
    else {
        return Ok(None);
    };
    let runtime_kind_id = reporting_authority.runtime_kind_id;
    let Some((selection, mut expected_authority)) = current_native_selection_for_target_on(
        connection,
        target,
        &runtime_kind_id,
        expected_agent_id,
    )
    .await?
    else {
        return Ok(None);
    };
    let Some(mut operation_id) = selection.selected_by_operation_id.clone() else {
        return Ok(None);
    };
    let mut expected_selection = selection;
    let mut expected_target = target.clone();
    let mut reversed = Vec::new();
    let mut visited = BTreeSet::new();

    loop {
        if !visited.insert(operation_id.clone()) {
            return Err(identity_conflict(
                "agent runtime transition",
                operation_id.as_str(),
                "the committed runtime transition lineage contains a cycle",
            ));
        }
        let Some(record) = transition_on(connection, &operation_id).await? else {
            return Ok(None);
        };
        if record.state != AgentRuntimeTransitionStateV1::Committed
            || record.intent.target_selection_at(record.updated_at_ms)? != expected_selection
            || record.target_authority.as_ref().is_none_or(|authority| {
                !runtime_generation_authority_converges_from(authority, &expected_authority)
            })
        {
            return Err(identity_conflict(
                "agent runtime transition",
                operation_id.as_str(),
                "the selected transition does not commit the expected runtime selection",
            ));
        }
        let Some(request) =
            OrchestrationDispatchSessionRebindMutationV1::from_committed_native_runtime_transition(
                &record,
                reconciled_at_ms,
            )?
        else {
            return Ok(None);
        };
        if request.target() != &expected_target {
            return Err(identity_conflict(
                "agent runtime transition",
                operation_id.as_str(),
                "the committed native authority does not match the expected reporting target",
            ));
        }
        expected_target = request.source().clone();
        reversed.push(request);
        if &expected_target == source {
            break;
        }
        let Some(predecessor_operation_id) = record.intent.source.selected_by_operation_id.clone()
        else {
            return Ok(None);
        };
        expected_selection = record.intent.source;
        expected_authority = record.intent.source_authority;
        operation_id = predecessor_operation_id;
    }

    reversed.reverse();
    let mut requests = reversed.into_iter();
    let Some(mut request) = requests.next() else {
        return Ok(None);
    };
    for successor in requests {
        request = request.append_verified_native_successor(successor)?;
    }
    reconcile_dispatch_session_on(connection, &request, exact)
        .await
        .map(Some)
}

async fn current_native_selection_for_target_on(
    connection: &mut SqliteConnection,
    target: &WorkflowSessionGenerationV1,
    runtime_kind_id: &RuntimeKindIdV1,
    expected_agent_id: &AgentIdV1,
) -> Result<Option<(AgentRuntimeSelectionV1, AgentRuntimeBindingAuthorityV1)>, DomainStoreErrorV1> {
    let Some(authority) =
        authority_for_exact_session_on(connection, target, runtime_kind_id).await?
    else {
        return Ok(None);
    };
    let agent_id = authority.binding.agent_id.clone();
    if &agent_id != expected_agent_id {
        return Err(identity_conflict(
            "agent runtime authority",
            expected_agent_id.as_str(),
            "the reporting target belongs to another Agent",
        ));
    }
    let Some(selection) = selection_on(connection, &agent_id).await? else {
        return Ok(None);
    };
    if selection.interaction_profile != AgentInteractionProfileV1::NativeCli
        || selection.provider_id != target.provider_id
    {
        return Ok(None);
    }
    Ok(Some((
        selection,
        AgentRuntimeBindingAuthorityV1::NativeCli { authority },
    )))
}
