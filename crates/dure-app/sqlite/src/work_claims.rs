use dure_app::{
    DomainStoreErrorV1, MAX_WORK_CLAIMS_LISTED_V1, WORK_CLAIM_SCHEMA_VERSION_V1,
    WorkClaimPutReceiptV1, WorkClaimPutRequestV1, WorkClaimRecordV1, work_claim_overlaps,
};
use sqlx::SqliteConnection;

use crate::SqliteDomainStore;
use crate::error::{map_sqlx, serialization};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) const CREATE_CLAIMS: &str = r#"
CREATE TABLE IF NOT EXISTS work_claims (
    repository TEXT NOT NULL,
    holder TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (repository, holder)
)
"#;

fn encode(record: &WorkClaimRecordV1) -> Result<String, DomainStoreErrorV1> {
    serde_json::to_string(record).map_err(|error| serialization("work claim", error))
}

fn decode(source: &str) -> Result<WorkClaimRecordV1, DomainStoreErrorV1> {
    serde_json::from_str(source).map_err(|error| serialization("work claim record", error))
}

async fn repository_claims_on(
    connection: &mut SqliteConnection,
    repository: &str,
) -> Result<Vec<WorkClaimRecordV1>, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM work_claims WHERE repository = ?1 ORDER BY holder",
    )
    .bind(repository)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_work_claims", error))?
    .iter()
    .map(|source| decode(source))
    .collect()
}

impl SqliteDomainStore {
    /// Replace the holder's claim in its repository and report the other
    /// claims it overlaps, read in the same transaction as the write.
    pub async fn put_work_claim(
        &self,
        request: &WorkClaimPutRequestV1,
        observed_at_ms: i64,
    ) -> Result<WorkClaimPutReceiptV1, DomainStoreErrorV1> {
        request.validate()?;
        if observed_at_ms < 0 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "observedAtMs",
                reason: "must be nonnegative".into(),
            });
        }
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("put_work_claim", error))?;
        begin_immediate(&mut connection, "put_work_claim").await?;
        let result = async {
            let held = repository_claims_on(&mut connection, &request.claim.repository).await?;
            let current = held
                .iter()
                .find(|record| record.claim.holder == request.claim.holder);
            let claim = WorkClaimRecordV1 {
                schema_version: WORK_CLAIM_SCHEMA_VERSION_V1,
                claim: request.claim.clone(),
                claimed_at_ms: current.map_or(observed_at_ms, |record| record.claimed_at_ms),
                updated_at_ms: current.map_or(observed_at_ms, |record| {
                    observed_at_ms.max(record.updated_at_ms)
                }),
            };
            let overlaps = work_claim_overlaps(&request.claim, &held);
            if !request.dry_run {
                sqlx::query(
                    "INSERT INTO work_claims (repository, holder, record_json) VALUES (?1, ?2, ?3) \
                    ON CONFLICT(repository, holder) DO UPDATE SET record_json = excluded.record_json",
                )
                .bind(&claim.claim.repository)
                .bind(&claim.claim.holder)
                .bind(encode(&claim)?)
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("write_work_claim", error))?;
            }
            Ok(WorkClaimPutReceiptV1 {
                schema_version: WORK_CLAIM_SCHEMA_VERSION_V1,
                claim,
                recorded: !request.dry_run,
                overlaps,
            })
        }
        .await;
        finish_transaction(&mut connection, "put_work_claim", result).await
    }

    /// Claims ordered by repository and holder, at most
    /// `MAX_WORK_CLAIMS_LISTED_V1`; the flag says whether that is all of them.
    pub async fn work_claims(
        &self,
        repository: Option<&str>,
    ) -> Result<(Vec<WorkClaimRecordV1>, bool), DomainStoreErrorV1> {
        let limit = i64::try_from(MAX_WORK_CLAIMS_LISTED_V1 + 1).unwrap_or(i64::MAX);
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT record_json FROM work_claims WHERE ?1 IS NULL OR repository = ?1 \
            ORDER BY repository, holder LIMIT ?2",
        )
        .bind(repository)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| map_sqlx("list_work_claims", error))?;
        let complete = rows.len() <= MAX_WORK_CLAIMS_LISTED_V1;
        let claims = rows
            .iter()
            .take(MAX_WORK_CLAIMS_LISTED_V1)
            .map(|source| decode(source))
            .collect::<Result<_, _>>()?;
        Ok((claims, complete))
    }

    /// Remove the holder's claim; `None` when it held none.
    pub async fn release_work_claim(
        &self,
        repository: &str,
        holder: &str,
    ) -> Result<Option<WorkClaimRecordV1>, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("release_work_claim", error))?;
        begin_immediate(&mut connection, "release_work_claim").await?;
        let result = async {
            let Some(source) = sqlx::query_scalar::<_, String>(
                "SELECT record_json FROM work_claims WHERE repository = ?1 AND holder = ?2",
            )
            .bind(repository)
            .bind(holder)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| map_sqlx("read_work_claim", error))?
            else {
                return Ok(None);
            };
            sqlx::query("DELETE FROM work_claims WHERE repository = ?1 AND holder = ?2")
                .bind(repository)
                .bind(holder)
                .execute(&mut *connection)
                .await
                .map_err(|error| map_sqlx("delete_work_claim", error))?;
            decode(&source).map(Some)
        }
        .await;
        finish_transaction(&mut connection, "release_work_claim", result).await
    }
}

#[cfg(test)]
mod tests {
    use dure_app::{
        CURRENT_STORE_SCHEMA_VERSION, DomainStore, WorkClaimOverlapReasonV1, WorkClaimV1,
    };
    use tempfile::TempDir;

    use crate::SqliteDomainStore;

    use super::*;

    fn request(holder: &str, issue: &str, paths: &[&str]) -> WorkClaimPutRequestV1 {
        WorkClaimPutRequestV1 {
            schema_version: 1,
            claim: WorkClaimV1 {
                repository: "/work/repo/.git".into(),
                holder: holder.into(),
                session_id: None,
                workspace_id: None,
                issue: Some(issue.into()),
                branch: None,
                worktree: None,
                paths: paths.iter().map(|path| (*path).into()).collect(),
                note: None,
            },
            dry_run: false,
        }
    }

    #[tokio::test]
    async fn claims_replace_per_holder_report_overlaps_and_release() {
        let root = TempDir::new().unwrap();
        let store = SqliteDomainStore::open(root.path().join("store.sqlite"))
            .await
            .unwrap();

        let first = store
            .put_work_claim(&request("engine-1", "2", &["Sources/Engine/**"]), 10)
            .await
            .unwrap();
        assert!(first.recorded);
        assert!(first.overlaps.is_empty());
        assert_eq!(first.claim.claimed_at_ms, 10);

        let mut check = request("engine-2", "3", &["Sources/Engine/Core"]);
        check.dry_run = true;
        let checked = store.put_work_claim(&check, 20).await.unwrap();
        assert!(!checked.recorded);
        assert_eq!(checked.overlaps.len(), 1);
        assert_eq!(checked.overlaps[0].held, first.claim);
        assert_eq!(
            checked.overlaps[0].reasons,
            vec![WorkClaimOverlapReasonV1::Paths]
        );
        assert_eq!(store.work_claims(None).await.unwrap().0.len(), 1);

        let second = store
            .put_work_claim(&request("engine-2", "2", &["Sources/UI/**"]), 30)
            .await
            .unwrap();
        assert_eq!(
            second.overlaps[0].reasons,
            vec![WorkClaimOverlapReasonV1::Issue]
        );

        // The same holder replaces its claim and keeps when it first claimed.
        let replaced = store
            .put_work_claim(&request("engine-1", "4", &["Docs/**"]), 25)
            .await
            .unwrap();
        assert!(replaced.overlaps.is_empty());
        assert_eq!(replaced.claim.claimed_at_ms, 10);
        assert_eq!(replaced.claim.updated_at_ms, 25);

        let mut elsewhere = request("engine-1", "2", &["Sources/Engine/**"]);
        elsewhere.claim.repository = "/work/other/.git".into();
        store.put_work_claim(&elsewhere, 40).await.unwrap();

        let (all, complete) = store.work_claims(None).await.unwrap();
        assert!(complete);
        assert_eq!(
            all.iter()
                .map(|record| (
                    record.claim.repository.as_str(),
                    record.claim.holder.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("/work/other/.git", "engine-1"),
                ("/work/repo/.git", "engine-1"),
                ("/work/repo/.git", "engine-2"),
            ]
        );
        assert_eq!(
            store
                .work_claims(Some("/work/repo/.git"))
                .await
                .unwrap()
                .0
                .len(),
            2
        );

        let released = store
            .release_work_claim("/work/repo/.git", "engine-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(released, replaced.claim);
        assert_eq!(
            store
                .release_work_claim("/work/repo/.git", "engine-1")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .work_claims(Some("/work/repo/.git"))
                .await
                .unwrap()
                .0
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn invalid_claims_are_not_written() {
        let root = TempDir::new().unwrap();
        let store = SqliteDomainStore::open(root.path().join("store.sqlite"))
            .await
            .unwrap();
        let mut empty = request("engine-1", "2", &[]);
        empty.claim.issue = None;
        assert!(matches!(
            store.put_work_claim(&empty, 1).await,
            Err(DomainStoreErrorV1::InvalidRecord { field: "claim", .. })
        ));
        assert!(store.work_claims(None).await.unwrap().0.is_empty());
    }

    #[tokio::test]
    async fn schema_fifty_three_gains_the_claim_table() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("store.sqlite");
        let store = SqliteDomainStore::open(&path).await.unwrap();
        sqlx::query("DROP TABLE work_claims")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE store_metadata SET schema_version = 53")
            .execute(&store.pool)
            .await
            .unwrap();
        store.close().await;

        let migrated = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(
            migrated.schema_info().schema_version,
            CURRENT_STORE_SCHEMA_VERSION
        );
        migrated
            .put_work_claim(&request("engine-1", "2", &["src/**"]), 1)
            .await
            .unwrap();
        assert_eq!(migrated.work_claims(None).await.unwrap().0.len(), 1);
    }
}
