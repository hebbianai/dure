use super::*;
use crate::browser_service::BrowserService;
use dure_app::{ProjectIdV1, ProjectRecordV1, WorkspaceRecordV1};
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

async fn selected(
    service: &BrowserService,
    store: &SqliteDomainStore,
    path: &Path,
) -> Result<Value, BackendDispatchError> {
    service
        .dispatch(store, &json!({"kind":"list","workspace_path":path}))
        .await
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
async fn nested_directory_uses_the_deepest_workspace_and_preserves_explicit_ids() {
    let (root, store, service) = fixture().await;
    let child = root.path().join("child");
    let nested = child.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    register(&store, "workspace:parent", root.path(), 1).await;
    register(&store, "workspace:child", &child, 1).await;
    let result = selected(&service, &store, &nested).await;
    let explicit = service
        .dispatch(
            &store,
            &json!({"kind":"list","workspace_id":"workspace:parent"}),
        )
        .await;
    service.shutdown().await.unwrap();
    store.close().await;
    let result = result.unwrap();
    assert_eq!(result["result"]["workspace_id"], "workspace:child");
    assert_eq!(result["result"]["resources"], json!([]));
    assert_eq!(explicit.unwrap()["result"]["resources"], json!([]));
}

#[tokio::test]
async fn sibling_prefix_is_not_a_workspace_match() {
    let (root, store, service) = fixture().await;
    let child = root.path().join("task");
    let sibling = root.path().join("task-other");
    std::fs::create_dir(&child).unwrap();
    std::fs::create_dir(&sibling).unwrap();
    register(&store, "workspace:child", &child, 1).await;
    let result = selected(&service, &store, &sibling).await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(result.unwrap_err().code, "browser_workspace_missing");
}

#[tokio::test]
async fn duplicate_deepest_roots_are_ambiguous_even_with_a_parent_candidate() {
    let (root, store, service) = fixture().await;
    let child = root.path().join("child");
    std::fs::create_dir(&child).unwrap();
    register(&store, "workspace:parent", root.path(), 1).await;
    register(&store, "workspace:one", &child, 1).await;
    register(&store, "workspace:two", &child, 1).await;
    let result = selected(&service, &store, &child).await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(result.unwrap_err().code, "browser_workspace_ambiguous");
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_spellings_use_the_same_directory_and_expose_duplicate_identity() {
    let (root, store, service) = fixture().await;
    let child = root.path().join("child");
    let alias = root.path().join("alias");
    std::fs::create_dir(&child).unwrap();
    std::os::unix::fs::symlink(&child, &alias).unwrap();
    register(&store, "workspace:one", &alias, 1).await;
    let resolved = selected(&service, &store, &child).await;
    register(&store, "workspace:two", &child, 1).await;
    let duplicate = selected(&service, &store, &alias).await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(resolved.unwrap()["result"]["workspace_id"], "workspace:one");
    assert_eq!(duplicate.unwrap_err().code, "browser_workspace_ambiguous");
}

#[tokio::test]
async fn changed_workspace_roots_are_read_again_instead_of_using_a_cached_choice() {
    let (root, store, service) = fixture().await;
    let child = root.path().join("child");
    let moved = root.path().join("moved");
    std::fs::create_dir(&child).unwrap();
    std::fs::create_dir(&moved).unwrap();
    register(&store, "workspace:parent", root.path(), 1).await;
    register(&store, "workspace:child", &child, 1).await;
    let before = selected(&service, &store, &child).await;
    register(&store, "workspace:child", &moved, 2).await;
    let after = selected(&service, &store, &child).await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(before.unwrap()["result"]["workspace_id"], "workspace:child");
    assert_eq!(after.unwrap()["result"]["workspace_id"], "workspace:parent");
}

#[tokio::test]
async fn missing_input_and_conflicting_selectors_cannot_fall_back_to_another_workspace() {
    let (root, store, service) = fixture().await;
    register(&store, "workspace:parent", root.path(), 1).await;
    let missing = selected(&service, &store, &root.path().join("missing")).await;
    let conflicting = service
        .dispatch(
            &store,
            &json!({"kind":"list","workspace_id":"workspace:parent","workspace_path":root.path()}),
        )
        .await;
    let neither = service.dispatch(&store, &json!({"kind":"list"})).await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(missing.unwrap_err().code, "browser_workspace_path_invalid");
    assert_eq!(
        conflicting.unwrap_err().code,
        "browser_workspace_selector_invalid"
    );
    assert_eq!(
        neither.unwrap_err().code,
        "browser_workspace_selector_invalid"
    );
}

#[tokio::test]
async fn removed_workspace_roots_do_not_hide_a_valid_parent_and_files_cannot_be_context() {
    let (root, store, service) = fixture().await;
    register(&store, "workspace:parent", root.path(), 1).await;
    register(&store, "workspace:removed", &root.path().join("removed"), 1).await;
    let directory = selected(&service, &store, root.path()).await;
    let file = selected(&service, &store, &root.path().join("state.sqlite3")).await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(
        directory.unwrap()["result"]["workspace_id"],
        "workspace:parent"
    );
    assert_eq!(file.unwrap_err().code, "browser_workspace_path_invalid");
}

#[cfg(unix)]
#[tokio::test]
async fn an_unresolvable_root_cannot_silently_fall_back_to_another_candidate() {
    let (root, store, service) = fixture().await;
    let cycle = root.path().join("cycle");
    std::os::unix::fs::symlink(&cycle, &cycle).unwrap();
    register(&store, "workspace:parent", root.path(), 1).await;
    register(&store, "workspace:unknown", &cycle, 1).await;
    let result = selected(&service, &store, root.path()).await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(
        result.unwrap_err().code,
        "browser_workspace_catalog_unavailable"
    );
}

#[tokio::test]
async fn resolution_refuses_a_truncated_catalog_while_explicit_ids_remain_usable() {
    let (root, store, service) = fixture().await;
    let pool = sqlx::SqlitePool::connect(&format!(
        "sqlite:{}",
        root.path().join("state.sqlite3").display()
    ))
    .await
    .unwrap();
    sqlx::query("WITH RECURSIVE counter(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM counter WHERE n < 10000) INSERT INTO workspaces (workspace_id, project_id, root_path, created_at_ms, updated_at_ms) SELECT 'workspace:' || n, 'project:context', ?1, 1, 1 FROM counter")
        .bind(root.path().to_str().unwrap()).execute(&pool).await.unwrap();
    pool.close().await;
    let inferred = selected(&service, &store, root.path()).await;
    let explicit = service
        .dispatch(&store, &json!({"kind":"list","workspace_id":"workspace:0"}))
        .await;
    service.shutdown().await.unwrap();
    store.close().await;
    assert_eq!(
        inferred.unwrap_err().code,
        "browser_workspace_catalog_limit"
    );
    assert_eq!(explicit.unwrap()["result"]["workspace_id"], "workspace:0");
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
