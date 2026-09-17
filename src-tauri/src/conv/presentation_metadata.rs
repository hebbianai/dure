//! Exact provider-owned presentation, independent of the capped recent inventory.
//! Filesystem stamps invalidate bounded reads; they are never activity evidence.

use super::{
    codex_context_injection, codex_thread_index, codex_user_text, encode_cwd,
    safe_conversation_id, user_text,
};
use crate::usage_cache::FileStamp;
use serde::Serialize;
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

const WINDOW_BYTES: u64 = 1024 * 1024;
const PROMPT_WINDOW_BYTES: u64 = 8 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_CACHED_FILES: usize = 512;

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    title: Option<String>,
    activity_at: Option<String>,
    recent_prompts: Vec<String>,
}

struct CachedActivity {
    stamp: FileStamp,
    metadata: Metadata,
}

type CacheKey = (String, String, PathBuf);

fn cache() -> &'static Mutex<HashMap<CacheKey, CachedActivity>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, CachedActivity>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn activity_timestamp(provider: &str, value: &Value) -> Option<String> {
    let kind = value.get("type")?.as_str()?;
    let injected_context = match provider {
        "codex" => codex_user_text(value).is_some_and(|text| codex_context_injection(&text)),
        "claude" if kind == "user" => user_text(value).is_some_and(|text| {
            codex_context_injection(&text) || text.trim_start().starts_with("Caveat:")
        }),
        _ => false,
    };
    if injected_context {
        return None;
    }
    let meaningful = match provider {
        "claude" => {
            matches!(kind, "user" | "assistant")
                && value.get("isMeta").and_then(Value::as_bool) != Some(true)
        }
        "codex" => match kind {
            "response_item" => {
                matches!(
                    value.pointer("/payload/type").and_then(Value::as_str),
                    Some(
                        "message"
                            | "function_call"
                            | "function_call_output"
                            | "custom_tool_call"
                            | "custom_tool_call_output"
                    )
                ) && !matches!(
                    value.pointer("/payload/role").and_then(Value::as_str),
                    Some("system" | "developer")
                )
            }
            "event_msg" => matches!(
                value.pointer("/payload/type").and_then(Value::as_str),
                Some("user_message" | "agent_message" | "task_started" | "task_complete")
            ),
            _ => false,
        },
        _ => false,
    };
    meaningful
        .then(|| value.get("timestamp")?.as_str().map(str::to_owned))
        .flatten()
}

fn observe_line(metadata: &mut Metadata, provider: &str, line: &[u8]) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(&String::from_utf8_lossy(line)) else {
        return false;
    };
    let Some(timestamp) = activity_timestamp(provider, &value) else {
        return false;
    };
    metadata.activity_at.get_or_insert(timestamp);
    let prompt = match provider {
        "codex" => codex_user_text(&value),
        "claude" if value.get("type").and_then(Value::as_str) == Some("user") => user_text(&value),
        _ => None,
    };
    if let Some(prompt) = prompt.filter(|text| !text.trim().is_empty()) {
        metadata
            .recent_prompts
            .push(prompt.chars().take(4096).collect());
    }
    metadata.recent_prompts.len() == 8
}

fn read_activity(
    file: &mut (impl Read + Seek),
    size: u64,
    provider: &str,
    id: &str,
) -> Option<Metadata> {
    if provider == "codex" {
        file.seek(SeekFrom::Start(0)).ok()?;
        let mut header = Vec::new();
        BufReader::with_capacity(4096, (&mut *file).take(WINDOW_BYTES))
            .read_until(b'\n', &mut header)
            .ok()?;
        let header: Value = serde_json::from_str(&String::from_utf8_lossy(&header)).ok()?;
        if header.get("type").and_then(Value::as_str) != Some("session_meta")
            || header.pointer("/payload/id").and_then(Value::as_str) != Some(id)
        {
            return None;
        }
    }

    let floor = size.saturating_sub(PROMPT_WINDOW_BYTES);
    let mut end = size;
    let mut chunk = vec![0; READ_CHUNK_BYTES];
    let mut partial: Vec<Vec<u8>> = Vec::new();
    let mut metadata = Metadata::default();
    let mut saw_separator = false;
    // Read the same bounded suffix from newest to oldest, stopping as soon as
    // eight prompts are known. Keep fragments until their left line boundary is
    // found, then join with bulk copies instead of repeatedly shifting a long line.
    while end > floor {
        let start = end.saturating_sub(READ_CHUNK_BYTES as u64).max(floor);
        let length = (end - start) as usize;
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut chunk[..length]).ok()?;
        let mut fragment_end = length;
        for separator in memchr::memrchr_iter(b'\n', &chunk[..length])
            .map(Some)
            .chain(std::iter::once(None))
        {
            let fragment_start = separator.map_or(0, |offset| offset + 1);
            let fragment = &chunk[fragment_start..fragment_end];
            fragment_end = separator.unwrap_or(0);
            let has_separator = separator.is_some();
            saw_separator |= has_separator;
            if !has_separator && start > 0 {
                if !fragment.is_empty() {
                    partial.push(fragment.to_vec());
                }
                continue;
            }
            let complete = if partial.is_empty() {
                observe_line(&mut metadata, provider, fragment)
            } else {
                let mut line = Vec::with_capacity(
                    fragment.len() + partial.iter().map(Vec::len).sum::<usize>(),
                );
                line.extend_from_slice(fragment);
                for suffix in partial.drain(..).rev() {
                    line.extend_from_slice(&suffix);
                }
                observe_line(&mut metadata, provider, &line)
            };
            if complete {
                metadata.recent_prompts.reverse();
                return Some(metadata);
            }
        }
        end = start;
    }
    // As with the original bounded window, discard the cut first line even
    // when it happens to start with valid JSON. It has no proven line boundary.
    if floor > 0 && !saw_separator {
        return None;
    }
    metadata.recent_prompts.reverse();
    Some(metadata)
}

fn file_activity(provider: &str, id: &str, path: &Path) -> Option<Metadata> {
    if !path.is_file() {
        return None;
    }
    let stamp = FileStamp::of(path)?;
    let key = (provider.to_owned(), id.to_owned(), path.to_path_buf());
    if let Some(hit) = cache().lock().ok().and_then(|entries| {
        entries
            .get(&key)
            .filter(|entry| entry.stamp == stamp)
            .map(|entry| entry.metadata.clone())
    }) {
        return Some(hit);
    }
    let mut file = fs::File::open(path).ok()?;
    let metadata = read_activity(&mut file, stamp.size, provider, id)?;
    if let Ok(mut entries) = cache().lock() {
        if entries.len() >= MAX_CACHED_FILES {
            entries.clear();
        }
        entries.insert(
            key,
            CachedActivity {
                stamp,
                metadata: metadata.clone(),
            },
        );
    }
    Some(metadata)
}

pub(crate) struct MetadataTarget {
    pub(crate) provider: String,
    pub(crate) conversation_id: String,
    pub(crate) cwd: String,
    pub(crate) root: PathBuf,
}

struct CodexSource {
    titles: Arc<HashMap<String, String>>,
    database: Option<PathBuf>,
    roots: Vec<PathBuf>,
}

struct PreparedTarget {
    target: MetadataTarget,
    title: Option<String>,
    path: Option<PathBuf>,
    codex: Option<Arc<CodexSource>>,
}

fn prepare_targets(
    targets: Vec<Option<MetadataTarget>>,
    sqlite_root: Option<PathBuf>,
) -> Vec<Option<PreparedTarget>> {
    let mut sources = HashMap::<PathBuf, Arc<CodexSource>>::new();
    targets
        .into_iter()
        .map(|target| {
            let target = target?;
            if !safe_conversation_id(&target.conversation_id)
                || !matches!(target.provider.as_str(), "codex" | "claude")
            {
                return None;
            }
            let codex = (target.provider == "codex").then(|| {
                Arc::clone(sources.entry(target.root.clone()).or_insert_with(|| {
                    // Credential overlays can share a session directory and index.
                    // Preserve each profile's title source and allowed rollout roots.
                    let sessions = fs::canonicalize(target.root.join("sessions")).ok();
                    let database = sessions.as_ref().and_then(|_| {
                        fs::canonicalize(codex_thread_index::state_database_path(
                            &target.root,
                            sqlite_root.clone(),
                        ))
                        .ok()
                    });
                    let archived = sessions.as_ref().and_then(|sessions| {
                        fs::canonicalize(sessions.parent()?.join("archived_sessions")).ok()
                    });
                    Arc::new(CodexSource {
                        titles: codex_thread_index::titles(&target.root),
                        database,
                        roots: sessions.into_iter().chain(archived).collect(),
                    })
                }))
            });
            let title = codex
                .as_ref()
                .and_then(|source| source.titles.get(&target.conversation_id).cloned());
            let path = (target.provider == "claude").then(|| {
                target
                    .root
                    .join("projects")
                    .join(encode_cwd(&target.cwd))
                    .join(format!("{}.jsonl", target.conversation_id))
            });
            Some(PreparedTarget {
                target,
                title,
                path,
                codex,
            })
        })
        .collect()
}

/// One fresh query per database per poll; filesystem work stays off async
/// workers. Positional results retain profile fences even when indexes are shared.
pub(crate) async fn read_batch(
    targets: Vec<Option<MetadataTarget>>,
    sqlite_root: Option<PathBuf>,
) -> Result<Vec<Option<Metadata>>, String> {
    let mut targets = tokio::task::spawn_blocking(move || prepare_targets(targets, sqlite_root))
        .await
        .map_err(|error| format!("provider metadata preparation failed: {error}"))?;
    let mut databases = HashMap::<PathBuf, Vec<usize>>::new();
    for (index, target) in targets.iter().enumerate() {
        if let Some(database) = target
            .as_ref()
            .and_then(|target| target.codex.as_ref())
            .and_then(|source| source.database.as_ref())
        {
            databases.entry(database.clone()).or_default().push(index);
        }
    }
    for (database, indices) in databases {
        let options = SqliteConnectOptions::new()
            .filename(database)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(Duration::from_millis(100));
        let Ok(mut connection) = SqliteConnection::connect_with(&options).await else {
            continue;
        };
        let mut query =
            QueryBuilder::<Sqlite>::new("SELECT id, rollout_path FROM threads WHERE id IN (");
        {
            let mut separated = query.separated(", ");
            for index in &indices {
                if let Some(target) = &targets[*index] {
                    separated.push_bind(target.target.conversation_id.clone());
                }
            }
        }
        query.push(")");
        let Ok(rows) = query.build().fetch_all(&mut connection).await else {
            continue;
        };
        let paths: HashMap<String, String> = rows
            .into_iter()
            .filter_map(|row| Some((row.try_get("id").ok()?, row.try_get("rollout_path").ok()?)))
            .collect();
        for index in indices {
            if let Some(target) = &mut targets[index] {
                target.path = paths.get(&target.target.conversation_id).map(PathBuf::from);
            }
        }
    }
    tokio::task::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|target| {
                let target = target?;
                let path = match (&target.codex, target.path) {
                    (Some(source), Some(path)) => fs::canonicalize(path)
                        .ok()
                        .filter(|path| source.roots.iter().any(|root| path.starts_with(root))),
                    (_, path) => path,
                };
                let mut metadata = path
                    .and_then(|path| {
                        file_activity(
                            &target.target.provider,
                            &target.target.conversation_id,
                            &path,
                        )
                    })
                    .unwrap_or_default();
                metadata.title = target.title;
                Some(metadata)
            })
            .collect()
    })
    .await
    .map_err(|error| format!("provider metadata read failed: {error}"))
}

#[cfg(test)]
async fn read(
    provider: &str,
    id: &str,
    cwd: &str,
    profile_root: Option<&Path>,
    sqlite_root: Option<PathBuf>,
) -> Option<Metadata> {
    let root = match profile_root {
        Some(root) => root.to_path_buf(),
        None => super::conversation_home()
            .ok()?
            .join(format!(".{provider}")),
    };
    read_batch(
        vec![Some(MetadataTarget {
            provider: provider.into(),
            conversation_id: id.into(),
            cwd: cwd.into(),
            root,
        })],
        sqlite_root,
    )
    .await
    .ok()?
    .pop()
    .flatten()
}

#[cfg(test)]
#[path = "presentation_metadata_tests.rs"]
mod performance_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn restores_a_prompt_before_a_long_tool_response() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("thread.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"thread\"}}}}").unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"response_item", "timestamp":"2026-09-11T00:00:00Z",
            "payload":{"type":"message", "role":"user", "content":[{"type":"input_text", "text":"Deploy the fix"}]}})).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"response_item", "timestamp":"2026-09-11T00:01:00Z",
            "payload":{"type":"function_call_output", "output":"x".repeat(3 * 1024 * 1024)}})).unwrap();
        let observed = file_activity("codex", "thread", &path).unwrap();
        assert_eq!(observed.recent_prompts, vec!["Deploy the fix"]);
    }

    #[test]
    fn restores_bounded_user_prompts_from_exact_provider_files_and_invalidates_cache() {
        for provider in ["claude", "codex"] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("thread.jsonl");
            let mut file = fs::File::create(&path).unwrap();
            if provider == "codex" {
                writeln!(file, "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"thread\"}}}}").unwrap();
            }
            let message = |text: &str| {
                if provider == "codex" {
                    serde_json::json!({"type":"event_msg", "timestamp":"2026-09-11T00:00:00Z",
                        "payload":{"type":"user_message", "message":text}})
                } else {
                    serde_json::json!({"type":"user", "timestamp":"2026-09-11T00:00:00Z",
                        "message":{"content":text}})
                }
            };
            for index in 0..10 {
                writeln!(file, "{}", message(&format!("Prompt {index}"))).unwrap();
            }
            writeln!(file, "{}", message("# AGENTS.md instructions for /repo")).unwrap();
            let first = file_activity(provider, "thread", &path).unwrap();
            assert_eq!(first.recent_prompts, (2..10).map(|index| format!("Prompt {index}")).collect::<Vec<_>>());
            assert_eq!(file_activity(provider, "thread", &path), Some(first));
            writeln!(file, "{}", message(&"한".repeat(5000))).unwrap();
            let next = file_activity(provider, "thread", &path).unwrap();
            assert_eq!(next.recent_prompts.len(), 8);
            assert_eq!(next.recent_prompts.last().unwrap(), &"한".repeat(4096));
            assert!(serde_json::to_value(next).unwrap()["recentPrompts"].is_array());
        }
    }

    #[test]
    fn startup_context_and_provider_initialization_are_not_activity() {
        let codex = serde_json::json!({
            "type": "response_item", "timestamp": "2026-09-05T13:00:00Z",
            "payload": {"type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "# AGENTS.md instructions for /repo"}]},
        });
        assert_eq!(activity_timestamp("codex", &codex), None);
        let claude = serde_json::json!({
            "type": "user", "timestamp": "2026-09-05T13:00:00Z", "isMeta": true,
            "message": {"content": "Bridge initialization"},
        });
        assert_eq!(activity_timestamp("claude", &claude), None);
    }

    #[test]
    fn metadata_only_changes_never_advance_activity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("thread.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-03T00:46:00Z\"}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-09-03T00:47:09.463Z\"}\n",
            ),
        )
        .unwrap();
        let expected = Some("2026-09-03T00:47:09.463Z".to_string());
        assert_eq!(file_activity("claude", "thread", &path).and_then(|metadata| metadata.activity_at), expected);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{{\"type\":\"custom-title\",\"timestamp\":\"2026-09-05T12:47:36Z\"}}"
        )
        .unwrap();
        writeln!(file, "{{\"type\":\"system\",\"subtype\":\"local_command\",\"timestamp\":\"2026-09-05T12:48:00Z\"}}").unwrap();
        assert_eq!(file_activity("claude", "thread", &path).and_then(|metadata| metadata.activity_at), expected);
        assert_eq!(file_activity("claude", "thread", &path).and_then(|metadata| metadata.activity_at), expected);
        fs::write(
            &path,
            "{\"type\":\"bridge-session\",\"timestamp\":\"2026-09-05T13:00:00Z\"}\n",
        )
        .unwrap();
        assert_eq!(file_activity("claude", "thread", &path).and_then(|metadata| metadata.activity_at), None);
    }

    #[tokio::test]
    async fn exact_codex_index_lookup_ignores_inventory_size_and_bounds_large_transcripts() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let sessions = root.join("sessions");
        fs::create_dir(&sessions).unwrap();
        for index in 0..250 {
            fs::write(sessions.join(format!("old-{index}.jsonl")), "{}").unwrap();
        }
        let path = sessions.join("target.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"target\"}}}}"
        )
        .unwrap();
        // A sparse multi-GiB transcript proves that only bounded windows are read.
        file.seek(SeekFrom::Start(3 * 1024 * 1024 * 1024)).unwrap();
        writeln!(file, "\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"agent_message\"}},\"timestamp\":\"2026-09-05T13:39:18.095Z\"}}").unwrap();
        writeln!(file, "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"target\"}},\"timestamp\":\"2026-09-05T14:00:00Z\"}}").unwrap();
        let options = SqliteConnectOptions::new()
            .filename(root.join("state_5.sqlite"))
            .create_if_missing(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO threads VALUES (?, ?)")
            .bind("target")
            .bind(path.to_string_lossy().as_ref())
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        let observed = read("codex", "target", "/unused", Some(root), None)
            .await
            .unwrap();
        assert_eq!(
            observed.activity_at.as_deref(),
            Some("2026-09-05T13:39:18.095Z")
        );
        assert_eq!(file_activity("codex", "different-id", &path), None);
        assert!(read("codex", "../target", "/unused", Some(root), None)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn claude_reads_only_the_exact_workspace_and_profile() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let project = root.join("projects").join(encode_cwd("/repo/worktree"));
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("thread.jsonl"),
            "{\"type\":\"assistant\",\"timestamp\":\"2026-09-03T00:47:09Z\"}\n",
        )
        .unwrap();
        assert_eq!(
            read("claude", "thread", "/repo/worktree", Some(root), None)
                .await
                .unwrap()
                .activity_at
                .as_deref(),
            Some("2026-09-03T00:47:09Z")
        );
        assert_eq!(
            read("claude", "thread", "/different", Some(root), None)
                .await
                .unwrap()
                .activity_at,
            None
        );
    }
}
