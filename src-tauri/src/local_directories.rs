use hebbian_bounded_process::{self as bounded_process, CommandSpec};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[tauri::command(async)]
pub fn list_dir(
    path: String,
    include_hidden: Option<bool>,
    mark_ignored: Option<bool>,
) -> Result<Vec<crate::gitx::DirEntry>, String> {
    crate::gitx::list_dir(
        &path,
        include_hidden.unwrap_or(false),
        mark_ignored.unwrap_or(false),
    )
}

const MAX_RESULTS: usize = 100;

fn direct_paths(query: &str) -> Result<Vec<String>, String> {
    let expanded = if query == "~" || query.starts_with("~/") {
        dirs::home_dir()
            .ok_or("Home directory is unavailable")?
            .join(query.strip_prefix("~/").unwrap_or(""))
    } else {
        PathBuf::from(query)
    };
    let mut paths = Vec::new();
    if expanded.is_dir() {
        paths.push(expanded.to_string_lossy().into_owned());
    }
    let (parent, prefix) = if query.ends_with('/') {
        (expanded.as_path(), String::new())
    } else {
        (
            expanded.parent().unwrap_or(Path::new("/")),
            expanded
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase(),
        )
    };
    let entries = std::fs::read_dir(parent).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .to_lowercase()
            .starts_with(&prefix)
            && entry.path().is_dir()
        {
            paths.push(entry.path().to_string_lossy().into_owned());
        }
    }
    paths.sort();
    paths.dedup();
    paths.truncate(MAX_RESULTS);
    Ok(paths)
}

fn spotlight_predicate(query: &str) -> String {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('*', "\\*")
        .replace('?', "\\?");
    format!("kMDItemContentType == \"public.folder\" && kMDItemFSName == \"*{escaped}*\"cd")
}

fn searchable_path(path: &Path) -> bool {
    path.components().all(|component| {
        let name = component.as_os_str().to_string_lossy();
        !name.starts_with('.')
            && !matches!(
                name.as_ref(),
                "node_modules" | "target" | "dist" | "__pycache__"
            )
    })
}

/// Name search uses the OS index; explicit paths also reach unindexed folders.
#[tauri::command(async)]
pub fn search_local_directories(query: String) -> Result<Vec<String>, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 1024 || query.contains('\0') {
        return Ok(Vec::new());
    }
    if query.starts_with('/') || query == "~" || query.starts_with("~/") {
        return direct_paths(query);
    }
    if !cfg!(target_os = "macos") {
        return Err("Name search is unavailable on this platform; enter a folder path".into());
    }
    let mut command = CommandSpec::new("/usr/bin/mdfind");
    command.args(["-0", &spotlight_predicate(query)]);
    let output = bounded_process::run(&command, Duration::from_secs(5), 2 * 1024 * 1024)
        .map_err(|error| format!("Folder search failed: {error:?}"))?;
    if !output.status.success() || output.exceeded_limit {
        return Err("Folder search was incomplete; narrow the search or enter a path".into());
    }
    let mut paths: Vec<String> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|bytes| std::str::from_utf8(bytes).ok())
        .filter(|path| {
            !path.is_empty() && searchable_path(Path::new(path)) && Path::new(path).is_dir()
        })
        .map(str::to_owned)
        .collect();
    // Repository roots precede ordinary folders even when the index has many matches.
    paths.sort_by_key(|path| (!Path::new(path).join(".git").exists(), path.clone()));
    paths.dedup();
    paths.truncate(MAX_RESULTS);
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_search_finds_a_directory_without_history_or_an_index() {
        let root = std::env::temp_dir().join(format!("dure-project-search-{}", std::process::id()));
        std::fs::create_dir_all(root.join("unseen-repository/.git")).unwrap();
        let results =
            search_local_directories(root.join("unseen").to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            results,
            vec![root
                .join("unseen-repository")
                .to_string_lossy()
                .into_owned()]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn name_search_escapes_query_syntax_and_omits_generated_worktree_paths() {
        assert_eq!(
            spotlight_predicate("a\"*?\\b"),
            "kMDItemContentType == \"public.folder\" && kMDItemFSName == \"*a\\\"\\*\\?\\\\b*\"cd"
        );
        assert!(!searchable_path(Path::new(
            "/projects/repo/.worktrees/task"
        )));
        assert!(!searchable_path(Path::new(
            "/projects/repo/node_modules/package"
        )));
        assert!(searchable_path(Path::new("/projects/repository")));
    }
}
