//! Provider-owned transcript reads shared by desktop views and backend integrations.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Seek, SeekFrom},
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
    transcript_window(
        path,
        provider,
        conversation_id,
        parse,
        MAX_TRANSCRIPT_SOURCE_BYTES,
        MAX_TRANSCRIPT_OUTPUT_BYTES,
        MAX_TRANSCRIPT_ENTRIES,
    )
}

fn transcript_window(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    parse: fn(&Value) -> Option<(ConversationTurnRole, String)>,
    source_limit: u64,
    output_limit: usize,
    entry_limit: usize,
) -> Result<ProviderConversationTranscript, String> {
    let read_error = |error| format!("read provider transcript: {error}");
    let mut file = fs::File::open(path).map_err(read_error)?;
    let before = file.metadata().map_err(read_error)?;
    if !before.is_file() {
        return Err("provider transcript is not a regular file".to_string());
    }
    // Snapshot a bounded suffix, even while the provider continues appending.
    // Start one byte earlier so a record exactly on the boundary is retained.
    let start = before.len().saturating_sub(source_limit);
    file.seek(SeekFrom::Start(start.saturating_sub(1)))
        .map_err(read_error)?;
    let mut bytes = Vec::new();
    file.take(before.len().min(source_limit + u64::from(start > 0)))
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    let bytes = if start > 0 {
        // Never decode a partial JSON record or split UTF-8 code point.
        let boundary = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1);
        &bytes[boundary..]
    } else {
        &bytes[..]
    };
    let utf8_complete = std::str::from_utf8(bytes).is_ok();
    let content = String::from_utf8_lossy(bytes);
    let mut entries = VecDeque::new();
    let mut output_bytes = 0usize;
    let mut history_complete = start == 0 && utf8_complete;
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
        entries.push_back(entry);
        while output_bytes > output_limit || entries.len() > entry_limit {
            if let Some(oldest) = entries.pop_front() {
                output_bytes -= oldest.text.len();
                history_complete = false;
            }
        }
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
        entries: entries.into(),
    })
}

pub fn read_roots(
    claude_projects: &Path,
    codex_sessions: &Path,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    let parse = match provider {
        "claude" => claude_turn as fn(&Value) -> Option<(ConversationTurnRole, String)>,
        "codex" => codex_turn,
        _ => return Err("provider transcript export is unsupported".to_string()),
    };
    let path = conversation_path(claude_projects, codex_sessions, provider, conversation_id)?;
    transcript_from_file(&path, provider, conversation_id, parse)
}

fn conversation_path(
    claude_projects: &Path,
    codex_sessions: &Path,
    provider: &str,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    if !safe_id(conversation_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let path = match provider {
        "claude" => {
            find_claude_conversation(claude_projects, conversation_id).map(|(_, path)| path)
        }
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
            [active, archived]
                .into_iter()
                .flatten()
                .max_by_key(|(modified, _)| *modified)
                .map(|(_, path)| path)
        }
        _ => return Err("provider transcript export is unsupported".to_string()),
    };
    path.ok_or_else(|| "provider conversation was not found".to_string())
}

/// The model and reasoning effort a conversation's latest main-thread turn
/// ran with, exactly as its provider recorded them.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderSessionSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// The latest turn sits at the end of a transcript, so a bounded suffix
/// suffices without reading a long conversation's whole history.
const MAX_SESSION_SETTINGS_SOURCE_BYTES: u64 = 8 * 1024 * 1024;

/// Read the settings the conversation's latest turn ran with. A provider keeps
/// an in-session model or effort change only in the running account's own
/// configuration, or only in the session, so a relaunch cannot recover it
/// from configuration. Both providers record it on every turn instead.
pub fn read_session_settings_roots(
    claude_projects: &Path,
    codex_sessions: &Path,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderSessionSettings, String> {
    let parse = match provider {
        "claude" => claude_turn_settings as fn(&Value) -> Option<ProviderSessionSettings>,
        "codex" => codex_turn_settings,
        _ => return Err("provider session settings are unsupported".to_string()),
    };
    let path = conversation_path(claude_projects, codex_sessions, provider, conversation_id)?;
    let content = bounded_suffix(&path, MAX_SESSION_SETTINGS_SOURCE_BYTES)
        .ok_or_else(|| "read provider transcript".to_string())?;
    Ok(content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|value| parse(&value))
        .unwrap_or_default())
}

fn bounded_suffix(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    // Start one byte earlier so a record exactly on the boundary is retained.
    let start = metadata.len().saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start.saturating_sub(1))).ok()?;
    let mut bytes = Vec::new();
    file.take(max_bytes + u64::from(start > 0))
        .read_to_end(&mut bytes)
        .ok()?;
    let bytes = if start > 0 {
        // Never decode a partial JSON record or split UTF-8 code point.
        let boundary = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1);
        &bytes[boundary..]
    } else {
        &bytes[..]
    };
    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn recorded_setting(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|setting| !setting.trim().is_empty())
        .map(str::to_owned)
}

fn claude_turn_settings(value: &Value) -> Option<ProviderSessionSettings> {
    // Subagent sidechains, synthetic replies and API errors did not run the
    // session's own selection.
    if value.get("type").and_then(Value::as_str) != Some("assistant")
        || value.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || value.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true)
        || value.pointer("/message/model").and_then(Value::as_str) == Some("<synthetic>")
    {
        return None;
    }
    // `requestedModel` keeps the selected spelling, including a context-window
    // suffix that the API-reported `message.model` omits.
    Some(ProviderSessionSettings {
        model: recorded_setting(value.get("requestedModel")),
        effort: recorded_setting(value.get("effort")),
    })
}

fn codex_turn_settings(value: &Value) -> Option<ProviderSessionSettings> {
    if value.get("type").and_then(Value::as_str) != Some("turn_context") {
        return None;
    }
    let payload = value.get("payload")?;
    // Plan mode runs at its own configured effort, not the session's.
    if payload
        .pointer("/collaboration_mode/mode")
        .and_then(Value::as_str)
        == Some("plan")
    {
        return None;
    }
    Some(ProviderSessionSettings {
        model: recorded_setting(payload.get("model")),
        effort: recorded_setting(
            payload
                .get("effort")
                .or_else(|| payload.get("reasoning_effort")),
        ),
    })
}

/// Resolve exact history in the selected account's namespace without copying
/// credentials or project files. Claude's supported --resume UUID search crosses
/// project directories (2.1.223+); ambiguous duplicates cannot authorize a move.
pub fn preflight_project_move_history(
    provider_id: &str,
    profile_directory: Option<PathBuf>,
    conversation: &str,
) -> Result<(), &'static str> {
    if !safe_id(conversation) {
        return Err("agent_project_move_history_unavailable");
    }
    let directory = match provider_id {
        "codex" => ".codex",
        "claude" => ".claude",
        _ => return Err("agent_project_move_provider_history_unsupported"),
    };
    let home = profile_directory
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(directory))
        })
        .ok_or("agent_project_move_history_unavailable")?;
    if provider_id == "claude" {
        return preflight_claude_project_move_history(&home.join("projects"), conversation);
    }
    if find_codex_conversation(&home.join("sessions"), conversation, 0, &mut 0).is_none() {
        return Err("agent_project_move_history_unavailable");
    }
    Ok(())
}

fn preflight_claude_project_move_history(
    projects: &Path,
    conversation: &str,
) -> Result<(), &'static str> {
    let mut found = None;
    let entries = fs::read_dir(projects).map_err(|_| "agent_project_move_history_unavailable")?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_TRANSCRIPT_DISCOVERY_ENTRIES {
            return Err("agent_project_move_history_unavailable");
        }
        let entry = entry.map_err(|_| "agent_project_move_history_unavailable")?;
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path().join(format!("{conversation}.jsonl"));
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("agent_project_move_history_unavailable"),
        };
        if !metadata.is_file() {
            return Err("agent_project_move_history_unavailable");
        }
        if found.replace(path).is_some() {
            return Err("agent_project_move_history_ambiguous");
        }
    }
    let path = found.ok_or("agent_project_move_history_unavailable")?;
    if !bounded_prefix(&path, MAX_SESSION_BYTES).is_some_and(|prefix| {
        prefix
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|value| {
                value.get("sessionId").and_then(Value::as_str) == Some(conversation)
                    && matches!(
                        value.get("type").and_then(Value::as_str),
                        Some("user" | "assistant")
                    )
            })
    }) {
        return Err("agent_project_move_history_unavailable");
    }
    Ok(())
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
