use super::*;
use crate::browser_service::BrowserService;
use dure_app::{ProjectIdV1, ProjectRecordV1, WorkspaceRecordV1};
use serde_json::json;
use std::path::Path;

async fn fixture() -> (tempfile::TempDir, SqliteDomainStore, BrowserService) {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("state.sqlite3"))
        .await
        .unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project:context").unwrap(),
            root_path: root.path().to_string_lossy().into(),
            display_name: "Context fixture".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let backend = crate::backend_runtime_root::ensure(root.path()).unwrap();
    let service = BrowserService::new(backend, "generation:context", root.path());
    (root, store, service)
}

async fn register(store: &SqliteDomainStore, id: &str, path: &Path, updated: i64) {
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new(id).unwrap(),
            project_id: ProjectIdV1::new("project:context").unwrap(),
            root_path: path.to_str().unwrap().into(),
            base_commit_sha: None,
            created_at_ms: 1,
            updated_at_ms: updated,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn browser_without_a_workspace_uses_a_private_browsing_directory() {
    let (root, store, service) = fixture().await;
    let result = service
        .dispatch(
            &store,
            &json!({"kind":"create","operation_id":"create:personal"}),
        )
        .await;
    // No engine is installed in this fixture. Workspace admission must succeed
    // independently of an agent workspace before reaching that boundary.
    assert_eq!(result.unwrap_err().code, "browser_engine_not_installed");
    let workspace = store
        .workspace(&WorkspaceIdV1::new("workspace:dure-browser").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        workspace.root_path,
        root.path()
            .join("backend/browser-workspace")
            .to_str()
            .unwrap()
    );
    assert!(Path::new(&workspace.root_path).is_dir());
    let second = service
        .dispatch(
            &store,
            &json!({"kind":"create","operation_id":"create:personal-again"}),
        )
        .await;
    assert_eq!(second.unwrap_err().code, "browser_engine_not_installed");
    assert_eq!(
        store
            .workspace(&workspace.workspace_id)
            .await
            .unwrap()
            .unwrap(),
        workspace
    );
    service.shutdown().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn browser_inventory_is_shared_and_rejects_worktree_selectors() {
    let (root, store, service) = fixture().await;
    register(&store, "workspace:one", root.path(), 1).await;
    register(&store, "workspace:two", root.path(), 1).await;
    let listed = service
        .dispatch(&store, &json!({"kind":"list"}))
        .await
        .unwrap();
    assert_eq!(listed["result"]["workspace_id"], "workspace:dure-browser");
    assert_eq!(listed["result"]["resources"], json!([]));
    for request in [
        json!({"kind":"workspaces"}),
        json!({"kind":"list","workspace_id":"workspace:one"}),
        json!({"kind":"list","workspace_path":root.path()}),
        json!({"kind":"create","workspace_id":"workspace:one","operation_id":"removed:id"}),
        json!({"kind":"create","workspace_path":root.path(),"operation_id":"removed:path"}),
    ] {
        let rejected = service.dispatch(&store, &request).await.unwrap_err();
        assert_eq!(rejected.code, "browser_request_invalid");
    }
    service.shutdown().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn personal_browsing_refuses_conflicting_workspace_ownership() {
    let (root, store, service) = fixture().await;
    register(&store, "workspace:dure-browser", root.path(), 1).await;
    let id = WorkspaceIdV1::new("workspace:dure-browser").unwrap();
    let before = store.workspace(&id).await.unwrap();
    let result = service
        .dispatch(
            &store,
            &json!({"kind":"create","operation_id":"create:conflict"}),
        )
        .await;
    let after = store.workspace(&id).await.unwrap();
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(result.unwrap_err().code, "browser_workspace_unavailable");
    assert_eq!(before, after);
}
