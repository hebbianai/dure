//! OS adapter exposing local hub directories to a paired phone.

use dure_hub_protocol::folder_browser::{FolderEntry, HubFolderBrowserResult};
use std::path::{Component, Path, PathBuf};

pub fn browse(path: Option<&str>) -> HubFolderBrowserResult {
    let Some(home) = dirs::home_dir() else {
        return HubFolderBrowserResult::refused(
            "Could not find the home directory",
            "folder_unavailable",
        );
    };
    match open_directory(&home, path.map_or_else(|| home.clone(), PathBuf::from)) {
        Ok((path, entries)) => HubFolderBrowserResult::opened(path, entries),
        Err(detail) => HubFolderBrowserResult::refused(detail, "folder_unavailable"),
    }
}

pub fn create(parent: &str, name: &str) -> HubFolderBrowserResult {
    let Some(home) = dirs::home_dir() else {
        return HubFolderBrowserResult::refused(
            "Could not find the home directory",
            "folder_unavailable",
        );
    };
    create_inside(&home, parent, name)
}

/// Resolve one phone-supplied launch folder inside this account's home.
pub fn resolve(path: &str) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    resolve_inside(&home, path).map(|path| path.to_string_lossy().into_owned())
}

fn create_inside(home: &Path, parent: &str, name: &str) -> HubFolderBrowserResult {
    let Some(name) = folder_name(name) else {
        return HubFolderBrowserResult::refused(
            "The folder name cannot contain a path",
            "invalid_folder_name",
        );
    };
    let home = match std::fs::canonicalize(home) {
        Ok(home) => home,
        Err(error) => {
            return HubFolderBrowserResult::refused(error.to_string(), "folder_unavailable");
        }
    };
    let parent = match std::fs::canonicalize(parent) {
        Ok(parent) if !is_inside(&home, &parent) => {
            return HubFolderBrowserResult::refused(
                "Folders can only be created inside the home directory",
                "folder_unavailable",
            );
        }
        Ok(parent) if parent.is_dir() => parent,
        Ok(_) => {
            return HubFolderBrowserResult::refused(
                "The parent path is not a folder",
                "folder_unavailable",
            );
        }
        Err(error) => {
            return HubFolderBrowserResult::refused(error.to_string(), "folder_unavailable");
        }
    };
    let target = parent.join(name);
    match std::fs::create_dir(&target) {
        Ok(()) => {}
        // A retry after response loss stays idempotent: an existing directory
        // with the requested name is already the requested result.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && target.is_dir() => {}
        Err(error) => {
            return HubFolderBrowserResult::refused(error.to_string(), "folder_create_failed");
        }
    }
    match open_directory(&home, target) {
        Ok((path, entries)) => HubFolderBrowserResult::opened(path, entries),
        Err(detail) => HubFolderBrowserResult::refused(detail, "folder_unavailable"),
    }
}

fn folder_name(name: &str) -> Option<&str> {
    let trimmed = name.trim();
    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) if !trimmed.is_empty() => Some(trimmed),
        _ => None,
    }
}

fn is_inside(home: &Path, path: &Path) -> bool {
    path.starts_with(home)
}

fn open_directory(
    home: &Path,
    path: impl AsRef<Path>,
) -> Result<(String, Vec<FolderEntry>), String> {
    let path = resolve_inside(home, path)?;
    let home = std::fs::canonicalize(home).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(entry_path) = std::fs::canonicalize(entry.path()) else {
            continue;
        };
        if name.starts_with('.') || !entry_path.is_dir() || !is_inside(&home, &entry_path) {
            continue;
        }
        entries.push(FolderEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
        });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok((path.to_string_lossy().into_owned(), entries))
}

fn resolve_inside(home: &Path, path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let home = std::fs::canonicalize(home).map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !is_inside(&home, &path) {
        return Err("Only folders inside the home directory can be opened".to_string());
    }
    if !path.is_dir() {
        return Err("The selected path is not a folder".to_string());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browse_returns_directories_only() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(root.path().join("Bravo")).expect("dir");
        std::fs::create_dir(root.path().join("alpha")).expect("dir");
        std::fs::write(root.path().join("notes.txt"), "no").expect("file");

        let (path, entries) = open_directory(root.path(), root.path()).expect("browse");
        let result = HubFolderBrowserResult::opened(path, entries);

        assert!(result.ok);
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "Bravo"]
        );
    }

    #[test]
    fn create_rejects_path_components() {
        let root = tempfile::tempdir().expect("tempdir");
        let result = create_inside(
            root.path(),
            root.path().to_str().expect("path"),
            "../elsewhere",
        );

        assert!(!result.ok);
        assert_eq!(result.code.as_deref(), Some("invalid_folder_name"));
        assert!(!root
            .path()
            .parent()
            .expect("parent")
            .join("elsewhere")
            .exists());
    }

    #[test]
    fn create_is_idempotent_for_the_same_directory() {
        let root = tempfile::tempdir().expect("tempdir");
        let parent = root.path().to_str().expect("path");

        assert!(create_inside(root.path(), parent, "work").ok);
        assert!(create_inside(root.path(), parent, "work").ok);
    }

    #[test]
    fn browse_cannot_escape_the_home_boundary() {
        let home = tempfile::tempdir().expect("home");
        let outside = tempfile::tempdir().expect("outside");

        assert!(open_directory(home.path(), outside.path()).is_err());
        assert!(resolve_inside(home.path(), outside.path()).is_err());
    }
}
