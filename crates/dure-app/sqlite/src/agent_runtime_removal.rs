use dure_app::{
    AgentRuntimeCloseIntentV1, AgentRuntimeCloseRecordV1, AgentRuntimeCloseStateV1,
    AgentRuntimeRemovalPlanV1, AgentRuntimeRemovalV1, DomainStoreErrorV1, OperationIdV1,
    SessionCheckoutOwnerV1,
};
use sqlx::SqliteConnection;

use crate::agent_runtime_checkout::{adopt_on, checkout_on};
use crate::agent_runtime_close::{admit_on, effective_close_for_agent_on};
use crate::error::{identity_conflict, map_sqlx, serialization};
use crate::schema::{begin_immediate, finish_transaction};

impl crate::SqliteDomainStore {
    /// The runtime close and its resource finalization are admitted together.
    /// This also attaches removal to an already stopped, still-selected source;
    /// its original immutable stop intent and revision remain unchanged.
    /// A legacy Managed checkout is transferred and persisted as an Agent
    /// checkout here; both the original and retained plan replay identically.
    pub async fn admit_agent_runtime_removal(
        &self,
        intent: &AgentRuntimeCloseIntentV1,
        plan: &AgentRuntimeRemovalPlanV1,
    ) -> Result<AgentRuntimeCloseRecordV1, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("admit_agent_runtime_removal", error))?;
        begin_immediate(&mut connection, "admit_agent_runtime_removal").await?;
        let result = async {
            let close = admit_on(&mut connection, intent).await?;
            let mut retained_plan = plan.clone();
            if let Some(source) = plan.checkout.as_ref().filter(|source| {
                matches!(
                    source.identity.owner,
                    SessionCheckoutOwnerV1::Managed { .. }
                )
            }) {
                retained_plan.checkout = Some(source.retained_by_agent(&intent.source.agent_id));
                // Retaining the Agent owner must not erase the original input
                // identity. It remains part of both cleanup and exact replay.
                if !retained_plan.managed_roots.contains(&source.identity) {
                    retained_plan.managed_roots.push(source.identity.clone());
                }
            }
            if let Some(existing) = read_on(&mut connection, &intent.operation_id).await? {
                if existing.plan != retained_plan {
                    return Err(conflict(intent, "the admitted removal input changed"));
                }
                return Ok(close);
            }
            if close.state == AgentRuntimeCloseStateV1::SourceRetained
                || effective_close_for_agent_on(&mut connection, &intent.source.agent_id)
                    .await?
                    .as_ref()
                    != Some(&close)
            {
                return Err(conflict(
                    intent,
                    "removal does not own the selected runtime close",
                ));
            }
            // Close admission is the authority for both current runtimes and
            // exact retained RepairRequired sources. Legacy transfer belongs
            // in this same transaction, not a competing active-binding check.
            if let (Some(source), Some(retained)) = (&plan.checkout, &retained_plan.checkout) {
                if source.identity != retained.identity {
                    adopt_on(&mut connection, &intent.source.agent_id, source).await?;
                }
            }
            let checkout = checkout_on(&mut connection, &intent.source.agent_id).await?;
            if checkout.as_ref().map(|record| &record.binding) != retained_plan.checkout.as_ref() {
                return Err(conflict(intent, "the selected resource lifetime changed"));
            }
            let removal = AgentRuntimeRemovalV1 {
                schema_version: 1,
                plan: retained_plan,
                completed_at_ms: None,
            };
            let serialized = serde_json::to_string(&removal)
                .map_err(|error| serialization("agent_runtime_removal", error))?;
            sqlx::query(
                "UPDATE agent_runtime_closes SET removal_json = ?2 WHERE operation_id = ?1",
            )
            .bind(intent.operation_id.as_str())
            .bind(serialized)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("admit_agent_runtime_removal", error))?;
            Ok(close)
        }
        .await;
        finish_transaction(&mut connection, "admit_agent_runtime_removal", result).await
    }

    pub async fn agent_runtime_removal(
        &self,
        operation: &OperationIdV1,
    ) -> Result<Option<AgentRuntimeRemovalV1>, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("read_agent_runtime_removal", error))?;
        read_on(&mut connection, operation).await
    }

    /// Called only after all frozen runtime roots and checkout cleanup finish.
    pub async fn finish_agent_runtime_removal(
        &self,
        operation: &OperationIdV1,
        completed_at_ms: i64,
    ) -> Result<(), DomainStoreErrorV1> {
        let result = sqlx::query(
            "UPDATE agent_runtime_closes SET removal_json = json_set(removal_json, '$.completedAtMs', ?2) \
             WHERE operation_id = ?1 AND state = 'stopped' AND removal_json IS NOT NULL \
             AND json_extract(removal_json, '$.completedAtMs') IS NULL",
        ).bind(operation.as_str()).bind(completed_at_ms).execute(&self.pool).await
            .map_err(|error| map_sqlx("finish_agent_runtime_removal", error))?;
        if result.rows_affected() == 0
            && !self
                .agent_runtime_removal(operation)
                .await?
                .is_some_and(|record| record.completed_at_ms.is_some())
        {
            return Err(identity_conflict(
                "agent runtime removal",
                operation.as_str(),
                "runtime removal is not stopped",
            ));
        }
        Ok(())
    }
}

pub(crate) async fn read_on(
    connection: &mut SqliteConnection,
    operation: &OperationIdV1,
) -> Result<Option<AgentRuntimeRemovalV1>, DomainStoreErrorV1> {
    let value = sqlx::query_scalar::<_, Option<String>>(
        "SELECT removal_json FROM agent_runtime_closes WHERE operation_id = ?1",
    )
    .bind(operation.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_removal", error))?
    .flatten();
    value
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| serialization("agent_runtime_removal", error))
        })
        .transpose()
}

fn conflict(intent: &AgentRuntimeCloseIntentV1, reason: &str) -> DomainStoreErrorV1 {
    identity_conflict(
        "agent runtime removal",
        intent.source.agent_id.as_str(),
        reason,
    )
}
