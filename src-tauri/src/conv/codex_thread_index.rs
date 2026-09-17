use crate::usage_cache::FileStamp;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

// Codex appends thread-name changes to this provider-owned index. Read a
// generous bounded suffix, then cache it by file fingerprint: active renames
// remain near the tail while an unchanged index costs only one metadata read.
const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHED_ROOTS: usize = 64;

pub(super) fn state_database_path(root: &Path, sqlite_root: Option<PathBuf>) -> PathBuf {
    sqlite_root
        .or_else(|| {
            fs::canonicalize(root.join("sessions"))
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf))
        })
        .unwrap_or_else(|| root.to_path_buf())
        .join("state_5.sqlite")
}

#[derive(Clone)]
struct CachedIndex {
    stamp: FileStamp,
    titles: Arc<HashMap<String, String>>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CachedIndex>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedIndex>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:+-".contains(character))
}

fn normalized_title(value: &str) -> Option<String> {
    let title = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    Some(title.chars().take(64).collect())
}

fn parse(content: &str) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    for value in content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        let Some(id) = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| safe_id(id))
        else {
            continue;
        };
        let Some(title) = value
            .get("thread_name")
            .and_then(Value::as_str)
            .and_then(normalized_title)
        else {
            continue;
        };
        // session_index.jsonl is append-only; the last valid observation for
        // one exact provider conversation is authoritative.
        titles.insert(id.to_string(), title);
    }
    titles
}

fn bounded_suffix(path: &Path, len: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let start = len.saturating_sub(MAX_INDEX_BYTES);
    file.seek(std::io::SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        let newline = content.find('\n')?;
        content.drain(..=newline);
    }
    Some(content)
}

pub(super) fn titles(root: &Path) -> Arc<HashMap<String, String>> {
    let path = root.join("session_index.jsonl");
    let Some(stamp) = FileStamp::of(&path) else {
        return Arc::new(HashMap::new());
    };
    if stamp.size == 0 {
        return Arc::new(HashMap::new());
    }
    if let Some(titles) = cache().lock().ok().and_then(|entries| {
        entries
            .get(&path)
            .filter(|cached| cached.stamp == stamp)
            .map(|cached| Arc::clone(&cached.titles))
    }) {
        return titles;
    }

    let titles = Arc::new(
        bounded_suffix(&path, stamp.size)
            .map(|content| parse(&content))
            .unwrap_or_default(),
    );
    if let Ok(mut entries) = cache().lock() {
        if entries.len() >= MAX_CACHED_ROOTS {
            entries.clear();
        }
        entries.insert(
            path,
            CachedIndex {
                stamp,
                titles: Arc::clone(&titles),
            },
        );
    }
    titles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_valid_exact_title_wins() {
        let titles = parse(
            r#"{"id":"thread-1","thread_name":"First title"}
not json
{"id":"../unsafe","thread_name":"Ignored"}
{"id":"thread-2","thread_name":"Other title"}
{"id":"thread-1","thread_name":"  clean   code  "}"#,
        );
        assert_eq!(
            titles.get("thread-1").map(String::as_str),
            Some("clean code")
        );
        assert_eq!(
            titles.get("thread-2").map(String::as_str),
            Some("Other title")
        );
        assert!(!titles.contains_key("../unsafe"));
    }
}
