//! The agent's running background work, read from the provider's own records.
//!
//! Claude Code records background shells, monitors, subagents and workflows in
//! its session files: the call and its result in `<conversation>.jsonl`, and
//! per-agent transcripts, metadata and workflow journals beside it in
//! `<conversation>/`. These are internal provider formats, so an item is
//! listed only when every field it needs is present, and an item is never
//! inferred from file activity. Whether the provider process is alive at all
//! is the Host's fact, not this reader's: callers gate the list with it.
use crate::transcript::bounded_suffix;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_BACKGROUND_WORK_ITEMS: usize = 64;
pub const MAX_BACKGROUND_WORK_LABEL_CHARS: usize = 120;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundWorkKind {
    Subagent,
    Workflow,
    Shell,
    Monitor,
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundWorkSteps {
    pub done: u32,
    pub total: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundWorkItem {
    /// The provider's task, agent or workflow run id.
    pub id: String,
    pub kind: BackgroundWorkKind,
    /// The model-written description of the call; never its command or input.
    pub label: Option<String>,
    pub started_unix_ms: u64,
    pub steps: Option<BackgroundWorkSteps>,
    pub tokens: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundWorkCounts {
    pub subagents: u32,
    pub workflows: u32,
    pub shells: u32,
    pub monitors: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundWorkList {
    /// Newest first, at most [`MAX_BACKGROUND_WORK_ITEMS`].
    pub items: Vec<BackgroundWorkItem>,
    /// Every running item, including those cut from `items`.
    pub counts: BackgroundWorkCounts,
    pub truncated: bool,
}

pub(crate) struct Limits {
    pub main_bytes: u64,
    pub agent_bytes: u64,
    pub workflow_agent_files: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            main_bytes: 16 * 1024 * 1024,
            agent_bytes: 4 * 1024 * 1024,
            workflow_agent_files: 256,
        }
    }
}

/// `conversation_file` is `<project>/<conversation>.jsonl`. Items started
/// before `since_unix_ms` (the current provider process's start) are dropped.
pub fn read_claude_background_work(
    conversation_file: &Path,
    since_unix_ms: Option<u64>,
) -> BackgroundWorkList {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    read_claude_background_work_at(conversation_file, since_unix_ms, now, &Limits::default())
}

#[derive(Clone)]
struct Call {
    name: String,
    label: Option<String>,
    started: u64,
}

#[derive(Clone)]
struct Tracked {
    item: BackgroundWorkItem,
    aliases: Vec<String>,
    deadline: Option<u64>,
}

/// What has been read of one conversation file so far. The file only grows,
/// so each read parses what was appended since the last one.
#[derive(Default)]
struct Scan {
    offset: u64,
    calls: HashMap<String, Call>,
    tracked: Vec<Tracked>,
    ended: HashSet<String>,
}

const MAX_SCANS: usize = 256;
const MAX_ENDED_IDS: usize = 16_384;

fn scans() -> &'static Mutex<HashMap<PathBuf, Scan>> {
    static SCANS: OnceLock<Mutex<HashMap<PathBuf, Scan>>> = OnceLock::new();
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Scan {
    /// Parse the complete lines appended since the last read. A file that
    /// shrank was replaced; one that grew by more than `main_bytes` since is
    /// read afresh from its last `main_bytes`.
    fn advance(&mut self, conversation_file: &Path, main_bytes: u64) -> Option<()> {
        let mut file = fs::File::open(conversation_file).ok()?;
        let length = file.metadata().ok().filter(fs::Metadata::is_file)?.len();
        if length < self.offset || length - self.offset > main_bytes {
            *self = Scan::default();
            self.offset = length.saturating_sub(main_bytes);
            if self.offset > 0 {
                // Start one byte earlier so a record exactly on the boundary
                // is kept; the partial record before it is skipped below.
                self.offset -= 1;
                file.seek(SeekFrom::Start(self.offset)).ok()?;
                let mut skipped = Vec::new();
                std::io::BufRead::read_until(
                    &mut std::io::BufReader::new(&mut file),
                    b'\n',
                    &mut skipped,
                )
                .ok()?;
                self.offset += skipped.len() as u64;
            }
        }
        file.seek(SeekFrom::Start(self.offset)).ok()?;
        let mut bytes = Vec::new();
        file.take(length - self.offset)
            .read_to_end(&mut bytes)
            .ok()?;
        // A record still being written waits for its newline.
        let complete = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        for line in String::from_utf8_lossy(&bytes[..complete]).lines() {
            self.line(line);
        }
        self.offset += complete as u64;
        let ended = &self.ended;
        self.tracked
            .retain(|entry| !entry.aliases.iter().any(|alias| ended.contains(alias)));
        if self.ended.len() > MAX_ENDED_IDS {
            self.ended.clear();
        }
        Some(())
    }

    fn line(&mut self, line: &str) {
        // Most lines are messages and tool output; parse only those that can
        // start or end background work.
        if !(line.contains("\"tool_use\"")
            || line.contains("\"tool_result\"")
            || line.contains("task-notification"))
        {
            return;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("assistant") => collect_calls(&record, &mut self.calls, &mut self.ended),
            Some("user") => {
                resolve_results(&record, &mut self.calls, &mut self.tracked);
                if let Some(text) = record.pointer("/message/content").and_then(Value::as_str) {
                    collect_notifications(text, &mut self.ended);
                }
            }
            Some("queue-operation") => {
                if let Some(text) = record.get("content").and_then(Value::as_str) {
                    collect_notifications(text, &mut self.ended);
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn read_claude_background_work_at(
    conversation_file: &Path,
    since_unix_ms: Option<u64>,
    now_unix_ms: u64,
    limits: &Limits,
) -> BackgroundWorkList {
    let (mut tracked, ended) = {
        let Ok(mut scans) = scans().lock() else {
            return BackgroundWorkList::default();
        };
        if scans.len() >= MAX_SCANS && !scans.contains_key(conversation_file) {
            scans.clear();
        }
        let scan = scans.entry(conversation_file.to_path_buf()).or_default();
        if scan.advance(conversation_file, limits.main_bytes).is_none() {
            scans.remove(conversation_file);
            return BackgroundWorkList::default();
        }
        let mut tracked = scan.tracked.clone();
        // A subagent the turn is still waiting on has no result yet.
        for (tool_use_id, call) in &scan.calls {
            if call.name == "Agent" {
                tracked.push(Tracked {
                    item: item(
                        tool_use_id.clone(),
                        BackgroundWorkKind::Subagent,
                        call.label.clone(),
                        call.started,
                    ),
                    aliases: vec![tool_use_id.clone()],
                    deadline: None,
                });
            }
        }
        (tracked, scan.ended.clone())
    };
    let side = conversation_file.with_extension("");
    tracked.retain(|entry| !entry.aliases.iter().any(|alias| ended.contains(alias)));

    let mut running: Vec<BackgroundWorkItem> = tracked
        .into_iter()
        .filter(|entry| since_unix_ms.is_none_or(|since| entry.item.started_unix_ms >= since))
        .filter(|entry| entry.deadline.is_none_or(|deadline| now_unix_ms < deadline))
        .filter_map(|entry| enrich(entry.item, &side, limits))
        .collect();
    let mut counts = BackgroundWorkCounts::default();
    for entry in &running {
        match entry.kind {
            BackgroundWorkKind::Subagent => counts.subagents += 1,
            BackgroundWorkKind::Workflow => counts.workflows += 1,
            BackgroundWorkKind::Shell => counts.shells += 1,
            BackgroundWorkKind::Monitor => counts.monitors += 1,
        }
    }
    running.sort_by(|a, b| {
        b.started_unix_ms
            .cmp(&a.started_unix_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    let truncated = running.len() > MAX_BACKGROUND_WORK_ITEMS;
    running.truncate(MAX_BACKGROUND_WORK_ITEMS);
    BackgroundWorkList {
        items: running,
        counts,
        truncated,
    }
}

fn item(
    id: String,
    kind: BackgroundWorkKind,
    label: Option<String>,
    started: u64,
) -> BackgroundWorkItem {
    BackgroundWorkItem {
        id,
        kind,
        label,
        started_unix_ms: started,
        steps: None,
        tokens: None,
    }
}

fn collect_calls(record: &Value, calls: &mut HashMap<String, Call>, ended: &mut HashSet<String>) {
    let Some(blocks) = record.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    let started = record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_unix_ms);
    for block in blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
    {
        let (Some(id), Some(name)) = (
            block.get("id").and_then(Value::as_str),
            block.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        let input = block.get("input").unwrap_or(&Value::Null);
        match name {
            "TaskStop" => {
                if let Some(task) = input.get("task_id").and_then(Value::as_str) {
                    ended.insert(task.to_string());
                }
            }
            "Bash" if !is_true(input.get("run_in_background")) => {}
            "Bash" | "Monitor" | "Agent" | "Workflow" => {
                let Some(started) = started else { continue };
                calls.insert(
                    id.to_string(),
                    Call {
                        name: name.to_string(),
                        label: input
                            .get("description")
                            .and_then(Value::as_str)
                            .and_then(label),
                        started,
                    },
                );
            }
            _ => {}
        }
    }
}

fn resolve_results(record: &Value, calls: &mut HashMap<String, Call>, tracked: &mut Vec<Tracked>) {
    let Some(blocks) = record.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    let result = record.get("toolUseResult").unwrap_or(&Value::Null);
    let text = |key: &str| result.get(key).and_then(Value::as_str).map(str::to_string);
    for block in blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
    {
        let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(call) = calls.remove(tool_use_id) else {
            continue;
        };
        let launched = text("status").as_deref() == Some("async_launched");
        let entry = match call.name.as_str() {
            "Bash" => text("backgroundTaskId").map(|task| {
                let aliases = vec![task.clone(), tool_use_id.to_string()];
                (
                    item(task, BackgroundWorkKind::Shell, call.label, call.started),
                    aliases,
                    None,
                )
            }),
            "Monitor" => text("taskId").map(|task| {
                let deadline = (!is_true(result.get("persistent")))
                    .then(|| result.get("timeoutMs").and_then(Value::as_u64))
                    .flatten()
                    .map(|timeout| call.started + timeout);
                let aliases = vec![task.clone(), tool_use_id.to_string()];
                (
                    item(task, BackgroundWorkKind::Monitor, call.label, call.started),
                    aliases,
                    deadline,
                )
            }),
            "Agent" if launched => text("agentId").map(|agent| {
                let aliases = vec![agent.clone(), tool_use_id.to_string()];
                (
                    item(
                        agent,
                        BackgroundWorkKind::Subagent,
                        call.label,
                        call.started,
                    ),
                    aliases,
                    None,
                )
            }),
            "Workflow" if launched => text("runId").map(|run| {
                let label = text("workflowName").as_deref().and_then(label);
                let mut aliases = vec![run.clone(), tool_use_id.to_string()];
                aliases.extend(text("taskId"));
                (
                    item(run, BackgroundWorkKind::Workflow, label, call.started),
                    aliases,
                    None,
                )
            }),
            _ => None,
        };
        if let Some((item, aliases, deadline)) = entry {
            tracked.push(Tracked {
                item,
                aliases,
                deadline,
            });
        }
    }
}

/// A notification ends the tasks it names only when it carries a status: a
/// running monitor reports each event as a notification without one. One
/// notification can name several tasks (the record Claude Code writes for
/// tasks a previous process left unfinished).
fn collect_notifications(text: &str, ended: &mut HashSet<String>) {
    for notification in text.split("<task-notification>").skip(1) {
        let body = notification
            .split("</task-notification>")
            .next()
            .unwrap_or("");
        if tag_values(body, "status").is_empty() {
            continue;
        }
        for tag in ["task-id", "tool-use-id"] {
            ended.extend(tag_values(body, tag).into_iter().map(str::to_string));
        }
    }
}

fn tag_values<'a>(body: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    body.split(open.as_str())
        .skip(1)
        .filter_map(|rest| rest.split(close.as_str()).next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect()
}

/// Adds what the side files know, and drops an item they record as finished.
fn enrich(
    mut item: BackgroundWorkItem,
    side: &Path,
    limits: &Limits,
) -> Option<BackgroundWorkItem> {
    match item.kind {
        BackgroundWorkKind::Subagent => {
            let base = side.join("subagents").join(format!("agent-{}", item.id));
            let meta = fs::read_to_string(base.with_extension("meta.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            if meta
                .as_ref()
                .is_some_and(|meta| is_true(meta.get("finished")))
            {
                return None;
            }
            item.tokens = output_tokens(&base.with_extension("jsonl"), limits.agent_bytes);
        }
        BackgroundWorkKind::Workflow => {
            if side
                .join("workflows")
                .join(format!("{}.json", item.id))
                .exists()
            {
                return None;
            }
            let run = side.join("subagents").join("workflows").join(&item.id);
            item.steps = journal_steps(&run.join("journal.jsonl"), limits.agent_bytes);
            item.tokens = workflow_tokens(&run, limits);
        }
        BackgroundWorkKind::Shell | BackgroundWorkKind::Monitor => {}
    }
    Some(item)
}

fn journal_steps(journal: &Path, max_bytes: u64) -> Option<BackgroundWorkSteps> {
    let text = bounded_suffix(journal, max_bytes)?;
    let (mut done, mut total) = (0u32, 0u32);
    for record in text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        match record.get("type").and_then(Value::as_str) {
            Some("started") => total += 1,
            Some("result" | "failed") => done += 1,
            _ => {}
        }
    }
    (total > 0).then_some(BackgroundWorkSteps {
        done: done.min(total),
        total,
    })
}

/// The workflow's agents' output tokens, or `None` while any of them is still
/// being counted or when there are more agent files than one read covers: a
/// partial sum would read as exact.
fn workflow_tokens(run: &Path, limits: &Limits) -> Option<u64> {
    let mut files: Vec<PathBuf> = fs::read_dir(run)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
        })
        .take(limits.workflow_agent_files + 1)
        .collect();
    if files.is_empty() || files.len() > limits.workflow_agent_files {
        return None;
    }
    files.sort();
    let mut total = 0u64;
    let mut complete = true;
    for file in &files {
        match output_tokens(file, limits.agent_bytes) {
            Some(tokens) => total = total.saturating_add(tokens),
            None => complete = false,
        }
    }
    complete.then_some(total)
}

/// How far one agent transcript has been counted. Transcripts only grow, so
/// each read continues where the last stopped instead of re-reading the file.
#[derive(Default)]
struct Tally {
    offset: u64,
    total: u64,
    /// Message ids just counted: the provider writes one line per content
    /// block of a message, each with the message's usage.
    recent: VecDeque<String>,
}

const MAX_TALLIES: usize = 4096;
const RECENT_MESSAGE_IDS: usize = 16;

fn tallies() -> &'static Mutex<HashMap<PathBuf, Tally>> {
    static TALLIES: OnceLock<Mutex<HashMap<PathBuf, Tally>>> = OnceLock::new();
    TALLIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Output tokens of an agent transcript, each message counted once. Reads at
/// most `max_bytes` more of the file per call; `None` until the whole file
/// has been counted, so a partial sum is never shown.
fn output_tokens(transcript: &Path, max_bytes: u64) -> Option<u64> {
    let mut file = fs::File::open(transcript).ok()?;
    let length = file.metadata().ok().filter(fs::Metadata::is_file)?.len();
    let mut tallies = tallies().lock().ok()?;
    if tallies.len() >= MAX_TALLIES && !tallies.contains_key(transcript) {
        tallies.clear();
    }
    let tally = tallies.entry(transcript.to_path_buf()).or_default();
    if length < tally.offset {
        // Replaced or truncated: count it again.
        *tally = Tally::default();
    }
    file.seek(SeekFrom::Start(tally.offset)).ok()?;
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes).ok()?;
    // Complete lines are counted and remembered; a last line without its
    // newline yet is counted for this answer only, once it parses.
    let complete = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    for line in String::from_utf8_lossy(&bytes[..complete]).lines() {
        if let Some((id, tokens)) = message_output_tokens(line) {
            if tally.count(id) {
                tally.total = tally.total.saturating_add(tokens);
            }
        }
    }
    tally.offset += complete as u64;
    if tally.offset + (bytes.len() - complete) as u64 != length {
        // More of the file is left than one read takes: not caught up yet.
        return None;
    }
    let tail = String::from_utf8_lossy(&bytes[complete..]);
    let pending = message_output_tokens(tail.trim())
        .filter(|(id, _)| id.is_empty() || !tally.recent.iter().any(|seen| seen == id))
        .map_or(0, |(_, tokens)| tokens);
    Some(tally.total.saturating_add(pending))
}

impl Tally {
    /// Whether a message's usage is new, remembering its id if it is.
    fn count(&mut self, id: String) -> bool {
        if id.is_empty() {
            return true;
        }
        if self.recent.iter().any(|seen| *seen == id) {
            return false;
        }
        if self.recent.len() == RECENT_MESSAGE_IDS {
            self.recent.pop_front();
        }
        self.recent.push_back(id);
        true
    }
}

/// An assistant record's message id and output tokens.
fn message_output_tokens(line: &str) -> Option<(String, u64)> {
    if !line.contains("output_tokens") {
        return None;
    }
    let record = serde_json::from_str::<Value>(line).ok()?;
    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let tokens = record
        .pointer("/message/usage/output_tokens")
        .and_then(Value::as_u64)?;
    let id = record
        .pointer("/message/id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some((id, tokens))
}

fn is_true(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => text == "true",
        _ => false,
    }
}

/// A one-line description: control characters become spaces, runs of
/// whitespace collapse, and the result is cut on a character boundary.
fn label(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let joined = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = joined
        .chars()
        .take(MAX_BACKGROUND_WORK_LABEL_CHARS)
        .collect();
    (!cut.is_empty()).then_some(cut)
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z` in UTC, as the provider writes it.
pub(crate) fn parse_unix_ms(text: &str) -> Option<u64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let mut clock_parts = clock.split(':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next()?.parse().ok()?;
    let second: i64 = clock_parts.next()?.parse().ok()?;
    if date_parts.next().is_some()
        || clock_parts.next().is_some()
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let millis: i64 = if fraction.is_empty() {
        0
    } else {
        let digits: String = fraction.chars().take(3).collect();
        if !fraction.chars().all(|character| character.is_ascii_digit()) {
            return None;
        }
        format!("{digits:0<3}").parse().ok()?
    };
    // Days from the civil date (proleptic Gregorian).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = ((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) + millis;
    u64::try_from(ms).ok()
}

#[cfg(test)]
#[path = "background_work_tests.rs"]
mod tests;
