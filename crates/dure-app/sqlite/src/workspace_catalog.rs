use crate::{SqliteDomainStore, error::map_sqlx, records::workspace_from_row};
use dure_app::{DomainStoreErrorV1, WorkspaceIdV1, WorkspaceRecordV1};

impl SqliteDomainStore {
    /// Resolve against one complete SQL snapshot; never select from a truncated catalog.
    pub async fn workspace_resolution_snapshot(
        &self,
    ) -> Result<Vec<WorkspaceRecordV1>, DomainStoreErrorV1> {
        let rows = sqlx::query("SELECT workspace_id, project_id, root_path, base_commit_sha, created_at_ms, updated_at_ms FROM workspaces ORDER BY workspace_id LIMIT 10001")
            .fetch_all(&self.pool).await.map_err(|error| map_sqlx("workspace_resolution_snapshot", error))?;
        if rows.len() > 10_000 {
            return Err(DomainStoreErrorV1::Storage {
                code: "workspace_resolution_limit",
                detail: "workspace path resolution exceeds its complete snapshot bound".into(),
            });
        }
        rows.into_iter().map(workspace_from_row).collect()
    }

    /// Read a bounded page from the durable workspace authority. A cursor is
    /// only traversal position; selecting a workspace still requires its id.
    pub async fn workspace_page(
        &self,
        after: Option<&WorkspaceIdV1>,
    ) -> Result<(Vec<WorkspaceRecordV1>, Option<WorkspaceIdV1>), DomainStoreErrorV1> {
        let rows = sqlx::query("SELECT workspace_id, project_id, root_path, base_commit_sha, created_at_ms, updated_at_ms FROM workspaces WHERE (?1 IS NULL OR workspace_id > ?1) ORDER BY workspace_id LIMIT 129")
            .bind(after.map(WorkspaceIdV1::as_str))
            .fetch_all(&self.pool).await.map_err(|error|map_sqlx("workspace_page",error))?;
        let mut records = rows
            .into_iter()
            .map(workspace_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if records.len() > 128 {
            records.pop();
            records.last().map(|row| row.workspace_id.clone())
        } else {
            None
        };
        Ok((records, next))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app::{DomainStore, ProjectIdV1, ProjectRecordV1};

    #[tokio::test]
    async fn traversal_keeps_every_workspace_and_resumes_after_the_last_returned_id() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteDomainStore::open(root.path().join("state.sqlite3"))
            .await
            .unwrap();
        let project = ProjectIdV1::new("project:catalog").unwrap();
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: project.clone(),
                root_path: "/tmp/project".into(),
                display_name: "Catalog fixture".into(),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        for i in 0..130 {
            store
                .upsert_workspace(&WorkspaceRecordV1 {
                    workspace_id: WorkspaceIdV1::new(format!("workspace:{i:03}")).unwrap(),
                    project_id: project.clone(),
                    root_path: format!("/tmp/project/{i}"),
                    base_commit_sha: None,
                    created_at_ms: 1,
                    updated_at_ms: 1,
                })
                .await
                .unwrap();
        }
        let first = store.workspace_page(None).await.unwrap();
        let second = store.workspace_page(first.1.as_ref()).await.unwrap();
        store.close().await;
        assert_eq!(first.0.len(), 128);
        assert_eq!(first.1.unwrap().as_str(), "workspace:127");
        assert!(second.1.is_none());
        assert_eq!(
            second
                .0
                .iter()
                .map(|row| row.workspace_id.as_str())
                .collect::<Vec<_>>(),
            vec!["workspace:128", "workspace:129"]
        );
    }
}
