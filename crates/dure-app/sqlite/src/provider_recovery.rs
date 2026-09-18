use dure_app::{
    DomainStoreErrorV1, DomainStoreFuture, ProviderIdV1, ProviderRecoveryPolicyPutV1,
    ProviderRecoveryPolicyV1, ProviderRecoveryStore,
};
use sqlx::{Row, SqliteConnection};

use crate::SqliteDomainStore;
use crate::error::{map_sqlx, serialization};

pub(crate) const CREATE_POLICIES: &str = r#"
CREATE TABLE IF NOT EXISTS provider_recovery_policies (
    provider_id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
)
"#;
pub(crate) const CREATE_MUTATIONS: &str = r#"
CREATE TABLE IF NOT EXISTS provider_recovery_mutations (
    provider_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (provider_id, idempotency_key)
)
"#;

fn encode<T: serde::Serialize>(value: &T) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(value).map_err(|error| serialization("provider recovery", error))
}

fn decode(source: &str) -> Result<ProviderRecoveryPolicyV1, DomainStoreErrorV1> {
    serde_json::from_str(source).map_err(|error| serialization("provider recovery", error))
}

pub(crate) async fn read_on(
    connection: &mut SqliteConnection,
    provider_id: &ProviderIdV1,
) -> Result<Option<ProviderRecoveryPolicyV1>, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM provider_recovery_policies WHERE provider_id = ?1",
    )
    .bind(provider_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_provider_recovery_policy", error))?
    .map(|source| decode(&source))
    .transpose()
}

async fn put_on(
    connection: &mut SqliteConnection,
    request: &ProviderRecoveryPolicyPutV1,
    observed_at_ms: i64,
) -> Result<ProviderRecoveryPolicyV1, DomainStoreErrorV1> {
    let source = encode(request)?;
    if let Some(row) = sqlx::query(
        "SELECT request_json, record_json FROM provider_recovery_mutations \
         WHERE provider_id = ?1 AND idempotency_key = ?2",
    )
    .bind(request.provider_id.as_str())
    .bind(&request.idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_provider_recovery_mutation", error))?
    {
        if row.get::<String, _>("request_json") != source {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: "recovery policy request key has different input".into(),
            });
        }
        return decode(&row.get::<String, _>("record_json"));
    }
    let current = read_on(connection, &request.provider_id).await?;
    if current.as_ref().map_or(0, |policy| policy.revision) != request.expected_revision {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "provider_recovery_policy",
            id: request.provider_id.as_str().to_owned(),
            reason: "recovery policy revision changed".into(),
        });
    }
    let activated_at_ms = request.enabled.then(|| {
        current
            .as_ref()
            .filter(|policy| policy.enabled)
            .and_then(|policy| policy.activated_at_ms)
            .unwrap_or(observed_at_ms)
    });
    let revision = request.expected_revision.checked_add(1).ok_or_else(|| {
        DomainStoreErrorV1::InvalidRecord {
            field: "expectedRevision",
            reason: "recovery policy revision exhausted".into(),
        }
    })?;
    let record = ProviderRecoveryPolicyV1 {
        schema_version: 1,
        provider_id: request.provider_id.clone(),
        revision,
        enabled: request.enabled,
        accounts: request.accounts.clone(),
        activated_at_ms,
        updated_at_ms: observed_at_ms,
    };
    let encoded = encode(&record)?;
    sqlx::query(
        "INSERT INTO provider_recovery_policies (provider_id, record_json) VALUES (?1, ?2) \
         ON CONFLICT(provider_id) DO UPDATE SET record_json = excluded.record_json",
    )
    .bind(request.provider_id.as_str())
    .bind(&encoded)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("write_provider_recovery_policy", error))?;
    sqlx::query(
        "INSERT INTO provider_recovery_mutations \
         (provider_id, idempotency_key, request_json, record_json) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(request.provider_id.as_str())
    .bind(&request.idempotency_key)
    .bind(source)
    .bind(encoded)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("write_provider_recovery_mutation", error))?;
    Ok(record)
}

impl ProviderRecoveryStore for SqliteDomainStore {
    fn provider_recovery_policy<'a>(
        &'a self,
        provider_id: &'a ProviderIdV1,
    ) -> DomainStoreFuture<'a, Option<ProviderRecoveryPolicyV1>> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| map_sqlx("read_provider_recovery_policy", error))?;
            read_on(&mut connection, provider_id).await
        })
    }

    fn put_provider_recovery_policy<'a>(
        &'a self,
        request: &'a ProviderRecoveryPolicyPutV1,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, ProviderRecoveryPolicyV1> {
        Box::pin(async move {
            request.validate()?;
            if observed_at_ms < 0 {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "observedAtMs",
                    reason: "must be nonnegative".into(),
                });
            }
            let mut transaction = self
                .pool
                .begin_with("BEGIN IMMEDIATE")
                .await
                .map_err(|error| map_sqlx("put_provider_recovery_policy", error))?;
            let record = put_on(&mut transaction, request, observed_at_ms).await?;
            transaction
                .commit()
                .await
                .map_err(|error| map_sqlx("put_provider_recovery_policy", error))?;
            Ok(record)
        })
    }

    fn observe_provider_recovery_usage<'a>(
        &'a self,
        observation: &'a dure_app::ProviderRecoveryUsageV1,
    ) -> DomainStoreFuture<'a, ()> {
        Box::pin(async move {
            let mut connection = self
                .pool
                .acquire()
                .await
                .map_err(|error| map_sqlx("observe_provider_recovery_usage", error))?;
            crate::provider_recovery_usage::observe_on(&mut connection, observation).await
        })
    }
}
