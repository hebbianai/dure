//! The tool calls an agent made between its messages, read from the same
//! provider transcript as the messages.
//!
//! This is an opt-in read for a view on the machine that owns the transcript
//! (the desktop's conversation view of a native terminal agent). The text-only
//! read stays the default, so the CLI, the desktop hub and `hmux
//! mobile-gateway` answer exactly what they answered before: tool inputs carry
//! commands and file paths, and nothing here decides that they may leave the
//! machine.
//!
//! Each call keeps its position between the messages (`after_entries`), the
//! provider's tool name, how it ended and a bounded copy of its input. Tool
//! output stays in the terminal.

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::ProviderConversationTranscript;

/// The longest serialized input one call carries whole. A larger input keeps
/// only its short, scannable fields (see [`bounded_input`]).
pub const MAX_TOOL_INPUT_BYTES: usize = 16 * 1024;
/// The longest value one scannable field keeps when the whole input is too
/// long.
const MAX_SUMMARY_FIELD_BYTES: usize = 1024;
/// The most tool calls one read returns; older calls are left out first.
pub const MAX_TOOL_CALLS: usize = 10_000;
/// The most bytes of tool calls one read returns, next to the messages' own
/// output budget.
pub const MAX_TOOL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOOL_ID_BYTES: usize = 256;

/// The fields a reader scans a tool row for. When a whole input is too long,
/// these survive (each only while short) so the row still names its file,
/// command or query.
const SUMMARY_FIELDS: [&str; 11] = [
    "file_path",
    "notebook_path",
    "path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
    "subagent_type",
    "server",
    "tool",
];

/// How a tool call ended, as the provider recorded it.
#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderToolState {
    /// No result was recorded (yet).
    Running,
    Completed,
    Failed,
    Canceled,
}

/// One tool call, in transcript order.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToolCall {
    /// How many of the transcript's `entries` come before this call.
    pub after_entries: usize,
    /// The provider's id for the call.
    pub call_id: String,
    /// The provider's tool name (`Bash`, `Read`…) or, for Codex, its item
    /// kind (`commandExecution`, `fileChange`…).
    pub name: String,
    pub state: ProviderToolState,
    /// The call's input, whole when short. Never its output.
    pub input: Value,
}

/// A transcript with the tool calls between its messages.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConversationActivity {
    #[serde(flatten)]
    pub transcript: ProviderConversationTranscript,
    /// Absent when there are none, so a text-only answer in this shape reads
    /// exactly as [`ProviderConversationTranscript`] does.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ProviderToolCall>,
}

/// What one transcript record says about tool calls.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolEvent {
    /// A call was made.
    Call {
        call_id: String,
        name: String,
        state: ProviderToolState,
        input: Value,
    },
    /// An earlier call ended.
    Result {
        call_id: String,
        state: ProviderToolState,
    },
}

pub type ToolEventParser = fn(&Value) -> Vec<ToolEvent>;

fn tool_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= MAX_TOOL_ID_BYTES)
        .map(str::to_owned)
}

/// The input as recorded when it is short; otherwise only its short scannable
/// fields, marked `truncated`, so a long file write or patch cannot crowd the
/// conversation out of its budget.
#[must_use]
pub fn bounded_input(input: &Value) -> Value {
    if serde_json::to_vec(input).is_ok_and(|encoded| encoded.len() <= MAX_TOOL_INPUT_BYTES) {
        return input.clone();
    }
    let mut summary = Map::new();
    if let Some(fields) = input.as_object() {
        for field in SUMMARY_FIELDS {
            let Some(value) = fields.get(field) else {
                continue;
            };
            let short = match value {
                Value::String(text) => text.len() <= MAX_SUMMARY_FIELD_BYTES,
                Value::Array(parts) => {
                    parts.iter().all(Value::is_string)
                        && parts
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::len)
                            .sum::<usize>()
                            <= MAX_SUMMARY_FIELD_BYTES
                }
                _ => false,
            };
            if short {
                summary.insert(field.to_string(), value.clone());
            }
        }
    }
    summary.insert("truncated".to_string(), Value::Bool(true));
    Value::Object(summary)
}

/// Claude Code writes each `tool_use` block in an assistant record and its
/// `tool_result` in the next user record. A subagent's calls (sidechain
/// records) are its own, not the conversation's.
#[must_use]
pub fn claude_tool_events(value: &Value) -> Vec<ToolEvent> {
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return Vec::new();
    }
    let kind = value.get("type").and_then(Value::as_str);
    if !matches!(kind, Some("assistant" | "user")) {
        return Vec::new();
    }
    let Some(parts) = value.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    parts
        .iter()
        .filter_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("tool_use") if kind == Some("assistant") => {
                let name = part
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty() && name.len() <= MAX_TOOL_ID_BYTES)?;
                Some(ToolEvent::Call {
                    call_id: tool_id(part.get("id"))?,
                    name: name.to_owned(),
                    state: ProviderToolState::Running,
                    input: part.get("input").map_or(Value::Null, bounded_input),
                })
            }
            Some("tool_result") if kind == Some("user") => Some(ToolEvent::Result {
                call_id: tool_id(part.get("tool_use_id"))?,
                state: if part.get("is_error").and_then(Value::as_bool) == Some(true) {
                    ProviderToolState::Failed
                } else {
                    ProviderToolState::Completed
                },
            }),
            _ => None,
        })
        .collect()
}

/// The status vocabulary of Codex items, as its structured timeline maps it.
/// A completed-item record without a status has ended.
fn codex_state(item: &Value) -> ProviderToolState {
    match item.get("status").and_then(Value::as_str) {
        Some("failed") => ProviderToolState::Failed,
        Some("declined" | "interrupted" | "canceled" | "cancelled") => ProviderToolState::Canceled,
        Some("inProgress" | "in_progress" | "running") => ProviderToolState::Running,
        _ => ProviderToolState::Completed,
    }
}

/// The script of a `[shell, -lc, script]` command, else the words joined.
fn codex_command(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(command) => Some(command.clone()),
        Value::Array(words) => {
            let words = words
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            match words.as_slice() {
                [_, flag, script] if matches!(*flag, "-lc" | "-c") => Some((*script).to_owned()),
                _ => Some(words.join(" ")),
            }
        }
        _ => None,
    }
}

/// One patch's files in the shape the chat's file rows read (`path`, `diff`).
/// When the diffs together are too long, the files are kept without them.
fn codex_changes(changes: Option<&Value>) -> Value {
    let Some(changes) = changes.and_then(Value::as_object) else {
        return json!({});
    };
    let files = |with_diff: bool| -> Vec<Value> {
        changes
            .iter()
            .map(|(path, change)| {
                let mut file = json!({ "path": path, "kind": change.get("type") });
                if with_diff {
                    if let Some(diff) = change.get("unified_diff") {
                        file["diff"] = diff.clone();
                    }
                }
                file
            })
            .collect()
    };
    let whole = json!({ "changes": files(true) });
    if serde_json::to_vec(&whole).is_ok_and(|encoded| encoded.len() <= MAX_TOOL_INPUT_BYTES) {
        return whole;
    }
    bounded_input(&json!({ "changes": files(false), "truncated": true }))
}

/// Codex records every finished tool item as an `item_completed` event. Its
/// item kinds are named the way the structured Codex timeline names them, so
/// both views present a command or a patch the same way.
#[must_use]
pub fn codex_tool_events(value: &Value) -> Vec<ToolEvent> {
    let payload = value.get("payload").unwrap_or(value);
    if payload.get("type").and_then(Value::as_str) != Some("item_completed") {
        return Vec::new();
    }
    let Some(item) = payload.get("item") else {
        return Vec::new();
    };
    let (name, input) = match item.get("type").and_then(Value::as_str) {
        Some("CommandExecution") => (
            "commandExecution",
            json!({ "command": codex_command(item.get("command")) }),
        ),
        Some("FileChange") => ("fileChange", codex_changes(item.get("changes"))),
        Some("McpToolCall") => (
            "mcpToolCall",
            json!({
                "server": item.get("server"),
                "tool": item.get("tool"),
                "arguments": item.get("arguments"),
            }),
        ),
        Some("CollabAgentToolCall") => ("collabAgentToolCall", json!({ "tool": item.get("tool") })),
        Some("ImageView") => ("imageView", json!({ "path": item.get("path") })),
        Some("Extension") if item.get("kind").and_then(Value::as_str) == Some("web.search") => {
            ("webSearch", json!({ "query": item.get("query") }))
        }
        _ => return Vec::new(),
    };
    let Some(call_id) = tool_id(item.get("id")) else {
        return Vec::new();
    };
    vec![ToolEvent::Call {
        call_id,
        name: name.to_owned(),
        state: codex_state(item),
        input: bounded_input(&input),
    }]
}

/// The tool parser of a provider whose transcript this crate reads.
#[must_use]
pub fn tool_events_for(provider: &str) -> Option<ToolEventParser> {
    match provider {
        "claude" => Some(claude_tool_events),
        "codex" => Some(codex_tool_events),
        _ => None,
    }
}

/// The calls of one read, oldest first, within the read's own budget.
///
/// Positions are counted over every message the read saw; [`Self::finish`]
/// rebases them on the messages the read kept, and leaves out calls that
/// came before the oldest kept message.
#[derive(Default)]
pub(crate) struct ToolWindow {
    calls: std::collections::VecDeque<ProviderToolCall>,
    /// Calls left out at the front.
    evicted: usize,
    /// Every call seen, by id, as its index counted from the first call.
    seen: std::collections::HashMap<String, usize>,
    bytes: usize,
}

fn call_bytes(call: &ProviderToolCall) -> usize {
    call.call_id.len()
        + call.name.len()
        + serde_json::to_vec(&call.input).map_or(0, |encoded| encoded.len())
}

impl ToolWindow {
    /// Apply one record's events. Returns false when an older call had to be
    /// left out to stay within the budget.
    pub(crate) fn apply(&mut self, events: Vec<ToolEvent>, entries_seen: usize) -> bool {
        let mut complete = true;
        for event in events {
            match event {
                ToolEvent::Call {
                    call_id,
                    name,
                    state,
                    input,
                } => {
                    if let Some(index) = self.live_index(&call_id) {
                        // The same call recorded again: the newer record wins.
                        let call = &mut self.calls[index];
                        self.bytes -= call_bytes(call);
                        call.state = state;
                        call.input = input;
                        self.bytes += call_bytes(call);
                        continue;
                    }
                    let call = ProviderToolCall {
                        after_entries: entries_seen,
                        call_id,
                        name,
                        state,
                        input,
                    };
                    self.bytes += call_bytes(&call);
                    self.seen
                        .insert(call.call_id.clone(), self.evicted + self.calls.len());
                    self.calls.push_back(call);
                    while self.bytes > MAX_TOOL_OUTPUT_BYTES || self.calls.len() > MAX_TOOL_CALLS {
                        let Some(oldest) = self.calls.pop_front() else {
                            break;
                        };
                        self.bytes -= call_bytes(&oldest);
                        self.seen.remove(&oldest.call_id);
                        self.evicted += 1;
                        complete = false;
                    }
                }
                ToolEvent::Result { call_id, state } => {
                    if let Some(index) = self.live_index(&call_id) {
                        self.calls[index].state = state;
                    }
                }
            }
        }
        complete
    }

    fn live_index(&self, call_id: &str) -> Option<usize> {
        self.seen
            .get(call_id)
            .and_then(|index| index.checked_sub(self.evicted))
            .filter(|index| *index < self.calls.len())
    }

    /// The kept calls, positioned among the kept messages: `entries_dropped`
    /// messages were left out at the front.
    pub(crate) fn finish(self, entries_dropped: usize) -> Vec<ProviderToolCall> {
        self.calls
            .into_iter()
            .filter(|call| call.after_entries >= entries_dropped)
            .map(|mut call| {
                call.after_entries -= entries_dropped;
                call
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;
