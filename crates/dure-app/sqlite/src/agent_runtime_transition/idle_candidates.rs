use dure_app::{AgentIdV1, DomainStoreErrorV1};
use sqlx::Row;

use crate::SqliteDomainStore;
use crate::error::{corrupt_row, map_sqlx, storage};

impl SqliteDomainStore {
    /// Bounded journal read in admission order, not a fleet census or a new
    /// cleanup ledger. Read before filtering so old history cannot make a
    /// monitoring request scan an unbounded table. No schema/index migration.
    pub async fn recent_agent_runtime_transitions(
        &self,
    ) -> Result<(Vec<dure_app::AgentRuntimeTransitionRecordV1>, bool), DomainStoreErrorV1> {
        let mut rows = sqlx::query(
            "SELECT operation_id, idempotency_key, agent_id, state, journal_revision, \
             record_json, created_at_ms, updated_at_ms FROM agent_runtime_transitions \
             ORDER BY rowid DESC LIMIT 65",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| map_sqlx("read_recent_runtime_transitions", error))?;
        let partial = rows.len() > 64;
        rows.truncate(64);
        let records = rows
            .into_iter()
            .map(super::transition_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((records, partial))
    }

    /// Candidate enumeration only. Neither selection nor absence from a page
    /// proves runtime liveness, inactivity, or permission to stop a session.
    pub async fn agent_runtime_native_candidates(
        &self,
        after: Option<&AgentIdV1>,
    ) -> Result<Vec<AgentIdV1>, DomainStoreErrorV1> {
        let rows = sqlx::query(
            "SELECT agent_id FROM agent_runtime_selections \
             WHERE interaction_profile = 'native_cli' AND (?1 IS NULL OR agent_id > ?1) \
             ORDER BY agent_id LIMIT 64",
        )
        .bind(after.map(AgentIdV1::as_str))
        .fetch_all(&self.pool)
        .await
        .map_err(|error| map_sqlx("read_runtime_idle_candidates", error))?;
        rows.into_iter()
            .map(|row| {
                let id: String = row
                    .try_get("agent_id")
                    .map_err(|error| corrupt_row("runtime_idle_candidates", error))?;
                AgentIdV1::new(id)
                    .map_err(|error| storage("corrupt_runtime_idle_candidate", error.to_string()))
            })
            .collect()
    }
}
