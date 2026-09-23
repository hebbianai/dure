//! Claude's explicit forward transcript links distinguish an in-process
//! continuation from an unrelated child conversation using the same hook env.

use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const MAX_LINK_TAIL_BYTES: u64 = 64 * 1024;
const MAX_LINKS: usize = 8;

fn file_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn continued_in(tail: &str, previous: &str) -> Option<String> {
    tail.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|record| record["type"] == "continued-in" && record["sessionId"] == previous)
        .and_then(|record| {
            record["continuedInSessionId"]
                .as_str()
                .filter(|id| file_id(id))
                .map(str::to_owned)
        })
}

fn follows_links(previous: &str, next: &str, mut read: impl FnMut(&str) -> Option<String>) -> bool {
    if !file_id(previous) || !file_id(next) || previous == next {
        return false;
    }
    let mut current = previous.to_owned();
    let mut visited = HashSet::new();
    for _ in 0..MAX_LINKS {
        if !visited.insert(current.clone()) {
            return false;
        }
        let Some(successor) = read(&current).and_then(|tail| continued_in(&tail, &current)) else {
            return false;
        };
        if successor == next {
            return true;
        }
        current = successor;
    }
    false
}

/// Only a forward link written in the current conversation's own transcript
/// may authorize its successor. Shared messages, directory proximity and the
/// new transcript's claims about ancestry are not continuation evidence.
pub fn claude_transcript_continues(transcript: &Path, previous: &str, next: &str) -> bool {
    if !file_id(next)
        || !transcript.is_absolute()
        || transcript.file_name().and_then(|name| name.to_str()) != Some(&format!("{next}.jsonl"))
        || !fs::symlink_metadata(transcript).is_ok_and(|metadata| metadata.is_file())
    {
        return false;
    }
    let Some(directory) = transcript.parent() else {
        return false;
    };
    follows_links(previous, next, |id| {
        let path = directory.join(format!("{id}.jsonl"));
        if !fs::symlink_metadata(&path).ok()?.is_file() {
            return None;
        }
        let mut file = fs::File::open(path).ok()?;
        let start = file
            .metadata()
            .ok()?
            .len()
            .saturating_sub(MAX_LINK_TAIL_BYTES);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_LINK_TAIL_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
        let bytes = if start == 0 {
            bytes.as_slice()
        } else {
            &bytes[bytes.iter().position(|byte| *byte == b'\n')? + 1..]
        };
        Some(String::from_utf8_lossy(bytes).into_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edge(from: &str, to: &str) -> String {
        serde_json::json!({"type":"continued-in","sessionId":from,"continuedInSessionId":to})
            .to_string()
    }

    #[test]
    fn follows_only_explicit_forward_links_and_the_latest_destination() {
        let read = |id: &str| match id {
            "first" => Some(format!(
                "{}\n{}\n",
                edge("first", "obsolete"),
                edge("first", "second")
            )),
            "second" => Some(edge("second", "third")),
            _ => None,
        };
        assert!(follows_links("first", "second", read));
        assert!(follows_links("first", "third", read));
        assert!(!follows_links("first", "obsolete", read));
        assert!(!follows_links("first", "child", read));
        assert!(!follows_links("third", "first", read));
        assert!(!follows_links("../first", "second", read));
        assert!(!follows_links("first", "first", read));
    }

    #[test]
    fn wrong_identity_missing_links_cycles_and_embedded_message_text_are_not_evidence() {
        for raw in [
            "".to_owned(),
            "invalid".to_owned(),
            edge("other", "next"),
            serde_json::json!({"type":"user","message":{"content":edge("first", "next")}})
                .to_string(),
            edge("first", "../next"),
        ] {
            assert!(!follows_links("first", "next", |_| Some(raw.clone())));
        }
        assert!(!follows_links("first", "next", |id| Some(edge(
            id, "first"
        ))));
        assert!(!follows_links("0", "9", |id| Some(edge(
            id,
            &(id.parse::<u32>().unwrap() + 1).to_string()
        ))));
    }
}
