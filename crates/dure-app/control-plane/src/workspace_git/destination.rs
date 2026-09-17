use super::{Path, PathBuf, WorkspaceFailure, is_exact_directory};

const WORKTREE_ROOT: &str = ".worktrees";

pub(super) fn prepare_workspace_destination(
    project_root: &Path,
    directory_name: &str,
    checkout_path: Option<&str>,
) -> Result<PathBuf, WorkspaceFailure> {
    match checkout_path {
        Some(path) => prepare_destination(Path::new(path)),
        None => {
            ensure_worktree_root(project_root)?;
            Ok(dedicated_path(project_root, directory_name))
        }
    }
}

pub(super) fn resolve_workspace_destination(
    project_root: &Path,
    directory_name: &str,
    checkout_path: Option<&str>,
) -> Result<PathBuf, WorkspaceFailure> {
    match checkout_path {
        Some(path) => canonical_destination(Path::new(path)),
        None => Ok(dedicated_path(project_root, directory_name)),
    }
}

pub(super) fn dedicated_path(project_root: &Path, directory_name: &str) -> PathBuf {
    project_root.join(WORKTREE_ROOT).join(directory_name)
}

fn prepare_destination(target: &Path) -> Result<PathBuf, WorkspaceFailure> {
    let parent = target
        .parent()
        .ok_or_else(|| WorkspaceFailure::new("workspace_path_invalid"))?;
    std::fs::create_dir_all(parent)
        .map_err(|_| WorkspaceFailure::new("workspace_root_create_failed"))?;
    canonical_destination(target)
}

/// Resolve only the parent: the final component must remain observable as an
/// absent, partial, registered or replaced checkout by the shared Git authority.
fn canonical_destination(target: &Path) -> Result<PathBuf, WorkspaceFailure> {
    let parent = target
        .parent()
        .ok_or_else(|| WorkspaceFailure::new("workspace_path_invalid"))?;
    let name = target
        .file_name()
        .ok_or_else(|| WorkspaceFailure::new("workspace_path_invalid"))?;
    std::fs::canonicalize(parent)
        .map(|parent| parent.join(name))
        .map_err(|_| WorkspaceFailure::new("workspace_root_unavailable"))
}

pub(super) fn ensure_worktree_root(project_root: &Path) -> Result<(), WorkspaceFailure> {
    let root = project_root.join(WORKTREE_ROOT);
    match std::fs::symlink_metadata(&root) {
        Ok(_) if is_exact_directory(&root) => Ok(()),
        Ok(_) => Err(WorkspaceFailure::new("workspace_root_unsafe")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&root)
                .map_err(|_| WorkspaceFailure::new("workspace_root_create_failed"))?;
            let metadata = std::fs::symlink_metadata(&root)
                .map_err(|_| WorkspaceFailure::new("workspace_root_create_failed"))?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() && is_exact_directory(&root)
            {
                Ok(())
            } else {
                Err(WorkspaceFailure::new("workspace_root_unsafe"))
            }
        }
        Err(_) => Err(WorkspaceFailure::new("workspace_root_unavailable")),
    }
}
