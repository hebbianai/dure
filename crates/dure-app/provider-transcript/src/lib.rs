//! Provider-owned transcript reads shared by desktop views, backend
//! integrations and `hmux mobile-gateway`.
//!
//! One reader, so a conversation reads the same on the server a phone asks
//! directly as on the desktop that asks for it.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
mod accounts;
mod tools;
pub use accounts::{
    ProviderStateRoots, account_profile_directories, newest_conversation_file, read_newest,
};
pub use tools::{
    MAX_TOOL_CALLS, MAX_TOOL_INPUT_BYTES, MAX_TOOL_OUTPUT_BYTES, ProviderConversationActivity,
    ProviderToolCall, ProviderToolState, ToolEvent, ToolEventParser, bounded_input,
    claude_tool_events, codex_tool_events, tool_events_for,
};

const MAX_SESSION_BYTES: u64 = 1024 * 1024;
pub const MAX_TRANSCRIPT_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TRANSCRIPT_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES: usize = 10_000;
/// The bounds of one older page (see [`activity_page_from_file`]).
pub const MAX_TRANSCRIPT_PAGE_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGE_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGE_ENTRIES: usize = 2_000;
/// The bounds of one older page that crosses a backend connection (see
/// [`read_roots_activity_page`]), whose whole response is bounded: messages
/// and tool calls together stay well inside one response even when much of
/// their text needs escaping in JSON.
const MAX_BACKEND_PAGE_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_BACKEND_PAGE_ENTRIES: usize = 1_000;
const MAX_BACKEND_PAGE_TOOL_BYTES: usize = 256 * 1024;
const MAX_BACKEND_PAGE_TOOL_CALLS: usize = 1_000;
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

/// The transcript with the tool calls between its messages (see [`tools`]).
pub fn activity_from_file(
    path: &Path,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationActivity, String> {
    activity_page_from_file(path, provider, conversation_id, None)
}

/// One page of [`activity_from_file`]: the newest records, or with `before`
/// the records that end just before an earlier page's `older_cursor`. Pages
/// are whole records and never overlap, so an older page joins the newer one
/// exactly where it stopped. An older page's calls still say how they ended
/// when their results fall just past its end.
pub fn activity_page_from_file(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    before: Option<u64>,
) -> Result<ProviderConversationActivity, String> {
    let limits = if before.is_some() {
        Limits::PAGE
    } else {
        Limits::DEFAULT
    };
    activity_window(path, provider, conversation_id, limits, before)
}

fn activity_window(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    limits: Limits,
    before: Option<u64>,
) -> Result<ProviderConversationActivity, String> {
    let (parse, tool_events) = provider_parsers(provider)?;
    let window = read_window(
        path,
        provider,
        conversation_id,
        parse,
        Some(tool_events),
        limits,
        before,
    )?;
    Ok(ProviderConversationActivity {
        transcript: window.transcript,
        tools: window.tools,
        older_cursor: window.older_cursor,
    })
}

type TurnParser = fn(&Value) -> Option<(ConversationTurnRole, String)>;

fn provider_parsers(provider: &str) -> Result<(TurnParser, ToolEventParser), String> {
    match provider {
        "claude" => Ok((claude_turn, claude_tool_events)),
        "codex" => Ok((codex_turn, codex_tool_events)),
        _ => Err("provider transcript export is unsupported".to_string()),
    }
}

#[derive(Clone, Copy)]
struct Limits {
    source: u64,
    output: usize,
    entries: usize,
    tool_bytes: usize,
    tool_calls: usize,
}

impl Limits {
    const DEFAULT: Self = Self {
        source: MAX_TRANSCRIPT_SOURCE_BYTES,
        output: MAX_TRANSCRIPT_OUTPUT_BYTES,
        entries: MAX_TRANSCRIPT_ENTRIES,
        tool_bytes: MAX_TOOL_OUTPUT_BYTES,
        tool_calls: MAX_TOOL_CALLS,
    };
    /// One older page a reader asks for on demand: small enough to answer
    /// quickly, large enough that a long conversation takes few pages.
    const PAGE: Self = Self {
        source: MAX_TRANSCRIPT_PAGE_SOURCE_BYTES,
        output: MAX_TRANSCRIPT_PAGE_OUTPUT_BYTES,
        entries: MAX_TRANSCRIPT_PAGE_ENTRIES,
        ..Self::DEFAULT
    };
    /// One older page answered across a backend connection: a [`Self::PAGE`]
    /// whose messages and calls fit one backend response.
    const BACKEND_PAGE: Self = Self {
        output: MAX_BACKEND_PAGE_OUTPUT_BYTES,
        entries: MAX_BACKEND_PAGE_ENTRIES,
        tool_bytes: MAX_BACKEND_PAGE_TOOL_BYTES,
        tool_calls: MAX_BACKEND_PAGE_TOOL_CALLS,
        ..Self::PAGE
    };
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
    read_window(
        path,
        provider,
        conversation_id,
        parse,
        None,
        Limits {
            source: source_limit,
            output: output_limit,
            entries: entry_limit,
            ..Limits::DEFAULT
        },
        None,
    )
    .map(|window| window.transcript)
}

/// One transcript record that says something a reader shows: its own message
/// and the tool events it records, at its byte offset in the file.
struct WindowRecord {
    offset: u64,
    entry: Option<ProviderTranscriptEntry>,
    tool_events: Vec<ToolEvent>,
    tool_bytes: usize,
    tool_calls: usize,
}

struct TranscriptWindow {
    transcript: ProviderConversationTranscript,
    tools: Vec<ProviderToolCall>,
    older_cursor: Option<u64>,
}

fn read_window(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    parse: TurnParser,
    tool_events: Option<ToolEventParser>,
    Limits {
        source: source_limit,
        output: output_limit,
        entries: entry_limit,
        tool_bytes: tool_byte_limit,
        tool_calls: tool_call_limit,
    }: Limits,
    before: Option<u64>,
) -> Result<TranscriptWindow, String> {
    let read_error = |error| format!("read provider transcript: {error}");
    let mut file = fs::File::open(path).map_err(read_error)?;
    let metadata = file.metadata().map_err(read_error)?;
    if !metadata.is_file() {
        return Err("provider transcript is not a regular file".to_string());
    }
    let end = before.unwrap_or(metadata.len());
    if end > metadata.len() {
        return Err("provider transcript changed since the newer page was read".to_string());
    }
    // Snapshot a bounded range, even while the provider continues appending.
    // Start one byte earlier so a record exactly on the boundary is retained.
    let start = end.saturating_sub(source_limit);
    file.seek(SeekFrom::Start(start.saturating_sub(1)))
        .map_err(read_error)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(end - start + u64::from(start > 0))
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    let (mut offset, bytes) = if start > 0 {
        // Never decode a partial JSON record or split UTF-8 code point.
        let boundary = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1);
        (start - 1 + boundary as u64, &bytes[boundary..])
    } else {
        (0, &bytes[..])
    };
    let records_start = offset;
    let mut lossless = true;
    let mut final_response = None;
    let mut records = VecDeque::<WindowRecord>::new();
    let (mut output_bytes, mut entry_count) = (0usize, 0usize);
    let (mut tool_bytes, mut tool_calls) = (0usize, 0usize);
    // Records left out at the front stay for an older page, which starts
    // where the kept ones do.
    let mut trimmed = false;
    let mut cut = records_start;
    for raw in bytes.split_inclusive(|byte| *byte == b'\n') {
        let record_offset = offset;
        offset += raw.len() as u64;
        let raw = raw.strip_suffix(b"\n").unwrap_or(raw);
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        if raw.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let line = match std::str::from_utf8(raw) {
            Ok(line) => std::borrow::Cow::Borrowed(line),
            Err(_) => {
                lossless = false;
                String::from_utf8_lossy(raw)
            }
        };
        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => {
                lossless = false;
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
        let mut entry = None;
        if let Some((role, text)) = parse(&value) {
            if role == ConversationTurnRole::User {
                final_response = None;
            }
            if !text.trim().is_empty() {
                entry = Some(ProviderTranscriptEntry { role, text });
            }
        }
        let events = tool_events.map_or_else(Vec::new, |tool_events| tool_events(&value));
        if entry.is_none() && events.is_empty() {
            continue;
        }
        let record = WindowRecord {
            offset: record_offset,
            tool_bytes: events.iter().map(tools::event_bytes).sum(),
            tool_calls: events
                .iter()
                .filter(|event| matches!(event, ToolEvent::Call { .. }))
                .count(),
            entry,
            tool_events: events,
        };
        if let Some(entry) = &record.entry {
            output_bytes += entry.text.len();
            entry_count += 1;
        }
        tool_bytes += record.tool_bytes;
        tool_calls += record.tool_calls;
        records.push_back(record);
        while output_bytes > output_limit
            || entry_count > entry_limit
            || tool_bytes > tool_byte_limit
            || tool_calls > tool_call_limit
        {
            let Some(oldest) = records.pop_front() else {
                break;
            };
            if let Some(entry) = &oldest.entry {
                output_bytes -= entry.text.len();
                entry_count -= 1;
            }
            tool_bytes -= oldest.tool_bytes;
            tool_calls -= oldest.tool_calls;
            trimmed = true;
            cut = match records.front() {
                Some(next) => next.offset,
                None => {
                    // One record larger than a whole page: no page can show
                    // it, so the next older page starts before it.
                    lossless = false;
                    oldest.offset
                }
            };
        }
    }
    if !trimmed {
        cut = records
            .front()
            .map_or(records_start, |record| record.offset);
    }
    let older_cursor = (start > 0 || trimmed).then(|| {
        // A record longer than the read window leaves no whole record in it;
        // the older page then starts inside that record.
        if cut >= end {
            lossless = false;
            start
        } else {
            cut
        }
    });
    let unchanged = before.is_some()
        || fs::metadata(path).ok().is_some_and(|after| {
            after.len() == metadata.len() && after.modified().ok() == metadata.modified().ok()
        });
    let mut entries = Vec::with_capacity(entry_count);
    let mut window = tools::ToolWindow::default();
    for record in records {
        if let Some(entry) = record.entry {
            entries.push(entry);
        }
        // A record's own text comes before the calls it makes.
        if !window.apply(record.tool_events, entries.len()) {
            lossless = false;
        }
    }
    let mut tools = window.finish(0);
    if let (Some(end), Some(tool_events)) = (before, tool_events) {
        settle_last_turn(
            &mut file,
            end,
            source_limit,
            tool_events,
            &entries,
            &mut tools,
        )
        .map_err(read_error)?;
    }
    Ok(TranscriptWindow {
        transcript: ProviderConversationTranscript {
            schema_version: 1,
            provider: provider.to_string(),
            conversation_id: conversation_id.to_string(),
            history_complete: older_cursor.is_none() && lossless && unchanged,
            final_response,
            entries,
        },
        tools,
        older_cursor,
    })
}

/// How the calls an older page's last turn left open ended. A page that ends
/// between a call and its result leaves the result to the newer page, which
/// holds no call to give it to, so the older page reads past its `end` until
/// each has ended or `source_limit` bytes, as a read settles a call whose
/// result follows a message sent while it ran. It takes nothing else from
/// those records; they stay the newer page's. A call left open in an earlier
/// turn was cut off, so nothing is read for it.
fn settle_last_turn(
    file: &mut fs::File,
    end: u64,
    source_limit: u64,
    tool_events: ToolEventParser,
    entries: &[ProviderTranscriptEntry],
    tools: &mut [ProviderToolCall],
) -> std::io::Result<()> {
    let last_turn = entries
        .iter()
        .rposition(|entry| entry.role == ConversationTurnRole::User)
        .map_or(0, |index| index + 1);
    let mut open = tools
        .iter()
        .enumerate()
        .filter(|(_, call)| {
            call.after_entries >= last_turn && call.state == ProviderToolState::Running
        })
        .map(|(index, call)| (call.call_id.clone(), index))
        .collect::<std::collections::HashMap<_, _>>();
    if open.is_empty() {
        return Ok(());
    }
    file.seek(SeekFrom::Start(end))?;
    let mut records = std::io::BufReader::new(file.take(source_limit));
    let mut raw = Vec::new();
    while !open.is_empty() {
        raw.clear();
        if records.read_until(b'\n', &mut raw)? == 0 {
            break;
        }
        // A record cut by the bound, or one still being written, is not JSON.
        let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
            continue;
        };
        for event in tool_events(&value) {
            let (ToolEvent::Call { call_id, state, .. } | ToolEvent::Result { call_id, state }) =
                event;
            if let Some(index) = open.remove(&call_id) {
                tools[index].state = state;
            }
        }
    }
    Ok(())
}

pub fn read_roots(
    claude_projects: &Path,
    codex_sessions: &Path,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    let (parse, _) = provider_parsers(provider)?;
    let path = conversation_path(claude_projects, codex_sessions, provider, conversation_id)?;
    transcript_from_file(&path, provider, conversation_id, parse)
}

/// [`read_roots`] with the tool calls between the messages.
pub fn read_roots_activity(
    claude_projects: &Path,
    codex_sessions: &Path,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationActivity, String> {
    provider_parsers(provider)?;
    let path = conversation_path(claude_projects, codex_sessions, provider, conversation_id)?;
    activity_from_file(&path, provider, conversation_id)
}

/// The older page of [`read_roots_activity`] that ends `before` a cursor an
/// earlier page named, for a client across a backend connection: it joins
/// the pages before and after it as [`activity_page_from_file`] does, and
/// carries fewer messages and calls, so that it fits one backend response.
pub fn read_roots_activity_page(
    claude_projects: &Path,
    codex_sessions: &Path,
    provider: &str,
    conversation_id: &str,
    before: u64,
) -> Result<ProviderConversationActivity, String> {
    provider_parsers(provider)?;
    let path = conversation_path(claude_projects, codex_sessions, provider, conversation_id)?;
    activity_window(
        &path,
        provider,
        conversation_id,
        Limits::BACKEND_PAGE,
        Some(before),
    )
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
        "codex" => codex_rollout(codex_sessions, conversation_id),
        _ => return Err("provider transcript export is unsupported".to_string()),
    };
    path.ok_or_else(|| "provider conversation was not found".to_string())
}

/// The rollout of a Codex conversation: the newest written of its active and
/// archived copies.
fn codex_rollout(codex_sessions: &Path, conversation_id: &str) -> Option<PathBuf> {
    let mut inspected = 0;
    let active = find_codex_conversation(codex_sessions, conversation_id, 0, &mut inspected);
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

/// The cursor an older page of [`read_roots_activity_page`] reads before to
/// end just before turn `turn_id` of a Codex conversation: the offset of the
/// `task_started` event that opens the turn, its first record in the rollout.
/// A history that shows a conversation from that turn on places its start
/// there, so that the pages before it join it exactly. `None` when the rollout
/// records no such turn, as one written before Codex named its turns.
///
/// A history that starts partway through holds the newest turns, which are at
/// the rollout's end, so the rollout is read back from there.
pub fn codex_turn_start_cursor(
    codex_sessions: &Path,
    conversation_id: &str,
    turn_id: &str,
) -> Result<Option<u64>, String> {
    if !safe_id(conversation_id) || !safe_id(turn_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let path = codex_rollout(codex_sessions, conversation_id)
        .ok_or_else(|| "provider conversation was not found".to_string())?;
    let read_error = |error| format!("read provider transcript: {error}");
    let mut file = fs::File::open(path).map_err(read_error)?;
    let opens_turn = |value: &Value| {
        value.get("type").and_then(Value::as_str) == Some("event_msg")
            && value.pointer("/payload/type").and_then(Value::as_str) == Some("task_started")
            && value.pointer("/payload/turn_id").and_then(Value::as_str) == Some(turn_id)
    };
    last_record_offset(&mut file, turn_id.as_bytes(), opens_turn).map_err(read_error)
}

/// How much of a transcript one step of [`last_record_offset`] reads.
const BACKWARD_READ_BYTES: u64 = 1024 * 1024;

/// The offset of the last record in `file` that `matches`, reading back from
/// its end. Only records that contain `needle` are decoded.
fn last_record_offset(
    file: &mut fs::File,
    needle: &[u8],
    matches: impl Fn(&Value) -> bool,
) -> std::io::Result<Option<u64>> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::other(
            "provider transcript is not a regular file",
        ));
    }
    let mut end = metadata.len();
    // The start of the earliest record read so far, whose line began before
    // `end`: it is decoded once the step before it completes it.
    let mut carried = Vec::new();
    while end > 0 {
        let start = end.saturating_sub(BACKWARD_READ_BYTES);
        let mut bytes = vec![0; (end - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut bytes)?;
        bytes.append(&mut carried);
        // Every line after the first line break is whole; before it, at the
        // file's start, so is the first.
        let whole_from = if start == 0 {
            0
        } else {
            match bytes.iter().position(|byte| *byte == b'\n') {
                Some(index) => index + 1,
                None => {
                    carried = bytes;
                    end = start;
                    continue;
                }
            }
        };
        let mut lines = Vec::new();
        let mut offset = start + whole_from as u64;
        for line in bytes[whole_from..].split_inclusive(|byte| *byte == b'\n') {
            lines.push((offset, line));
            offset += line.len() as u64;
        }
        for (offset, line) in lines.into_iter().rev() {
            if line.windows(needle.len()).any(|window| window == needle)
                && serde_json::from_slice::<Value>(line).is_ok_and(|value| matches(&value))
            {
                return Ok(Some(offset));
            }
        }
        bytes.truncate(whole_from);
        carried = bytes;
        end = start;
    }
    Ok(None)
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

pub fn bounded_suffix(path: &Path, max_bytes: u64) -> Option<String> {
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
mod tests;
