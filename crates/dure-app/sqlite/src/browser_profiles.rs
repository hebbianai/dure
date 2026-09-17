//! Profile metadata shares the domain database. Tombstones prevent a replayed
//! creation from reviving storage after retirement.
use dure_app::{
    BrowserProfileIdV1, BrowserProfileRecordV1, BrowserProfileSpecV1, BrowserProfileStateV1,
    BrowserProfileStore, DomainStoreErrorV1, DomainStoreFuture,
};
use sqlx::{Row, SqlitePool};

use crate::{
    SqliteDomainStore,
    error::{identity_conflict, map_sqlx, storage},
};

pub(crate) const CREATE_PROFILES: &str = r#"
CREATE TABLE IF NOT EXISTS browser_profiles (
    profile_id TEXT PRIMARY KEY NOT NULL,
    spec_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'deleted')),
    CHECK (profile_id <> 'default' OR state = 'active')
)
"#;

pub(crate) const CREATE_DEFAULT: &str = r#"
INSERT OR IGNORE INTO browser_profiles(profile_id, spec_json, state)
VALUES ('default', '{"profileId":"default","label":"Default","scope":"default","userAgentMode":"clean"}', 'active')
"#;

impl BrowserProfileStore for SqliteDomainStore {
    fn browser_profiles(&self) -> DomainStoreFuture<'_, Vec<BrowserProfileRecordV1>> {
        Box::pin(async {
            sqlx::query("SELECT profile_id, spec_json, state FROM browser_profiles WHERE state <> 'deleted' ORDER BY profile_id <> 'default', profile_id")
                .fetch_all(&self.pool).await
                .map_err(|e| map_sqlx("list_browser_profiles", e))?
                .into_iter().map(decode).collect()
        })
    }

    fn browser_profile<'a>(
        &'a self,
        id: &'a BrowserProfileIdV1,
    ) -> DomainStoreFuture<'a, Option<BrowserProfileRecordV1>> {
        Box::pin(read(&self.pool, id))
    }

    fn create_browser_profile<'a>(
        &'a self,
        profile: &'a BrowserProfileSpecV1,
    ) -> DomainStoreFuture<'a, BrowserProfileRecordV1> {
        Box::pin(async {
            let spec = serde_json::to_string(profile)
                .map_err(|e| storage("browser_profile_encoding_failed", e.to_string()))?;
            sqlx::query("INSERT INTO browser_profiles(profile_id, spec_json, state) VALUES (?1, ?2, 'active') ON CONFLICT(profile_id) DO NOTHING")
                .bind(profile.profile_id().as_str()).bind(spec).execute(&self.pool).await
                .map_err(|e| map_sqlx("create_browser_profile", e))?;
            let existing = require(&self.pool, profile.profile_id()).await?;
            if existing.profile != *profile {
                return Err(identity_conflict(
                    "browser_profile",
                    profile.profile_id().as_str(),
                    "profile identity is already bound to different metadata",
                ));
            }
            Ok(existing)
        })
    }

    fn begin_browser_profile_retirement<'a>(
        &'a self,
        id: &'a BrowserProfileIdV1,
    ) -> DomainStoreFuture<'a, BrowserProfileRecordV1> {
        Box::pin(async {
            if id.is_default() {
                return Err(storage(
                    "browser_default_profile_protected",
                    "the default browser profile cannot be retired",
                ));
            }
            sqlx::query("UPDATE browser_profiles SET state = 'retiring' WHERE profile_id = ?1 AND state = 'active'")
                .bind(id.as_str()).execute(&self.pool).await
                .map_err(|e| map_sqlx("retire_browser_profile", e))?;
            require(&self.pool, id).await
        })
    }

    fn complete_browser_profile_retirement<'a>(
        &'a self,
        id: &'a BrowserProfileIdV1,
    ) -> DomainStoreFuture<'a, BrowserProfileRecordV1> {
        Box::pin(async {
            sqlx::query("UPDATE browser_profiles SET state = 'deleted' WHERE profile_id = ?1 AND state = 'retiring'")
                .bind(id.as_str()).execute(&self.pool).await
                .map_err(|e| map_sqlx("complete_browser_profile_retirement", e))?;
            let record = require(&self.pool, id).await?;
            if record.state != BrowserProfileStateV1::Deleted {
                return Err(storage(
                    "browser_profile_not_retiring",
                    "profile storage retirement was not admitted",
                ));
            }
            Ok(record)
        })
    }
}

async fn read(
    pool: &SqlitePool,
    id: &BrowserProfileIdV1,
) -> Result<Option<BrowserProfileRecordV1>, DomainStoreErrorV1> {
    sqlx::query("SELECT profile_id, spec_json, state FROM browser_profiles WHERE profile_id = ?1")
        .bind(id.as_str())
        .fetch_optional(pool)
        .await
        .map_err(|e| map_sqlx("read_browser_profile", e))?
        .map(decode)
        .transpose()
}

async fn require(
    pool: &SqlitePool,
    id: &BrowserProfileIdV1,
) -> Result<BrowserProfileRecordV1, DomainStoreErrorV1> {
    read(pool, id)
        .await?
        .ok_or_else(|| storage("browser_profile_missing", "browser profile does not exist"))
}

fn decode(row: sqlx::sqlite::SqliteRow) -> Result<BrowserProfileRecordV1, DomainStoreErrorV1> {
    let text = |column| {
        row.try_get::<String, _>(column)
            .map_err(|e| crate::error::corrupt_row("browser_profiles", e))
    };
    let profile: BrowserProfileSpecV1 = serde_json::from_str(&text("spec_json")?)
        .map_err(|e| storage("corrupt_browser_profile", e.to_string()))?;
    if text("profile_id")? != profile.profile_id().as_str() {
        return Err(storage(
            "corrupt_browser_profile",
            "profile key and metadata disagree",
        ));
    }
    let state = match text("state")?.as_str() {
        "active" => BrowserProfileStateV1::Active,
        "retiring" => BrowserProfileStateV1::Retiring,
        "deleted" => BrowserProfileStateV1::Deleted,
        _ => {
            return Err(storage(
                "corrupt_browser_profile",
                "unknown profile retirement state",
            ));
        }
    };
    Ok(BrowserProfileRecordV1 { profile, state })
}

#[cfg(test)]
mod tests;
