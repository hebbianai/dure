use super::{BackendDispatchError, DomainStore, SqliteDomainStore, require_development};
use dure_app::{
    DomainStoreErrorV1, ProjectIdV1, ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use serde_json::{Value, json};
use std::path::Path;

#[cfg(test)]
mod tests;

/// Ordinary browsing owns a private directory, independent of agent checkouts.
pub(super) async fn personal(
    store: &SqliteDomainStore,
    backend_root: &Path,
) -> Result<WorkspaceIdV1, BackendDispatchError> {
    use std::os::unix::fs::DirBuilderExt;
    require_development()?;
    let unavailable = || BackendDispatchError::terminal("browser_workspace_unavailable");
    let directory = backend_root.join("browser-workspace");
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(unavailable()),
    }
    crate::assert_owner_directory(&directory).map_err(|_| unavailable())?;
    let root_path = directory.to_str().ok_or_else(unavailable)?.to_owned();
    let project_id = ProjectIdV1::new("project:dure-browser").expect("static project identity");
    let workspace_id =
        WorkspaceIdV1::new("workspace:dure-browser").expect("static workspace identity");
    let project = store
        .project(&project_id)
        .await
        .map_err(|_| unavailable())?;
    let workspace = store
        .workspace(&workspace_id)
        .await
        .map_err(|_| unavailable())?;
    if project
        .as_ref()
        .is_some_and(|row| row.root_path != root_path)
        || workspace
            .as_ref()
            .is_some_and(|row| row.root_path != root_path || row.project_id != project_id)
    {
        return Err(unavailable());
    }
    let now = super::now_ms().map_err(|_| unavailable())?;
    if project.is_none() {
        store
            .upsert_project(&ProjectRecordV1 {
                project_id: project_id.clone(),
                root_path: root_path.clone(),
                display_name: "Browser".into(),
                created_at_ms: now,
                updated_at_ms: now,
            })
            .await
            .map_err(|_| unavailable())?;
    }
    if workspace.is_none() {
        store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id,
                root_path,
                base_commit_sha: None,
                created_at_ms: now,
                updated_at_ms: now,
            })
            .await
            .map_err(|_| unavailable())?;
    }
    Ok(workspace_id)
}

pub(super) async fn resolve(
    store: &SqliteDomainStore,
    workspace_id: Option<WorkspaceIdV1>,
    workspace_path: Option<String>,
) -> Result<WorkspaceIdV1, BackendDispatchError> {
    let path = match (workspace_id, workspace_path) {
        (Some(id), None) => return Ok(id),
        (None, Some(path)) => path,
        _ => {
            return Err(BackendDispatchError::terminal(
                "browser_workspace_selector_invalid",
            ));
        }
    };
    require_development()?;
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || !Path::new(&path).is_absolute()
    {
        return Err(BackendDispatchError::terminal(
            "browser_workspace_path_invalid",
        ));
    }
    let snapshot = store
        .workspace_resolution_snapshot()
        .await
        .map_err(|error| {
            let code = if matches!(
                error,
                DomainStoreErrorV1::Storage {
                    code: "workspace_resolution_limit",
                    ..
                }
            ) {
                "browser_workspace_catalog_limit"
            } else {
                "browser_workspace_catalog_unavailable"
            };
            BackendDispatchError::terminal(code)
        })?;
    tokio::task::spawn_blocking(move || select_path(&path, snapshot))
        .await
        .map_err(|_| BackendDispatchError::terminal("browser_workspace_catalog_unavailable"))?
}

fn select_path(
    path: &str,
    snapshot: Vec<WorkspaceRecordV1>,
) -> Result<WorkspaceIdV1, BackendDispatchError> {
    let path = std::fs::canonicalize(path)
        .map_err(|_| BackendDispatchError::terminal("browser_workspace_path_invalid"))?;
    if !path.is_dir() {
        return Err(BackendDispatchError::terminal(
            "browser_workspace_path_invalid",
        ));
    }
    let mut selected = None;
    let mut depth = 0;
    let mut ambiguous = false;
    for workspace in snapshot {
        if !Path::new(&workspace.root_path).is_absolute() {
            return Err(BackendDispatchError::terminal(
                "browser_workspace_catalog_unavailable",
            ));
        }
        let root = match std::fs::canonicalize(&workspace.root_path) {
            Ok(root) => root,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                continue;
            }
            Err(_) => {
                return Err(BackendDispatchError::terminal(
                    "browser_workspace_catalog_unavailable",
                ));
            }
        };
        if !path.starts_with(&root) || !root.is_dir() {
            continue;
        }
        let candidate_depth = root.components().count();
        if candidate_depth > depth {
            selected = Some(workspace.workspace_id);
            depth = candidate_depth;
            ambiguous = false;
        } else if candidate_depth == depth {
            ambiguous = true;
        }
    }
    if ambiguous {
        return Err(BackendDispatchError::terminal(
            "browser_workspace_ambiguous",
        ));
    }
    selected.ok_or_else(|| BackendDispatchError::terminal("browser_workspace_missing"))
}

pub(super) async fn list(
    store: &SqliteDomainStore,
    after: Option<&WorkspaceIdV1>,
) -> Result<Value, BackendDispatchError> {
    require_development()?;
    let (workspaces, next) = store
        .workspace_page(after)
        .await
        .map_err(|_| BackendDispatchError::terminal("browser_workspace_catalog_unavailable"))?;
    let mut rows = Vec::with_capacity(workspaces.len());
    for workspace in workspaces {
        let project = store
            .project(&workspace.project_id)
            .await
            .map_err(|_| BackendDispatchError::terminal("browser_workspace_catalog_unavailable"))?
            .ok_or_else(|| BackendDispatchError::terminal("browser_workspace_project_missing"))?;
        rows.push(json!({"workspace_id":workspace.workspace_id,"project_name":project.display_name,"root_path":workspace.root_path}));
    }
    Ok(json!({"workspaces":rows,"next":next}))
}
