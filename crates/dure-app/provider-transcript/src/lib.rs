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
    io::{BufRead, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
mod accounts;
mod backend_page;
mod claude_local_command;
mod pi;
mod tools;
mod transcript_file;
pub use accounts::{
    ProviderStateRoots, account_profile_directories, newest_conversation_file, read_newest,
};
pub use backend_page::{BackendActivityPage, ConversationRecord, Prepended};
use claude_local_command::{ClaudeLocalCommand, claude_local_command};
pub use pi::{find_pi_conversation, pi_turn};
pub use tools::{
    MAX_TOOL_CALLS, MAX_TOOL_INPUT_BYTES, MAX_TOOL_OUTPUT_BYTES, ProviderConversationActivity,
    ProviderToolCall, ProviderToolResult, ProviderToolState, ToolEvent, ToolEventParser,
    bounded_input, claude_tool_events, codex_tool_events, pi_tool_events, tool_events_for,
};
pub use transcript_file::{
    MAX_WINDOWS_DECODED_BYTES, TranscriptWindows, bounded_windows, transcript_name,
};
use transcript_file::{Tail, TranscriptFile, seek_tail};

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

/// The first `max_bytes` of a transcript's records, plain or compressed.
/// `None` when it cannot be read or holds nothing.
pub fn bounded_prefix(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = TranscriptFile::open(path).ok()?;
    if !file.metadata().is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.records_from(0)
        .ok()?
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .ok()?;
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
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

/// A user record Claude Code wrote itself, which is not the person's message:
/// what its own view leaves out (`isMeta`, such as a scheduled prompt, a
/// skill's instructions or hook feedback), a background task's notification,
/// and the marker where the person interrupted a turn. Chat's seeded history
/// (`agent-sdk-history.mjs`) follows the same rule.
fn claude_written_record(value: &Value, text: &str) -> bool {
    value.get("isMeta").and_then(Value::as_bool) == Some(true)
        || value.pointer("/origin/kind").and_then(Value::as_str) == Some("task-notification")
        || claude_interrupt_marker(text)
}

/// `[Request interrupted by user]`, or its `… for tool use]` form.
fn claude_interrupt_marker(text: &str) -> bool {
    text.trim()
        .strip_prefix("[Request interrupted by user")
        .and_then(|rest| rest.strip_suffix(']'))
        .is_some_and(|rest| !rest.contains([']', '\n']))
}

pub fn claude_turn(value: &Value) -> Option<(ConversationTurnRole, String)> {
    let role = match value.get("type").and_then(Value::as_str) {
        Some("user") => ConversationTurnRole::User,
        Some("assistant") => ConversationTurnRole::Agent,
        _ => return None,
    };
    let text = value.pointer("/message/content").and_then(text_content)?;
    if role == ConversationTurnRole::Agent {
        return Some((role, text));
    }
    if claude_context_injection(&text) || claude_written_record(value, &text) {
        return None;
    }
    match claude_local_command(&text) {
        // A command the person ran in Claude Code reads as they typed it.
        Some(ClaudeLocalCommand::Input(line)) => Some((role, line)),
        // What it printed, Claude Code wrote, like the records above.
        Some(ClaudeLocalCommand::Output) => None,
        None => Some((role, text)),
    }
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

/// The newest written rollout of Codex conversation `conversation_id` under
/// `directory`, plain or compressed, whose header names the conversation.
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
            && transcript_name(&entry.path()).is_some_and(|name| name.ends_with(&suffix))
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
        "pi" if pi::pi_final_reply(value) => pi_turn(value)
            .filter(|(role, _)| *role == ConversationTurnRole::Agent)
            .map(|(_, text)| text),
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
    activity_page_from_file(path, provider, conversation_id, ActivityPage::Newest)
}

/// Which records of a transcript one read of [`activity_page_from_file`]
/// answers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityPage {
    /// The newest records, to the transcript's end.
    Newest,
    /// The records that end just before an earlier page's `older_cursor`.
    /// Pages are whole records and never overlap, so an older page joins the
    /// newer one exactly where it stopped. An older page's calls still say
    /// how they ended when their results fall just past its end.
    Before(u64),
    /// What the provider appended since a read whose `newer_cursor` this is:
    /// the records from there to the end, with how that read's calls ended
    /// (`results`), within the newest read's bounds. A read that cannot reach
    /// back to the cursor names an `older_cursor`, and the records between
    /// are only in a whole read. A transcript with no record starting at the
    /// cursor was replaced or rewritten, and the read fails; so does a tree
    /// (Pi's), which is only read whole.
    After(u64),
}

/// One page of [`activity_from_file`].
pub fn activity_page_from_file(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    page: ActivityPage,
) -> Result<ProviderConversationActivity, String> {
    match page {
        ActivityPage::Newest => {
            activity_window(path, provider, conversation_id, Limits::DEFAULT, None, 0)
        }
        ActivityPage::Before(before) => activity_window(
            path,
            provider,
            conversation_id,
            Limits::PAGE,
            Some(before),
            0,
        ),
        ActivityPage::After(_) if follows_branch(provider) => {
            Err("provider transcript is only read whole".to_string())
        }
        ActivityPage::After(after) => activity_window(
            path,
            provider,
            conversation_id,
            Limits::DEFAULT,
            None,
            after,
        ),
    }
}

fn activity_window(
    path: &Path,
    provider: &str,
    conversation_id: &str,
    limits: Limits,
    before: Option<u64>,
    after: u64,
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
        after,
    )?;
    Ok(ProviderConversationActivity {
        transcript: window.transcript,
        tools: window.tools,
        older_cursor: window.older_cursor,
        newer_cursor: window.newer_cursor,
        results: window.results,
    })
}

pub type TurnParser = fn(&Value) -> Option<(ConversationTurnRole, String)>;

fn provider_parsers(provider: &str) -> Result<(TurnParser, ToolEventParser), String> {
    let parser = turn_parser(provider)
        .ok_or_else(|| "provider transcript export is unsupported".to_string())?;
    let tool_events = tool_events_for(provider)
        .ok_or_else(|| "provider transcript export is unsupported".to_string())?;
    Ok((parser, tool_events))
}

/// The turn parser of a provider whose transcript this crate reads.
#[must_use]
pub fn turn_parser(provider: &str) -> Option<TurnParser> {
    match provider {
        "claude" => Some(claude_turn),
        "codex" => Some(codex_turn),
        "pi" => Some(pi_turn),
        _ => None,
    }
}

/// Whether a provider's transcript is a tree whose reader shows one branch of
/// it, the conversation's, rather than every record: Pi's (see [`pi`]).
fn follows_branch(provider: &str) -> bool {
    provider == "pi"
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
        0,
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
    newer_cursor: Option<u64>,
    results: Vec<ProviderToolResult>,
}

/// The records of `path` that end by `before` (by default, its end) and start
/// no earlier than `after`, the newest first within the bounds. `after` is a
/// record's start, where the records a reader already shows end; 0 is the
/// transcript's start.
#[allow(clippy::too_many_arguments)]
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
    after: u64,
) -> Result<TranscriptWindow, String> {
    let read_error = |error| format!("read provider transcript: {error}");
    let changed = || "provider transcript changed since the newer page was read".to_string();
    let mut file = TranscriptFile::open(path).map_err(read_error)?;
    let metadata = file.metadata().clone();
    if !metadata.is_file() {
        return Err("provider transcript is not a regular file".to_string());
    }
    // Snapshot a bounded range, even while the provider continues appending.
    // It holds the byte before its start, so a record exactly on the boundary
    // is retained.
    let tail = file
        .tail(before, after, source_limit, u64::MAX)
        .map_err(read_error)?
        .ok_or_else(changed)?;
    let (start, end, bytes) = (tail.start, tail.end, tail.bytes);
    if after > end {
        return Err("provider transcript range is invalid".to_string());
    }
    // A floor inside the range is where a record starts: right after a line
    // break. Anywhere else the transcript is not the one it was measured in.
    if start == after && after > 0 && bytes.first() != Some(&b'\n') {
        return Err(changed());
    }
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
    // Just past the last record with its line break: a record the provider
    // is still writing has none yet, and the next read starts with it. A last
    // record whole without one is read here, and no newer read can tell
    // where it ends, so only a whole read follows it.
    let mut whole_through = records_start;
    let mut unterminated_tail = false;
    // In a tree, only the conversation's branch: a branch left behind is no
    // part of what the conversation says.
    let branch = follows_branch(provider)
        .then(|| pi::branch(&mut file, bytes, records_start, before))
        .transpose()?;
    let mut lossless = !branch.as_ref().is_some_and(|branch| branch.broken);
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
        let terminated = raw.last() == Some(&b'\n');
        if terminated {
            whole_through = offset;
        }
        if branch
            .as_ref()
            .is_some_and(|branch| !branch.records.contains(&record_offset))
        {
            continue;
        }
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
        unterminated_tail = !terminated;
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
    // Older records the bounds left out of the range, or, in a tree, the
    // branch's older entries. The page before a branch continues it from the
    // parent of the branch's oldest entry here, so that is where it ends.
    let more = match &branch {
        Some(branch) => {
            if branch.continues && start == 0 {
                // The parent the branch names is nowhere in the file.
                lossless = false;
            }
            branch.continues && start > after
        }
        None => start > after,
    };
    if !trimmed {
        cut = match &branch {
            Some(branch) => match branch.oldest {
                Some(oldest) => oldest,
                None if more => {
                    return Err("provider transcript branch continues before one page".to_string());
                }
                None => records_start,
            },
            None => records
                .front()
                .map_or(records_start, |record| record.offset),
        };
    }
    let older_cursor = (more || trimmed).then(|| {
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
    // A read from a floor to the end continues the read that ended there,
    // which holds the calls these results end.
    let results = if before.is_none() && after > 0 {
        window.take_earlier()
    } else {
        Vec::new()
    };
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
        newer_cursor: (before.is_none() && !follows_branch(provider) && !unterminated_tail)
            .then_some(whole_through),
        results,
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
    file: &mut TranscriptFile,
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
    let mut records = file.records_from(end)?.take(source_limit);
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

/// Where each provider keeps its conversations' transcripts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptRoots {
    pub claude_projects: PathBuf,
    pub codex_sessions: PathBuf,
    pub pi_sessions: PathBuf,
}

impl TranscriptRoots {
    /// The roots under one provider state directory, the one a backend names
    /// a provider's state with: a credential profile's directory (Claude's
    /// `CLAUDE_CONFIG_DIR`, Codex's `CODEX_HOME`) or the provider's default,
    /// `~/.claude`, `~/.codex` or `~/.pi`. Only the provider's own root is
    /// ever looked in.
    #[must_use]
    pub fn in_state_directory(home: &Path) -> Self {
        Self {
            claude_projects: home.join("projects"),
            codex_sessions: home.join("sessions"),
            pi_sessions: home.join("agent").join("sessions"),
        }
    }
}

pub fn read_roots(
    roots: &TranscriptRoots,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationTranscript, String> {
    let (parse, _) = provider_parsers(provider)?;
    let path = conversation_path(roots, provider, conversation_id)?;
    transcript_from_file(&path, provider, conversation_id, parse)
}

/// [`read_roots`] with the tool calls between the messages.
pub fn read_roots_activity(
    roots: &TranscriptRoots,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderConversationActivity, String> {
    provider_parsers(provider)?;
    let path = conversation_path(roots, provider, conversation_id)?;
    activity_from_file(&path, provider, conversation_id)
}

/// The older page of [`read_roots_activity`] that ends `before` a cursor an
/// earlier page named, for a client across a backend connection: it joins
/// the pages before and after it as [`activity_page_from_file`] does, and
/// carries fewer messages and calls, so that it fits one backend response.
///
/// It never reads a record that starts before `after`: where the history a
/// view already shows below a gap ends (0 at the transcript's start). A page
/// that reaches `after` names no older cursor, so paging stops there and
/// joins the older rows exactly.
pub fn read_roots_activity_page(
    roots: &TranscriptRoots,
    provider: &str,
    conversation_id: &str,
    before: u64,
    after: u64,
) -> Result<ProviderConversationActivity, String> {
    provider_parsers(provider)?;
    let path = conversation_path(roots, provider, conversation_id)?;
    activity_window(
        &path,
        provider,
        conversation_id,
        Limits::BACKEND_PAGE,
        Some(before),
        after,
    )
}

fn conversation_path(
    roots: &TranscriptRoots,
    provider: &str,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    if !safe_id(conversation_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let path = match provider {
        "claude" => {
            find_claude_conversation(&roots.claude_projects, conversation_id).map(|(_, path)| path)
        }
        "codex" => codex_rollout(&roots.codex_sessions, conversation_id),
        "pi" => find_pi_conversation(&roots.pi_sessions, conversation_id),
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
    TranscriptFile::open(&path)
        .and_then(|mut file| {
            file.last_record(None, turn_id.as_bytes(), |_, value| {
                codex_opened_turn(value) == Some(turn_id)
            })
        })
        .map(|record| record.map(|(offset, _)| offset))
        .map_err(read_error)
}

/// Where the records of turn `turn_id` of a Codex conversation end, looking
/// back from `before`: the offset of the `task_started` event of the first
/// turn the rollout opens after it, or `before` when none opens between them.
/// Records the provider writes for the turn after it completes, such as a
/// command that finishes later, stay with it. A timeline that holds the
/// conversation through that turn and resumes it at `before` leaves out the
/// records between them, which [`read_roots_activity_page`] pages with this
/// as its floor. `None` when no turn the rollout opens before `before` is
/// `turn_id`.
pub fn codex_turn_end_cursor(
    codex_sessions: &Path,
    conversation_id: &str,
    turn_id: &str,
    before: u64,
) -> Result<Option<u64>, String> {
    if !safe_id(conversation_id) || !safe_id(turn_id) {
        return Err("provider conversation id is invalid".to_string());
    }
    let path = codex_rollout(codex_sessions, conversation_id)
        .ok_or_else(|| "provider conversation was not found".to_string())?;
    let read_error = |error| format!("read provider transcript: {error}");
    let mut file = TranscriptFile::open(&path).map_err(read_error)?;
    if before > file.len().map_err(read_error)? {
        return Err("provider transcript changed since the newer page was read".to_string());
    }
    // Reading back from `before`, the earliest turn found so far starts where
    // the turn before it ends.
    let mut next_turn_start = before;
    let turn = file
        .last_record(
            Some(before),
            b"task_started",
            |offset, value| match codex_opened_turn(value) {
                Some(opened) if opened == turn_id => true,
                Some(_) => {
                    next_turn_start = offset;
                    false
                }
                None => false,
            },
        )
        .map_err(read_error)?;
    Ok(turn.map(|_| next_turn_start))
}

/// The turn a Codex rollout record opens: the `turn_id` of its `task_started`
/// event, the first record the rollout writes for a turn.
fn codex_opened_turn(value: &Value) -> Option<&str> {
    if value.get("type").and_then(Value::as_str) != Some("event_msg")
        || value.pointer("/payload/type").and_then(Value::as_str) != Some("task_started")
    {
        return None;
    }
    value.pointer("/payload/turn_id").and_then(Value::as_str)
}

/// Where the records of message `provider_message_id` of a Claude
/// conversation end, looking back from `before`: the offset just past the last
/// record that carries it, as its `uuid` (a person's message) or as its
/// `message.id` (a reply, which the provider writes one record per content
/// block). A timeline that holds the conversation through that message and
/// resumes it at `before` leaves out the records between them, which
/// [`read_roots_activity_page`] pages with this as its floor. `None` when no
/// record before `before` carries the message.
pub fn claude_message_end_cursor(
    claude_projects: &Path,
    conversation_id: &str,
    provider_message_id: &str,
    before: u64,
) -> Result<Option<u64>, String> {
    let message_id = !provider_message_id.is_empty()
        && provider_message_id.len() <= 256
        && provider_message_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:+-_".contains(character));
    if !safe_id(conversation_id) || !message_id {
        return Err("provider conversation id is invalid".to_string());
    }
    let path = find_claude_conversation(claude_projects, conversation_id)
        .map(|(_, path)| path)
        .ok_or_else(|| "provider conversation was not found".to_string())?;
    let read_error = |error| format!("read provider transcript: {error}");
    let mut file = TranscriptFile::open(&path).map_err(read_error)?;
    if before > file.len().map_err(read_error)? {
        return Err("provider transcript changed since the newer page was read".to_string());
    }
    let carries_message = |value: &Value| {
        value.get("uuid").and_then(Value::as_str) == Some(provider_message_id)
            || value.pointer("/message/id").and_then(Value::as_str) == Some(provider_message_id)
    };
    file.last_record(Some(before), provider_message_id.as_bytes(), |_, value| {
        carries_message(value)
    })
    .map(|record| record.map(|(offset, length)| offset + length))
    .map_err(read_error)
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
    roots: &TranscriptRoots,
    provider: &str,
    conversation_id: &str,
) -> Result<ProviderSessionSettings, String> {
    let parse = match provider {
        "claude" => claude_turn_settings as fn(&Value) -> Option<ProviderSessionSettings>,
        "codex" => codex_turn_settings,
        _ => return Err("provider session settings are unsupported".to_string()),
    };
    let path = conversation_path(roots, provider, conversation_id)?;
    let content = bounded_suffix(&path, MAX_SESSION_SETTINGS_SOURCE_BYTES)
        .ok_or_else(|| "read provider transcript".to_string())?;
    Ok(content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|value| parse(&value))
        .unwrap_or_default())
}

/// The whole records in the last `max_bytes` of a transcript, plain or
/// compressed. A compressed one is decoded from its start to read them.
pub fn bounded_suffix(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = TranscriptFile::open(path).ok()?;
    if !file.metadata().is_file() {
        return None;
    }
    let (_, bytes) = file
        .tail(None, 0, max_bytes, u64::MAX)
        .ok()??
        .whole_records();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The whole records in the last `max_bytes` of a `len`-byte line-delimited
/// file, and the offset of the first of them. A provider may still be
/// appending, so the last record can be incomplete.
pub fn bounded_suffix_records(
    file: &mut fs::File,
    len: u64,
    max_bytes: u64,
) -> std::io::Result<(u64, Vec<u8>)> {
    // The tail holds the byte before its start, so a record exactly on the
    // boundary is retained; one the boundary cuts is left out.
    Ok(seek_tail(file, len, None, 0, max_bytes, u64::MAX)?
        .map_or((len, Vec::new()), Tail::whole_records))
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
