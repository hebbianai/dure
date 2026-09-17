//! Provider-owned transcript reads shared by desktop views and backend integrations.
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
const MAX_SESSION_BYTES: u64 = 1024 * 1024;
pub const MAX_TRANSCRIPT_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TRANSCRIPT_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES: usize = 10_000;
pub const MAX_TRANSCRIPT_DISCOVERY_ENTRIES: usize = 131_072;
#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationTurnRole {
    User,
    Agent,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTranscriptEntry {
    pub role: ConversationTurnRole,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConversationTranscript {
    pub schema_version: u16,
    pub provider: String,
    pub conversation_id: String,
    pub history_complete: bool,
    pub final_response: Option<String>,
    pub entries: Vec<ProviderTranscriptEntry>,
}

pub fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:+-".contains(character))
}

pub fn mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn bounded_prefix(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    fs::File::open(path)
        .ok()?
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn text_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| part.as_str())
                })
                .collect::<String>();
            (!joined.trim().is_empty()).then_some(joined)
        }
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string),
        _ => None,
    }
}

pub fn codex_content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter(|part| {
                    matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("input_text" | "output_text" | "text")
                    )
                })
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

pub fn provider_context_injection(text: &str) -> bool {
    let text = text.trim_start();
    [
        "# AGENTS.md instructions for ",
        "<system-reminder>",
        "<environment_context>",
        "<INSTRUCTIONS>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "<apps_instructions>",
        "<plugins_instructions>",
        "<skills_instructions>",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

pub fn claude_context_injection(text: &str) -> bool {
    provider_context_injection(text) || text.trim_start().starts_with("Caveat:")
}

pub fn claude_turn(value: &Value) -> Option<(ConversationTurnRole, String)> {
    let role = match value.get("type").and_then(Value::as_str) {
        Some("user") => ConversationTurnRole::User,
        Some("assistant") => ConversationTurnRole::Agent,
        _ => return None,
    };
    let text = value.pointer("/message/content").and_then(text_content)?;
    if role == ConversationTurnRole::User && claude_context_injection(&text) {
        return None;
    }
    Some((role, text))
}

pub fn codex_turn(value: &Value) -> Option<(ConversationTurnRole, String)> {
    let payload = value.get("payload").unwrap_or(value);
    if payload.get("type").and_then(Value::as_str) == Some("user_message") {
        let text = payload.get("message").and_then(Value::as_str)?.to_string();
        if provider_context_injection(&text) {
            return None;
        }
        return Some((ConversationTurnRole::User, text));
    }
    if payload.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let role = match payload.get("role").and_then(Value::as_str) {
        Some("user") => ConversationTurnRole::User,
        Some("assistant") => ConversationTurnRole::Agent,
        _ => return None,
    };
    let text = payload.get("content").and_then(codex_content_text)?;
    if role == ConversationTurnRole::User && provider_context_injection(&text) {
        return None;
    }
    Some((role, text))
}

pub fn find_claude_conversation(root: &Path, conversation_id: &str) -> Option<(PathBuf, PathBuf)> {
    let projects = fs::read_dir(root).ok()?;
    projects
        .flatten()
        .take(MAX_TRANSCRIPT_DISCOVERY_ENTRIES)
        .filter(|project| project.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|project| {
            let path = project.path().join(format!("{conversation_id}.jsonl"));
            path.is_file().then(|| (mtime(&path), project.path(), path))
        })
        .max_by_key(|(modified, _, _)| *modified)
        .map(|(_, project, path)| (project, path))
}

pub fn codex_file_has_identity(path: &Path, conversation_id: &str) -> bool {
    bounded_prefix(path, MAX_SESSION_BYTES).is_some_and(|prefix| {
        prefix
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|value| {
                value.get("type").and_then(Value::as_str) == Some("session_meta")
                    && value.pointer("/payload/id").and_then(Value::as_str) == Some(conversation_id)
            })
    })
}

pub fn find_codex_conversation(
    directory: &Path,
    conversation_id: &str,
    depth: usize,
    inspected: &mut usize,
) -> Option<(u64, PathBuf)> {
    if depth > 4 || *inspected >= MAX_TRANSCRIPT_DISCOVERY_ENTRIES {
        return None;
    }
    let entries = fs::read_dir(directory).ok()?;
    let suffix = format!("{conversation_id}.jsonl");
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in entries
        .flatten()
        .take(MAX_TRANSCRIPT_DISCOVERY_ENTRIES.saturating_sub(*inspected))
    {
        if *inspected >= MAX_TRANSCRIPT_DISCOVERY_ENTRIES {
            break;
        }
        *inspected += 1;
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let candidate = if kind.is_dir() {
            find_codex_conversation(&entry.path(), conversation_id, depth + 1, inspected)
        } else if kind.is_file()
            && entry.file_name().to_string_lossy().ends_with(&suffix)
            && codex_file_has_identity(&entry.path(), conversation_id)
        {
            Some((mtime(&entry.path()), entry.path()))
        } else {
            None
        };
        if candidate.as_ref().is_some_and(|(modified, _)| {
            best.as_ref().is_none_or(|(current, _)| modified > current)
        }) {
            best = candidate;
        }
    }
    best
}

/// Preserve explicit final markers; a tool preamble is not a final response.
pub fn provider_final_response(provider: &str, value: &Value) -> Option<String> {
    match provider {
        "claude"
            if value
                .pointer("/message/stop_reason")
                .and_then(Value::as_str)
                == Some("end_turn") =>
        {
            claude_turn(value)
                .filter(|(role, _)| *role == ConversationTurnRole::Agent)
                .map(|(_, text)| text)
        }
        "codex" => {
            let payload = value.get("payload").unwrap_or(value);
            if payload.get("type").and_then(Value::as_str) == Some("task_complete") {
                return payload
                    .get("last_agent_message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            (payload.get("phase").and_then(Value::as_str) == Some("final_answer"))
                .then(|| codex_turn(value))
                .flatten()
                .filter(|(role, _)| *role == ConversationTurnRole::Agent)
                .map(|(_, text)| text)
        }
        _ => None,
    }
}

pub fn transcript_from_file(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    parse: fn(&Value) -> Option<(ConversationTurnRole, String)>,
) -> Result<ProviderConversationTranscript, String> {
    let before =
        fs::metadata(path).map_err(|error| format!("read provider transcript: {error}"))?;
    if before.len() > MAX_TRANSCRIPT_SOURCE_BYTES {
        return Err("provider transcript exceeds the source byte limit".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("read provider transcript: {error}"))?;
    if bytes.len() > MAX_TRANSCRIPT_SOURCE_BYTES as usize {
        return Err("provider transcript exceeds the source byte limit".to_string());
    }
    let utf8_complete = std::str::from_utf8(&bytes).is_ok();
    let content = String::from_utf8_lossy(&bytes);
    let mut entries = Vec::new();
    let mut output_bytes = 0usize;
    let mut history_complete = utf8_complete;
    let mut final_response = None;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => {
                history_complete = false;
                continue;
            }
        };
        if let Some(text) =
            provider_final_response(provider, &value).filter(|text| !text.trim().is_empty())
        {
            if text.len() > MAX_TRANSCRIPT_OUTPUT_BYTES {
                return Err("provider final response exceeds the output limit".to_string());
            }
            final_response = Some(text);
        }
        let Some((role, text)) = parse(&value) else {
            continue;
        };
        if role == ConversationTurnRole::User {
            final_response = None;
        }
        if text.trim().is_empty() {
            continue;
        }
        let entry = ProviderTranscriptEntry { role, text };
        output_bytes = output_bytes.saturating_add(entry.text.len());
        if output_bytes > MAX_TRANSCRIPT_OUTPUT_BYTES || entries.len() == MAX_TRANSCRIPT_ENTRIES {
            return Err("provider transcript exceeds the output limit".to_string());
        }
        entries.push(entry);
    }
    let unchanged = fs::metadata(path).ok().is_some_and(|after| {
        after.len() == before.len() && after.modified().ok() == before.modified().ok()
    });
    Ok(ProviderConversationTranscript {
        schema_version: 1,
        provider: provider.to_string(),
        conversation_id: conversation_id.to_string(),
        history_complete: history_complete && unchanged,
        final_response,
        entries,
    })
}

pub fn read_roots(
    claude_projects: &Path,
    codex_sessions: &Path,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    if !safe_id(conversation_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let (path, parse) = match provider {
        "claude" => (
            find_claude_conversation(claude_projects, conversation_id).map(|(_, path)| path),
            claude_turn as fn(&Value) -> Option<(ConversationTurnRole, String)>,
        ),
        "codex" => {
            let mut inspected = 0;
            let active =
                find_codex_conversation(codex_sessions, conversation_id, 0, &mut inspected);
            let archived = codex_sessions
                .parent()
                .map(|root| root.join("archived_sessions"))
                .and_then(|directory| {
                    find_codex_conversation(&directory, conversation_id, 0, &mut inspected)
                });
            (
                [active, archived]
                    .into_iter()
                    .flatten()
                    .max_by_key(|(modified, _)| *modified)
                    .map(|(_, path)| path),
                codex_turn as fn(&Value) -> Option<(ConversationTurnRole, String)>,
            )
        }
        _ => return Err("provider transcript export is unsupported".to_string()),
    };
    let path = path.ok_or_else(|| "provider conversation was not found".to_string())?;
    transcript_from_file(&path, provider, conversation_id, parse)
}
