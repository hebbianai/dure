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
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
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

struct Call {
    name: String,
    label: Option<String>,
    started: u64,
}

struct Tracked {
    item: BackgroundWorkItem,
    aliases: Vec<String>,
    deadline: Option<u64>,
}

pub(crate) fn read_claude_background_work_at(
    conversation_file: &Path,
    since_unix_ms: Option<u64>,
    now_unix_ms: u64,
    limits: &Limits,
) -> BackgroundWorkList {
    let Some(text) = bounded_suffix(conversation_file, limits.main_bytes) else {
        return BackgroundWorkList::default();
    };
    let side = conversation_file.with_extension("");
    let mut calls: HashMap<String, Call> = HashMap::new();
    let mut tracked: Vec<Tracked> = Vec::new();
    let mut ended: HashSet<String> = HashSet::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("assistant") => collect_calls(&record, &mut calls, &mut ended),
            Some("user") => {
                resolve_results(&record, &mut calls, &mut tracked);
                if let Some(text) = record.pointer("/message/content").and_then(Value::as_str) {
                    collect_notifications(text, &mut ended);
                }
            }
            Some("queue-operation") => {
                if let Some(text) = record.get("content").and_then(Value::as_str) {
                    collect_notifications(text, &mut ended);
                }
            }
            _ => {}
        }
    }
    // A subagent the turn is still waiting on has no result yet.
    for (tool_use_id, call) in calls {
        if call.name == "Agent" {
            tracked.push(Tracked {
                item: item(
                    tool_use_id.clone(),
                    BackgroundWorkKind::Subagent,
                    call.label,
                    call.started,
                ),
                aliases: vec![tool_use_id],
                deadline: None,
            });
        }
    }

    let mut running: Vec<BackgroundWorkItem> = tracked
        .into_iter()
        .filter(|entry| !entry.aliases.iter().any(|alias| ended.contains(alias)))
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

fn collect_notifications(text: &str, ended: &mut HashSet<String>) {
    for notification in text.split("<task-notification>").skip(1) {
        let body = notification
            .split("</task-notification>")
            .next()
            .unwrap_or("");
        for tag in ["task-id", "tool-use-id"] {
            if let Some(value) = tag_value(body, tag) {
                ended.insert(value.to_string());
            }
        }
    }
}

fn tag_value<'a>(body: &'a str, tag: &str) -> Option<&'a str> {
    let start = body.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = body[start..].find(&format!("</{tag}>"))? + start;
    let value = body[start..end].trim();
    (!value.is_empty()).then_some(value)
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
        .take(limits.workflow_agent_files)
        .collect();
    files.sort();
    let sums: Vec<u64> = files
        .iter()
        .filter_map(|file| output_tokens(file, limits.agent_bytes))
        .collect();
    (!sums.is_empty()).then(|| sums.iter().sum())
}

/// Output tokens of an agent transcript, counting each message once although
/// the provider records one line per content block.
fn output_tokens(transcript: &Path, max_bytes: u64) -> Option<u64> {
    let text = bounded_suffix(transcript, max_bytes)?;
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for record in text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    {
        if record.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(tokens) = record
            .pointer("/message/usage/output_tokens")
            .and_then(Value::as_u64)
        else {
            continue;
        };
        let id = record
            .pointer("/message/id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if id.is_empty() || seen.insert(id.to_string()) {
            total = total.saturating_add(tokens);
        }
    }
    Some(total)
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
