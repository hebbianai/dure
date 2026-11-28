//! Pi's own session files: a `session` header line, then one entry per line.
//!
//! Entries form a tree by `id` and `parentId`. The conversation is the branch
//! from its newest entry back to the root; the file also holds the branches
//! the person left with `/tree`, which Pi and its Chat timeline
//! (`pi_timeline_bridge`) never show. A reader shows that branch too, and
//! reads its messages the way that timeline's projection does.

use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, Read},
    path::{Path, PathBuf},
};

use crate::{
    ConversationTurnRole, MAX_TRANSCRIPT_DISCOVERY_ENTRIES, MAX_TRANSCRIPT_SOURCE_BYTES,
    TranscriptFile, bounded_prefix, mtime, safe_id, text_content,
};

/// The longest session header a lookup reads, as the Pi Chat runtime does.
const MAX_HEADER_BYTES: u64 = 64 * 1024;

/// The message a Pi `message` entry records.
pub(crate) fn pi_message(value: &Value) -> Option<&Value> {
    (value.get("type").and_then(Value::as_str) == Some("message"))
        .then(|| value.get("message"))
        .flatten()
}

/// A Pi message as a conversation turn: the person's prompt, a command they
/// ran in Pi itself (`!`, or `!!` to keep it out of the model's context) as
/// that command line, or the reply's text. Tool results and what a command
/// printed are not turns.
#[must_use]
pub fn pi_turn(value: &Value) -> Option<(ConversationTurnRole, String)> {
    let message = pi_message(value)?;
    match message.get("role").and_then(Value::as_str)? {
        "user" => message
            .get("content")
            .and_then(text_content)
            .map(|text| (ConversationTurnRole::User, text)),
        "assistant" => message
            .get("content")
            .and_then(text_content)
            .map(|text| (ConversationTurnRole::Agent, text)),
        "bashExecution" => {
            let command = message.get("command").and_then(Value::as_str)?.trim();
            let prefix = if message.get("excludeFromContext") == Some(&Value::Bool(true)) {
                "!!"
            } else {
                "!"
            };
            (!command.is_empty())
                .then(|| (ConversationTurnRole::User, format!("{prefix} {command}")))
        }
        _ => None,
    }
}

/// Whether `value` is a reply that ends its turn, whose text is the turn's
/// final response.
pub(crate) fn pi_final_reply(value: &Value) -> bool {
    pi_message(value).is_some_and(|message| {
        message.get("role").and_then(Value::as_str) == Some("assistant")
            && message.get("stopReason").and_then(Value::as_str) == Some("stop")
    })
}

/// The session file of Pi conversation `conversation_id` under Pi's sessions
/// directory: `<sessions>/<project>/<created>_<id>.jsonl` by default, or
/// right in a sessions directory Pi was given, and whose header names the
/// conversation. The most recently written match, when there are several.
#[must_use]
pub fn find_pi_conversation(sessions: &Path, conversation_id: &str) -> Option<PathBuf> {
    if !safe_id(conversation_id) {
        return None;
    }
    let suffix = format!("_{conversation_id}.jsonl");
    let mut inspected = 0;
    let mut newest: Option<(u64, PathBuf)> = None;
    let mut directories = vec![sessions.to_path_buf()];
    let mut index = 0;
    while let Some(directory) = directories.get(index).cloned() {
        index += 1;
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if inspected >= MAX_TRANSCRIPT_DISCOVERY_ENTRIES {
                break;
            }
            inspected += 1;
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                // A project's directory, one level below the sessions root.
                if index == 1 {
                    directories.push(path);
                }
                continue;
            }
            if !kind.is_file()
                || !entry.file_name().to_string_lossy().ends_with(&suffix)
                || !names_conversation(&path, conversation_id)
            {
                continue;
            }
            let modified = mtime(&path);
            if newest
                .as_ref()
                .is_none_or(|(current, _)| modified > *current)
            {
                newest = Some((modified, path));
            }
        }
    }
    newest.map(|(_, path)| path)
}

fn names_conversation(path: &Path, conversation_id: &str) -> bool {
    bounded_prefix(path, MAX_HEADER_BYTES).is_some_and(|prefix| {
        prefix
            .lines()
            .next()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .is_some_and(|header| {
                header.get("type").and_then(Value::as_str) == Some("session")
                    && header.get("id").and_then(Value::as_str) == Some(conversation_id)
            })
    })
}

/// Where one entry sits in the tree. The header (`type: session`) is no entry.
#[derive(Deserialize)]
struct Link {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
}

impl Link {
    fn entry(raw: &[u8]) -> Option<Self> {
        serde_json::from_slice::<Self>(raw)
            .ok()
            .filter(|link| link.id.is_some() && link.kind.as_deref() != Some("session"))
    }
}

/// The entries of one read range that are on the conversation's branch.
pub(crate) struct Branch {
    /// The offsets of the branch's records in the range.
    pub(crate) records: HashSet<u64>,
    /// The offset of the branch's oldest record in the range: where the page
    /// before this one continues the branch from.
    pub(crate) oldest: Option<u64>,
    /// Whether the branch continues before the range: its oldest record in
    /// the range has a parent the range does not hold. Otherwise the branch
    /// starts the conversation within the range.
    pub(crate) continues: bool,
    /// Whether the branch repeats an entry, which a tree never does.
    pub(crate) broken: bool,
}

/// The branch within the records of `region`, which starts at file offset
/// `region_start`. A page that ends `before` an earlier page's cursor follows
/// the branch from the parent of the entry at that cursor, the earlier page's
/// oldest; the newest page follows it from the range's newest entry, which is
/// the leaf Pi appended last.
pub(crate) fn branch(
    file: &mut TranscriptFile,
    region: &[u8],
    region_start: u64,
    before: Option<u64>,
) -> Result<Branch, String> {
    let mut links = HashMap::new();
    let mut newest = None;
    let mut offset = region_start;
    for raw in region.split_inclusive(|byte| *byte == b'\n') {
        let record_offset = offset;
        offset += raw.len() as u64;
        if let Some(link) = Link::entry(raw) {
            let id = link.id.clone().unwrap_or_default();
            newest = Some(id.clone());
            links.entry(id).or_insert((record_offset, link.parent_id));
        }
    }
    let mut next = match before {
        Some(before) => {
            entry_at(file, before)
                .ok_or_else(|| {
                    "provider transcript changed since the newer page was read".to_string()
                })?
                .parent_id
        }
        None => newest,
    };
    let mut branch = Branch {
        records: HashSet::new(),
        oldest: None,
        continues: false,
        broken: false,
    };
    while let Some(id) = next {
        let Some((record_offset, parent)) = links.get(&id) else {
            branch.continues = true;
            break;
        };
        if !branch.records.insert(*record_offset) {
            branch.broken = true;
            break;
        }
        branch.oldest = Some(*record_offset);
        next = parent.clone();
    }
    Ok(branch)
}

/// The entry whose record starts at `offset`.
fn entry_at(file: &mut TranscriptFile, offset: u64) -> Option<Link> {
    let mut raw = Vec::new();
    file.records_from(offset)
        .ok()?
        .take(MAX_TRANSCRIPT_SOURCE_BYTES)
        .read_until(b'\n', &mut raw)
        .ok()?;
    Link::entry(&raw)
}

#[cfg(test)]
#[path = "pi_tests.rs"]
mod tests;
