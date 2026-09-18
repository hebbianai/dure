use super::{BackendDispatchError, DomainStore, SqliteDomainStore};
use dure_app::{ProjectIdV1, ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1};
use std::path::Path;

#[cfg(test)]
mod tests;

/// The wire identity owns browser storage only; it never denotes an agent checkout.
pub(super) const ID: &str = "workspace:dure-browser";

/// Browsing owns a private directory, independent of agent checkouts.
pub(super) async fn personal(
    store: &SqliteDomainStore,
    backend_root: &Path,
) -> Result<WorkspaceIdV1, BackendDispatchError> {
    use std::os::unix::fs::DirBuilderExt;
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
    let workspace_id = WorkspaceIdV1::new(ID).expect("static workspace identity");
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
