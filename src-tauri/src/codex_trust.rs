//! Prepare Codex workspace trust before a managed process can consume its first prompt.
//!
//! A trust modal accepts PTY writes but consumes them as modal input, so transport receipts
//! cannot distinguish that state. This adapter removes the modal before launch, preserves the
//! user's existing config bytes, and never overrides an existing non-trusted choice.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexWorkspaceTrust {
    Added,
    AlreadyTrusted,
    ExistingUntrusted,
}

enum CodexTrustPlan {
    Current(CodexWorkspaceTrust),
    Append(String),
}

fn normalize_workspace_path(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("codex workspace must be an absolute path".to_string());
    }
    let path = path
        .to_str()
        .ok_or_else(|| "codex workspace path is not valid Unicode".to_string())?;
    Ok(strip_windows_verbatim_prefix(path))
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{path}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

fn toml_basic_string(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '\u{0008}' => quoted.push_str("\\b"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\u{000C}' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            character if character <= '\u{001F}' || character == '\u{007F}' => {
                quoted.push_str(&format!("\\u{:04X}", character as u32));
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

fn project_header(path: &str) -> String {
    format!("[projects.{}]", toml_basic_string(path))
}

fn same_workspace_path(left: &str, right: &str) -> bool {
    let left = strip_windows_verbatim_prefix(left);
    let right = strip_windows_verbatim_prefix(right);
    let is_windows_path = |path: &str| {
        path.starts_with(r"\\")
            || (path.as_bytes().get(1) == Some(&b':')
                && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic))
    };
    if is_windows_path(&left) && is_windows_path(&right) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn existing_trust(config: &str, path: &str) -> Result<Option<CodexWorkspaceTrust>, String> {
    let parsed = toml::from_str::<toml::Value>(config)
        .map_err(|error| format!("parse Codex config.toml failed: {error}"))?;
    let Some(projects) = parsed.get("projects") else {
        return Ok(None);
    };
    let projects = projects
        .as_table()
        .ok_or_else(|| "Codex config.toml projects value must be a table".to_string())?;
    let Some(project) = projects
        .iter()
        .find_map(|(candidate, project)| same_workspace_path(candidate, path).then_some(project))
    else {
        return Ok(None);
    };
    if project.get("trust_level").and_then(toml::Value::as_str) == Some("trusted") {
        Ok(Some(CodexWorkspaceTrust::AlreadyTrusted))
    } else {
        Ok(Some(CodexWorkspaceTrust::ExistingUntrusted))
    }
}

fn trust_plan(config: &str, path: &str) -> Result<CodexTrustPlan, String> {
    if let Some(trust) = existing_trust(config, path)? {
        return Ok(CodexTrustPlan::Current(trust));
    }
    let mut next = String::with_capacity(config.len() + path.len() + 48);
    next.push_str(config);
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !next.is_empty() {
        next.push('\n');
    }
    next.push_str(&project_header(path));
    next.push_str("\ntrust_level = \"trusted\"\n");
    Ok(CodexTrustPlan::Append(next))
}

fn replace_config(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Codex config.toml has no parent directory".to_string())?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".config.toml.tmp-")
        .tempfile_in(parent)
        .map_err(|error| format!("create temporary Codex config failed: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("write Codex config.toml failed: {error}"))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("sync Codex config.toml failed: {error}"))?;
    persist_config(temporary, path)
}

#[cfg(not(windows))]
fn persist_config(temporary: tempfile::NamedTempFile, path: &Path) -> Result<(), String> {
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("replace Codex config.toml failed: {}", error.error))
}

#[cfg(windows)]
fn persist_config(temporary: tempfile::NamedTempFile, path: &Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACE_FILE_FLAGS,
    };

    let (file, source) = temporary
        .keep()
        .map_err(|error| format!("retain temporary Codex config failed: {}", error.error))?;
    drop(file);
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target_wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = unsafe {
        if path.exists() {
            ReplaceFileW(
                PCWSTR(target_wide.as_ptr()),
                PCWSTR(source_wide.as_ptr()),
                PCWSTR::null(),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        } else {
            MoveFileExW(
                PCWSTR(source_wide.as_ptr()),
                PCWSTR(target_wide.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if let Err(error) = replacement {
        let _ = std::fs::remove_file(&source);
        return Err(format!("replace Codex config.toml failed: {error}"));
    }
    Ok(())
}

pub(crate) fn ensure_workspace_trusted(
    home: &Path,
    workspace: &Path,
) -> Result<CodexWorkspaceTrust, String> {
    let workspace = normalize_workspace_path(workspace)?;
    let config_dir = home.join(".codex");
    std::fs::create_dir_all(&config_dir)
        .map_err(|error| format!("create Codex config directory failed: {error}"))?;
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(config_dir.join("config.toml.hebbian.lock"))
        .map_err(|error| format!("open Codex config lock failed: {error}"))?;
    fs2::FileExt::lock_exclusive(&lock_file)
        .map_err(|error| format!("lock Codex config failed: {error}"))?;
    let path = config_dir.join("config.toml");
    let current = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("read Codex config.toml failed: {error}")),
    };
    match trust_plan(&current, &workspace)? {
        CodexTrustPlan::Current(trust) => Ok(trust),
        CodexTrustPlan::Append(next) => {
            replace_config(&path, &next)?;
            Ok(CodexWorkspaceTrust::Added)
        }
    }
}

#[tauri::command(async)]
pub fn codex_trust_workspace(path: String) -> Result<bool, String> {
    let workspace = std::fs::canonicalize(path)
        .map_err(|error| format!("resolve Codex workspace failed: {error}"))?;
    let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
    ensure_workspace_trusted(&home, &workspace).map(|outcome| outcome == CodexWorkspaceTrust::Added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const EXISTING: &str =
        "model = \"gpt-5.6\"\n\n[projects.\"/a/b\"]\ntrust_level = \"trusted\"\n";

    fn appended(config: &str, path: &str) -> String {
        match trust_plan(config, path).unwrap() {
            CodexTrustPlan::Append(next) => next,
            CodexTrustPlan::Current(trust) => {
                panic!("expected an append plan, found {trust:?}")
            }
        }
    }

    #[test]
    fn appends_a_missing_project_without_rewriting_existing_bytes() {
        let next = appended(EXISTING, "/c/d");
        assert!(next.starts_with(EXISTING));
        assert_eq!(
            existing_trust(&next, "/c/d").unwrap(),
            Some(CodexWorkspaceTrust::AlreadyTrusted)
        );
        assert_eq!(
            existing_trust(&next, "/a/b").unwrap(),
            Some(CodexWorkspaceTrust::AlreadyTrusted)
        );
    }

    #[test]
    fn preserves_an_existing_untrusted_choice() {
        let config = "[projects.\"/a/b\"]\ntrust_level = \"untrusted\"\n";
        assert_eq!(
            existing_trust(config, "/a/b").unwrap(),
            Some(CodexWorkspaceTrust::ExistingUntrusted)
        );
        assert!(matches!(
            trust_plan(config, "/a/b").unwrap(),
            CodexTrustPlan::Current(CodexWorkspaceTrust::ExistingUntrusted)
        ));
    }

    #[test]
    fn windows_project_identity_is_ascii_case_insensitive() {
        let config = "[projects.'C:\\Repo']\ntrust_level = 'untrusted'\n";
        assert_eq!(
            existing_trust(config, r"c:\repo").unwrap(),
            Some(CodexWorkspaceTrust::ExistingUntrusted)
        );
        assert!(matches!(
            trust_plan(config, r"c:\repo").unwrap(),
            CodexTrustPlan::Current(CodexWorkspaceTrust::ExistingUntrusted)
        ));
    }

    #[test]
    fn a_non_table_projects_value_is_not_overwritten() {
        assert!(existing_trust("projects = \"custom\"\n", "/a/b").is_err());
    }

    #[test]
    fn quotes_windows_and_unusual_paths_as_toml_keys() {
        let windows = r#"C:\Users\jwan\repo"with-quote"#;
        let next = appended("", windows);
        assert_eq!(
            existing_trust(&next, windows).unwrap(),
            Some(CodexWorkspaceTrust::AlreadyTrusted)
        );
        assert!(next.contains(r#"[projects."C:\\Users\\jwan\\repo\"with-quote"]"#));
    }

    #[test]
    fn append_preserves_comments_and_crlf_bytes() {
        let existing = "# keep this comment\r\nmodel = \"gpt-5.6\"\r\n";
        let next = appended(existing, "/c/d");
        assert!(next.as_bytes().starts_with(existing.as_bytes()));
    }

    #[test]
    fn removes_windows_verbatim_prefixes_without_changing_identity() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\work\repo"),
            r"C:\work\repo"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\repo"),
            r"\\server\share\repo"
        );
    }

    #[test]
    fn ensure_atomically_replaces_an_existing_config_once() {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join(".codex");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.toml"), EXISTING).unwrap();
        let workspace = temp.path().join("workspace");
        assert_eq!(
            ensure_workspace_trusted(temp.path(), &workspace).unwrap(),
            CodexWorkspaceTrust::Added
        );
        let written = std::fs::read_to_string(config_dir.join("config.toml")).unwrap();
        assert!(written.starts_with(EXISTING));
        assert_eq!(
            ensure_workspace_trusted(temp.path(), &workspace).unwrap(),
            CodexWorkspaceTrust::AlreadyTrusted
        );
        assert_eq!(
            std::fs::read_to_string(config_dir.join("config.toml")).unwrap(),
            written
        );
        assert!(std::fs::read_dir(config_dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".config.toml.tmp-")));
    }

    #[test]
    fn absolute_path_is_the_only_identity_requirement() {
        let temp = tempfile::tempdir().unwrap();
        assert!(ensure_workspace_trusted(temp.path(), Path::new("relative/path")).is_err());
        assert!(!temp.path().join(".codex").exists());

        let unusual = temp.path().join(PathBuf::from("project-with\nnewline"));
        assert_eq!(
            ensure_workspace_trusted(temp.path(), &unusual).unwrap(),
            CodexWorkspaceTrust::Added
        );
    }
}
