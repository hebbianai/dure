use dure_app::{
    AgentExecutionProfileV1, DomainStoreErrorV1, ProviderIdV1, ProviderRecoveryAccountV1,
    ProviderRecoveryUsageV1,
};
use sqlx::{Row, SqliteConnection};

use crate::error::map_sqlx;

pub(crate) const CREATE_USAGE: &str = r#"
CREATE TABLE IF NOT EXISTS provider_recovery_usage (
    provider_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    credential_generation TEXT NOT NULL,
    used_percent REAL,
    observed_at_ms INTEGER,
    reported_at_ms INTEGER,
    PRIMARY KEY (provider_id, reference_id, credential_generation)
)
"#;

pub(crate) async fn observe_on(
    connection: &mut SqliteConnection,
    observation: &ProviderRecoveryUsageV1,
) -> Result<(), DomainStoreErrorV1> {
    observation.profile.validate()?;
    if observation.observed_at_ms < 0
        || observation
            .used_percent
            .is_some_and(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "usage",
            reason: "usage must have a nonnegative time and a percentage from 0 to 100".into(),
        });
    }
    sqlx::query("INSERT INTO provider_recovery_usage \
        (provider_id, reference_id, credential_generation, used_percent, observed_at_ms) VALUES (?1, ?2, ?3, ?4, ?5) \
        ON CONFLICT(provider_id, reference_id, credential_generation) DO UPDATE SET \
        used_percent = excluded.used_percent, observed_at_ms = excluded.observed_at_ms \
        WHERE provider_recovery_usage.observed_at_ms IS NULL OR excluded.observed_at_ms > provider_recovery_usage.observed_at_ms")
        .bind(observation.profile.provider_id.as_str()).bind(&observation.profile.reference_id)
        .bind(&observation.profile.credential_generation).bind(observation.used_percent)
        .bind(observation.observed_at_ms).execute(&mut *connection).await
        .map_err(|error| map_sqlx("observe_provider_recovery_usage", error))?;
    Ok(())
}

pub(crate) async fn report_limit_on(
    connection: &mut SqliteConnection,
    provider_id: &ProviderIdV1,
    source: &AgentExecutionProfileV1,
    observed_at_ms: i64,
) -> Result<(), DomainStoreErrorV1> {
    let AgentExecutionProfileV1::CredentialReference {
        reference_id,
        credential_generation: Some(generation),
    } = source
    else {
        return Ok(());
    };
    sqlx::query("INSERT INTO provider_recovery_usage \
        (provider_id, reference_id, credential_generation, reported_at_ms) VALUES (?1, ?2, ?3, ?4) \
        ON CONFLICT(provider_id, reference_id, credential_generation) DO UPDATE SET \
        reported_at_ms = MAX(COALESCE(provider_recovery_usage.reported_at_ms, 0), excluded.reported_at_ms)")
        .bind(provider_id.as_str()).bind(reference_id).bind(generation).bind(observed_at_ms)
        .execute(&mut *connection).await.map_err(|error| map_sqlx("report_provider_recovery_limit", error))?;
    Ok(())
}

pub(crate) async fn select_on(
    connection: &mut SqliteConnection,
    accounts: &[ProviderRecoveryAccountV1],
    source: &AgentExecutionProfileV1,
    observed_at_ms: i64,
) -> Result<Option<ProviderRecoveryAccountV1>, DomainStoreErrorV1> {
    let mut best: Option<(&ProviderRecoveryAccountV1, f64)> = None;
    for account in accounts {
        if matches!(source, AgentExecutionProfileV1::CredentialReference { reference_id, .. } if reference_id == &account.profile.reference_id)
        {
            continue;
        }
        let row = sqlx::query(
            "SELECT used_percent, observed_at_ms, reported_at_ms FROM provider_recovery_usage \
            WHERE provider_id = ?1 AND reference_id = ?2 AND credential_generation = ?3",
        )
        .bind(account.profile.provider_id.as_str())
        .bind(&account.profile.reference_id)
        .bind(&account.profile.credential_generation)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("select_provider_recovery_account", error))?;
        let usage = row.and_then(|row| {
            let polled: Option<i64> = row.get("observed_at_ms");
            let reported: Option<i64> = row.get("reported_at_ms");
            let used: Option<f64> = row.get("used_percent");
            let (at, used) = match (polled, reported) {
                (_, Some(at)) if used.is_none() || polled.is_none_or(|polled| at >= polled) => {
                    (Some(at), Some(100.0))
                }
                _ => (polled, used),
            };
            // Match the usage UI's 30-minute observation window. Unknown and
            // stale accounts stay eligible after freshly observed candidates.
            at.filter(|at| *at <= observed_at_ms && observed_at_ms - *at <= 30 * 60 * 1000)
                .and(used)
        });
        if usage.is_some_and(|used| used >= 100.0) {
            continue;
        }
        let rank = usage.unwrap_or(f64::INFINITY);
        if best.is_none_or(|(_, previous)| rank < previous) {
            best = Some((account, rank));
        }
    }
    Ok(best.map(|(account, _)| account.clone()))
}
