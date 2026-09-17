use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AgentIdV1, DomainStore, DomainStoreErrorV1, ReviewIdV1, ReviewTargetRecordV1,
    ReviewTargetRetentionPolicyV1, ReviewTargetRootSnapshotV1, ReviewTargetSweepReceiptV1,
};
use dure_app_sqlite::SqliteDomainStore;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::OnceCell;

use crate::diff::{self, AgentDiffReview};

const DOMAIN_DATABASE_NAME: &str = "application-state.sqlite3";
const INACTIVE_REVIEW_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const MAX_INACTIVE_REVIEW_TARGETS: u32 = 128;

#[derive(Default)]
pub struct ReviewStoreState {
    store: OnceCell<SqliteDomainStore>,
}

impl ReviewStoreState {
    async fn store(&self, app: &AppHandle) -> Result<&SqliteDomainStore, String> {
        self.store
            .get_or_try_init(|| async {
                let app_data_dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| error.to_string())?;
                std::fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
                SqliteDomainStore::open(app_data_dir.join(DOMAIN_DATABASE_NAME))
                    .await
                    .map_err(|error| error.to_string())
            })
            .await
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshotV1 {
    target: ReviewTargetRecordV1,
    review: AgentDiffReview,
}

fn created_at_ms() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "The current time exceeds the storage range".to_string())
}

#[tauri::command]
pub async fn diff_review_target_create(
    app: AppHandle,
    state: State<'_, ReviewStoreState>,
    review_id: String,
    path: String,
    source_session_id: Option<String>,
    feedback_agent_id: Option<String>,
) -> Result<ReviewTargetRecordV1, String> {
    let review_id = ReviewIdV1::new(review_id).map_err(|error| error.to_string())?;
    let feedback_agent_id = feedback_agent_id
        .map(AgentIdV1::new)
        .transpose()
        .map_err(|error| error.to_string())?;
    let store = state.store(&app).await?;

    if let Some(existing) = store
        .review_target(&review_id)
        .await
        .map_err(|error| error.to_string())?
    {
        return Ok(existing);
    }

    let captured = tauri::async_runtime::spawn_blocking(move || diff::capture_review_target(&path))
        .await
        .map_err(|error| error.to_string())??;
    let record = ReviewTargetRecordV1 {
        review_id,
        worktree_path: captured.worktree_path,
        worktree_git_dir: captured.worktree_git_dir,
        base_ref: captured.base_ref,
        base_commit_sha: captured.base_commit_sha,
        head_commit_sha: captured.head_commit_sha,
        source_session_id,
        feedback_agent_id,
        created_at_ms: created_at_ms()?,
    };

    match store.create_review_target(&record).await {
        Ok(()) => Ok(record),
        Err(DomainStoreErrorV1::IdentityConflict { .. }) => store
            .review_target(&record.review_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Could not find the review target created concurrently".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn diff_review_snapshot(
    app: AppHandle,
    state: State<'_, ReviewStoreState>,
    review_id: String,
) -> Result<ReviewSnapshotV1, String> {
    let review_id = ReviewIdV1::new(review_id).map_err(|error| error.to_string())?;
    let target = state
        .store(&app)
        .await?
        .review_target(&review_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Review target {review_id:?} was not found"))?;
    let target_for_diff = target.clone();
    let review = tauri::async_runtime::spawn_blocking(move || {
        diff::agent_diff_review_at_target(
            &target_for_diff.worktree_path,
            &target_for_diff.worktree_git_dir,
            &target_for_diff.base_ref,
            &target_for_diff.base_commit_sha,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(ReviewSnapshotV1 { target, review })
}

#[tauri::command]
pub async fn diff_review_targets_reconcile(
    app: AppHandle,
    state: State<'_, ReviewStoreState>,
    active_review_ids: Vec<String>,
    observed_at_ms: i64,
) -> Result<ReviewTargetSweepReceiptV1, String> {
    let active_review_ids = active_review_ids
        .into_iter()
        .map(ReviewIdV1::new)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let snapshot = ReviewTargetRootSnapshotV1 {
        active_review_ids,
        observed_at_ms,
    };
    let policy = ReviewTargetRetentionPolicyV1 {
        inactive_retention_ms: INACTIVE_REVIEW_RETENTION_MS,
        max_inactive_targets: MAX_INACTIVE_REVIEW_TARGETS,
    };
    state
        .store(&app)
        .await?
        .reconcile_review_target_roots(&snapshot, &policy)
        .await
        .map_err(|error| error.to_string())
}
