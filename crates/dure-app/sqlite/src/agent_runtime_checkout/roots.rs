use super::*;
use crate::session_checkout::row::read_registration;

// Resource membership only: Hmux still owns runtime state and retirement.
pub(crate) const CREATE_ROOTS: &str = "CREATE TABLE IF NOT EXISTS agent_checkout_roots (\
    origin_id TEXT PRIMARY KEY NOT NULL, origin_json TEXT NOT NULL, \
    registration_id TEXT NOT NULL REFERENCES session_checkout_bindings(registration_id))";
pub(crate) const ROOTS_BY_REGISTRATION: &str = "CREATE INDEX IF NOT EXISTS agent_checkout_roots_by_registration ON agent_checkout_roots(registration_id)";

impl crate::SqliteDomainStore {
    pub async fn agent_checkout_for_root(
        &self,
        origin: &SessionCheckoutIdentityV1,
    ) -> Result<Option<SessionCheckoutBindingV1>, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("read_agent_checkout_root", error))?;
        binding_on(&mut connection, origin).await
    }

    /// Called after closing Agent admission; the set cannot grow after close.
    pub async fn agent_checkout_roots(
        &self,
        binding: &SessionCheckoutBindingV1,
    ) -> Result<Vec<SessionCheckoutIdentityV1>, DomainStoreErrorV1> {
        let values = sqlx::query_scalar::<_, String>(
            "SELECT origin_json FROM agent_checkout_roots WHERE registration_id = ?1 ORDER BY origin_id",
        ).bind(binding.claim_id.as_str()).fetch_all(&self.pool).await
            .map_err(|error| map_sqlx("read_agent_checkout_roots", error))?;
        values
            .into_iter()
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| serialization("agent_checkout_root", error))
            })
            .collect()
    }
}

pub(super) async fn binding_on(
    connection: &mut SqliteConnection,
    origin: &SessionCheckoutIdentityV1,
) -> Result<Option<SessionCheckoutBindingV1>, DomainStoreErrorV1> {
    let registration = sqlx::query_scalar::<_, String>(
        "SELECT registration_id FROM agent_checkout_roots WHERE origin_id = ?1 AND origin_json = ?2",
    ).bind(origin.owner_id().as_str())
        .bind(serde_json::to_string(origin).map_err(|error| serialization("agent_checkout_root", error))?)
        .fetch_optional(&mut *connection).await
        .map_err(|error| map_sqlx("read_agent_checkout_root", error))?;
    match registration {
        Some(id) => Ok(read_registration(
            connection,
            &OperationIdV1::new(id)
                .map_err(|error| corrupt_identifier("agent_checkout_root", error))?,
        )
        .await?
        .map(|record| record.binding)),
        None => Ok(None),
    }
}

/// Persist only after acquiring the Git claim, or under admission for an
/// already-retained root of the same Agent. Reservation precedes publication.
pub(crate) async fn remember_on(
    connection: &mut SqliteConnection,
    binding: &SessionCheckoutBindingV1,
    origin: &SessionCheckoutIdentityV1,
) -> Result<(), DomainStoreErrorV1> {
    if let Some(existing) = binding_on(connection, origin).await? {
        if existing == *binding {
            return Ok(());
        }
        return Err(identity_conflict(
            "agent checkout root",
            origin.owner_id().as_str(),
            "another Agent owns the root",
        ));
    }
    sqlx::query("INSERT INTO agent_checkout_roots (origin_id, origin_json, registration_id) VALUES (?1, ?2, ?3)")
        .bind(origin.owner_id().as_str())
        .bind(serde_json::to_string(origin).map_err(|error| serialization("agent_checkout_root", error))?)
        .bind(binding.claim_id.as_str()).execute(connection).await
        .map_err(|error| map_sqlx("remember_agent_checkout_root", error))?;
    Ok(())
}
