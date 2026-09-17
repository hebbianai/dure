use super::{
    Candidate, MAX_METADATA_BYTES, MAX_PROVIDER_DIRECTORIES, MAX_PROVIDER_RECORDS,
    MAX_SESSION_BYTES, MAX_TRANSCRIPT_DISCOVERY_ENTRIES, ProviderConversationDetails,
    ProviderConversationInputAuthority, bounded_prefix, mtime, record, safe_id, text_content,
};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

struct SessionHeader {
    id: String,
    cwd: String,
}

fn session_header(line: &str) -> Option<SessionHeader> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let id = value.get("id")?.as_str()?;
    let cwd = value.get("cwd")?.as_str()?.trim();
    if value.get("type")?.as_str()? != "session" || !safe_id(id) || !Path::new(cwd).is_absolute() {
        return None;
    }
    Some(SessionHeader {
        id: id.into(),
        cwd: cwd.into(),
    })
}

fn session_files(root: &Path, limit: usize) -> impl Iterator<Item = PathBuf> {
    let mut directories = vec![root.to_path_buf()];
    if let Ok(entries) = fs::read_dir(root) {
        directories.extend(
            entries
                .flatten()
                .take(MAX_PROVIDER_DIRECTORIES)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path()),
        );
    }
    directories
        .into_iter()
        .filter_map(|directory| fs::read_dir(directory).ok())
        .flatten()
        .flatten()
        .take(limit)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
        })
        .map(|entry| entry.path())
}

fn session_record(path: &Path) -> Option<Candidate> {
    let content = bounded_prefix(path, MAX_SESSION_BYTES)?;
    let mut lines = content.lines().filter(|line| !line.trim().is_empty());
    let header = session_header(lines.next()?)?;
    let mut name = None;
    let mut first_message = None;
    for value in lines.filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
        if value.get("type").and_then(Value::as_str) == Some("session_info") {
            name = value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if first_message.is_none()
            && value.get("type").and_then(Value::as_str) == Some("message")
            && value.pointer("/message/role").and_then(Value::as_str) == Some("user")
        {
            first_message = value.pointer("/message/content").and_then(text_content);
        }
    }
    record(
        "pi",
        &header.id,
        &header.cwd,
        name.or(first_message),
        "Pi",
        mtime(path),
        Some(header.id.clone()),
    )
}

pub(super) fn collect(root: &Path, output: &mut Vec<Candidate>) {
    output
        .extend(session_files(root, MAX_PROVIDER_RECORDS).filter_map(|path| session_record(&path)));
}

pub(super) fn details(root: &Path, conversation_id: &str) -> ProviderConversationDetails {
    // Exact lookup has its own discovery budget: old conversations must not
    // disappear behind the smaller Recent Work preview limit. Read only headers.
    let exists = session_files(root, MAX_TRANSCRIPT_DISCOVERY_ENTRIES).any(|path| {
        let Ok(file) = fs::File::open(path) else {
            return false;
        };
        let line = BufReader::new(file)
            .take(MAX_METADATA_BYTES)
            .lines()
            .map_while(Result::ok)
            .find(|line| !line.trim().is_empty());
        line.and_then(|line| session_header(&line))
            .is_some_and(|header| header.id == conversation_id)
    });
    ProviderConversationDetails {
        // Pi's parentSession records fork/clone ancestry, not an input owner.
        input_authority: if exists {
            ProviderConversationInputAuthority::Independent
        } else {
            ProviderConversationInputAuthority::Unverified
        },
        subagents: Vec::new(),
        total_count: 0,
    }
}
